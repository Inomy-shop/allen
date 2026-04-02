import type { NodeDef } from './types.js';

/**
 * Extract structured outputs from agent response text.
 * Layer 1: JSON code block extraction
 * Layer 2: Regex extraction (per-field custom patterns)
 * Layer 3: Key-value pattern matching
 * Layer 4: LLM fallback via Haiku
 */
export async function extractOutputs(
  response: string,
  nodeDef: NodeDef,
): Promise<Record<string, unknown>> {
  const outputs = nodeDef.outputs ?? [];
  if (outputs.length === 0) return {};

  // Layer 1: JSON code block
  const jsonMatch = response.match(/```json\s*\n?([\s\S]*?)\n?\s*```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (typeof parsed === 'object' && parsed !== null) {
        const result: Record<string, unknown> = {};
        for (const key of outputs) {
          if (key in parsed) result[key] = parsed[key];
        }
        if (Object.keys(result).length > 0) return result;
      }
    } catch {
      // fall through to layer 2
    }
  }

  // Layer 2: Custom regex per field
  if (nodeDef.output_extraction) {
    const result: Record<string, unknown> = {};
    for (const key of outputs) {
      const pattern = nodeDef.output_extraction[key];
      if (pattern) {
        const match = response.match(new RegExp(pattern, 's'));
        if (match) {
          result[key] = match[1]?.trim() ?? match[0]?.trim();
        }
      }
    }
    if (Object.keys(result).length > 0) return result;
  }

  // Layer 3: Key-value fallback (e.g., "test_passed: true")
  const kvResult: Record<string, unknown> = {};
  for (const key of outputs) {
    const kvPattern = new RegExp(`${key}\\s*[:=]\\s*(.+)`, 'i');
    const match = response.match(kvPattern);
    if (match) {
      kvResult[key] = parseValue(match[1].trim());
    }
  }
  if (Object.keys(kvResult).length > 0) return kvResult;

  // Layer 4: LLM fallback via Haiku
  try {
    const llmResult = await extractViaLLM(response, outputs);
    if (llmResult && Object.keys(llmResult).length > 0) return llmResult;
  } catch {
    // LLM fallback failed — return empty
  }

  return {};
}

/**
 * Synchronous version for backward compatibility (skips LLM fallback).
 */
export function extractOutputsSync(
  response: string,
  nodeDef: NodeDef,
): Record<string, unknown> {
  const outputs = nodeDef.outputs ?? [];
  if (outputs.length === 0) return {};

  // Layer 1: JSON code block
  const jsonMatch = response.match(/```json\s*\n?([\s\S]*?)\n?\s*```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (typeof parsed === 'object' && parsed !== null) {
        const result: Record<string, unknown> = {};
        for (const key of outputs) {
          if (key in parsed) result[key] = parsed[key];
        }
        if (Object.keys(result).length > 0) return result;
      }
    } catch { /* fall through */ }
  }

  // Layer 2: Custom regex
  if (nodeDef.output_extraction) {
    const result: Record<string, unknown> = {};
    for (const key of outputs) {
      const pattern = nodeDef.output_extraction[key];
      if (pattern) {
        const match = response.match(new RegExp(pattern, 's'));
        if (match) result[key] = match[1]?.trim() ?? match[0]?.trim();
      }
    }
    if (Object.keys(result).length > 0) return result;
  }

  // Layer 3: Key-value
  const result: Record<string, unknown> = {};
  for (const key of outputs) {
    const kvPattern = new RegExp(`${key}\\s*[:=]\\s*(.+)`, 'i');
    const match = response.match(kvPattern);
    if (match) result[key] = parseValue(match[1].trim());
  }
  return result;
}

/**
 * Layer 4: Use Haiku via Claude Code SDK to extract fields from unstructured text.
 */
async function extractViaLLM(
  text: string,
  fields: string[],
): Promise<Record<string, unknown> | null> {
  const { query } = await import('@anthropic-ai/claude-code');

  const prompt = `Extract these fields from the text below and return ONLY valid JSON with these keys: ${fields.join(', ')}

Text:
${text.slice(0, 4000)}

Return JSON only, no explanation.`;

  let rawResponse = '';

  const conversation = query({
    prompt,
    options: {
      model: 'haiku',
      maxTurns: 1,
      permissionMode: 'plan',
    },
  });

  for await (const message of conversation) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') {
          rawResponse += block.text;
        }
      }
    }
  }

  // Parse the LLM response
  const jsonMatch = rawResponse.match(/```json\s*\n?([\s\S]*?)\n?\s*```/) ??
                    rawResponse.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    const jsonStr = jsonMatch[1] ?? jsonMatch[0];
    try {
      const parsed = JSON.parse(jsonStr);
      if (typeof parsed === 'object' && parsed !== null) {
        const result: Record<string, unknown> = {};
        for (const key of fields) {
          if (key in parsed) result[key] = parsed[key];
        }
        return result;
      }
    } catch { /* ignore */ }
  }

  return null;
}

function parseValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  const num = Number(raw);
  if (!isNaN(num) && raw !== '') return num;
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if (raw.startsWith('[')) {
    try { return JSON.parse(raw); } catch { /* ignore */ }
  }
  return raw;
}

/**
 * Build the output instruction appended to agent prompts.
 */
export function buildOutputInstruction(outputs: string[], format: string | undefined): string {
  if (!outputs.length) return '';
  if (format === 'freeform') return '';

  const fields = outputs.map(o => `"${o}": ...`).join(', ');
  return `\n\nWhen done, return results as JSON:\n\`\`\`json\n{ ${fields} }\n\`\`\``;
}
