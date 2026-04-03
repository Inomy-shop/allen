import type { NodeDef } from './types.js';

/**
 * Extract structured outputs from agent response text.
 * Layer 1: JSON code block extraction
 * Layer 2: Regex extraction (per-field custom patterns)
 * Layer 3: Key-value pattern matching
 * Layer 4: LLM fallback via Haiku
 */
/** Gate fields that should always be preserved if present in parsed JSON */
const GATE_FIELDS = ['__action', '__reason', '__clarify_action', '__clarify_fields', '__learnings'];

function extractFromParsed(parsed: Record<string, unknown>, outputs: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of outputs) {
    if (key in parsed) result[key] = parsed[key];
  }
  // Always preserve gate fields
  for (const key of GATE_FIELDS) {
    if (key in parsed) result[key] = parsed[key];
  }
  return result;
}

export type ExtractionLogger = (message: string) => void;

export async function extractOutputs(
  response: string,
  nodeDef: NodeDef,
  log?: ExtractionLogger,
): Promise<Record<string, unknown>> {
  const outputs = nodeDef.outputs ?? [];
  if (outputs.length === 0) return {};

  log?.(`Starting extraction for outputs: [${outputs.join(', ')}] from response (${response.length} chars)`);

  // Layer 0: Try parsing entire response as JSON directly
  const trimmed = response.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) {
        const result = extractFromParsed(parsed, outputs);
        if (outputs.some(k => k in result) || GATE_FIELDS.some(k => k in result)) {
          const keys = Object.keys(result);
          const hasGate = GATE_FIELDS.some(k => k in result);
          log?.(`Layer 0 (raw JSON): extracted [${keys.join(', ')}]${hasGate ? ' (includes gate fields)' : ''}`);
          return result;
        }
      }
      log?.('Layer 0 (raw JSON): parsed but no matching keys found');
    } catch {
      log?.('Layer 0 (raw JSON): parse failed — not valid JSON');
    }
  } else {
    log?.(`Layer 0 (raw JSON): skipped — response does not start with { or [`);
  }

  // Layer 1: JSON code block
  const jsonMatch = response.match(/```json\s*\n?([\s\S]*?)\n?\s*```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (typeof parsed === 'object' && parsed !== null) {
        const result = extractFromParsed(parsed, outputs);
        if (outputs.some(k => k in result) || GATE_FIELDS.some(k => k in result)) {
          log?.(`Layer 1 (code block): extracted [${Object.keys(result).join(', ')}]`);
          return result;
        }
      }
      log?.('Layer 1 (code block): parsed but no matching keys');
    } catch {
      log?.('Layer 1 (code block): parse failed');
    }
  } else {
    log?.('Layer 1 (code block): no ```json block found');
  }

  // Layer 1b: Find JSON object anywhere in response (not in code block)
  const jsonInText = response.match(/\{[\s\S]*\}/);
  if (jsonInText) {
    try {
      const parsed = JSON.parse(jsonInText[0]);
      if (typeof parsed === 'object' && parsed !== null) {
        const result = extractFromParsed(parsed, outputs);
        if (outputs.some(k => k in result) || GATE_FIELDS.some(k => k in result)) {
          log?.(`Layer 1b (JSON in text): extracted [${Object.keys(result).join(', ')}]`);
          return result;
        }
      }
      log?.('Layer 1b (JSON in text): parsed but no matching keys');
    } catch {
      log?.('Layer 1b (JSON in text): parse failed');
    }
  } else {
    log?.('Layer 1b (JSON in text): no JSON object found in text');
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
    if (Object.keys(result).length > 0) {
      log?.(`Layer 2 (custom regex): extracted [${Object.keys(result).join(', ')}]`);
      return result;
    }
    log?.('Layer 2 (custom regex): no matches');
  } else {
    log?.('Layer 2 (custom regex): no extraction patterns defined');
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
  if (Object.keys(kvResult).length > 0) {
    log?.(`Layer 3 (key-value): extracted [${Object.keys(kvResult).join(', ')}]`);
    return kvResult;
  }
  log?.('Layer 3 (key-value): no matches');

  // Layer 4: LLM fallback via Haiku — extract outputs + gate fields
  log?.('Layer 4 (LLM fallback): calling Haiku to extract from unstructured text...');
  try {
    const allFields = [...outputs, ...GATE_FIELDS];
    const llmResult = await extractViaLLM(response, allFields);
    if (llmResult && Object.keys(llmResult).length > 0) {
      log?.(`Layer 4 (LLM fallback): extracted [${Object.keys(llmResult).join(', ')}]`);
      return llmResult;
    }
    log?.('Layer 4 (LLM fallback): no fields extracted');
  } catch (err: unknown) {
    log?.(`Layer 4 (LLM fallback): failed — ${err instanceof Error ? err.message : String(err)}`);
  }

  // Layer 5: Auto-detect clarification — if response is a question and no outputs extracted,
  // treat it as an implicit clarify request
  if (outputs.length > 0 && response.trim().length > 10) {
    const hasQuestion = /\?\s*$/.test(response.trim()) ||
      /could you|can you|please (provide|share|tell|specify)|what is|which|where|who|when|how/i.test(response);
    if (hasQuestion) {
      log?.(`Layer 5 (auto-detect): response contains question patterns — treating as clarify`);
      return {
        __action: 'clarify',
        __reason: response.trim().slice(0, 300),
        __clarify_action: 'retry',
      };
    }
    log?.('Layer 5 (auto-detect): no question patterns found');
  }

  log?.('ALL LAYERS FAILED — returning empty output');
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

  // Layer 0: Try parsing entire response as JSON
  const trimmed = response.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) {
        const result = extractFromParsed(parsed, outputs);
        if (outputs.some(k => k in result) || GATE_FIELDS.some(k => k in result)) return result;
      }
    } catch { /* fall through */ }
  }

  // Layer 1: JSON code block
  const jsonMatch = response.match(/```json\s*\n?([\s\S]*?)\n?\s*```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (typeof parsed === 'object' && parsed !== null) {
        const result = extractFromParsed(parsed, outputs);
        if (outputs.some(k => k in result) || GATE_FIELDS.some(k => k in result)) return result;
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

If the text is asking a question or requesting clarification instead of providing data, return:
{ "__action": "clarify", "__reason": "the question being asked", "__clarify_action": "retry" }

If the text contains the requested data, extract it into the fields above. Set values to null if not found.

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
 * Only adds JSON output format — auto-gate instructions come from buildNodeContext.
 */
export function buildOutputInstruction(outputs: string[], format: string | undefined): string {
  if (!outputs.length) return '';
  if (format === 'freeform') return '';

  const fields = outputs.map(o => `"${o}": ...`).join(', ');
  return `\n\nWhen done, return results as JSON:\n\`\`\`json\n{ ${fields} }\n\`\`\``;
}

/**
 * Build context-aware auto-gate instructions based on the node's position
 * in the workflow graph. First/middle/last nodes get different instructions
 * so middle nodes don't incorrectly stop the entire workflow.
 */
export function buildNodeContext(
  nodeName: string,
  workflow: { nodes: Record<string, unknown>; edges: Array<Record<string, unknown>> },
): string {
  const edges = workflow.edges ?? [];
  const allNodes = workflow.nodes ?? {};

  // Find downstream edges from this node
  const downstreamEdges = edges.filter((e) => {
    const froms = Array.isArray(e.from) ? e.from : [e.from];
    return froms.includes(nodeName);
  });

  // Downstream node names (excluding END)
  const downstreamNodes = downstreamEdges
    .flatMap((e) => Array.isArray(e.to) ? e.to as string[] : [e.to as string])
    .filter((n: string) => n !== 'END');

  // Is this the first node (connected from START)?
  const isFirstNode = edges.some((e) => {
    const froms = Array.isArray(e.from) ? e.from : [e.from];
    const tos = Array.isArray(e.to) ? e.to : [e.to];
    return (froms as string[]).includes('START') && (tos as string[]).includes(nodeName);
  });

  // Is the last node (connects to END)?
  const isLastBeforeEnd = downstreamEdges.some((e) => {
    const tos = Array.isArray(e.to) ? e.to : [e.to];
    return (tos as string[]).includes('END');
  });

  const hasDownstream = downstreamNodes.length > 0;

  // Has conditional outgoing edges
  const hasConditionalOut = downstreamEdges.some(
    (e) => e.condition || e.max_retries != null,
  );

  // Nodes with conditional outgoing edges: no auto-gate instruction
  if (hasConditionalOut) {
    return '';
  }

  // Build downstream descriptions so agent knows what next steps need
  const downstreamDesc = downstreamNodes.map(name => {
    const def = allNodes[name] as Record<string, unknown> | undefined;
    if (!def) return name;
    const role = def.role ? ` (${def.role})` : '';
    const outputs = Array.isArray(def.outputs) && def.outputs.length > 0
      ? ` — needs: ${(def.outputs as string[]).join(', ')}`
      : '';
    // Extract first line of prompt for context
    const prompt = typeof def.prompt === 'string' ? def.prompt.split('\n')[0].trim().slice(0, 80) : '';
    return `${name}${role}${outputs}${prompt ? ` — "${prompt}"` : ''}`;
  }).join('\n  ');

  // Build context-aware instruction
  let context = '\n\nWORKFLOW CONTEXT:\n';

  // Position label
  if (!hasDownstream && isFirstNode) {
    context += 'You are the ONLY step in this workflow.\n';
  } else if (isFirstNode) {
    context += `You are the FIRST step. The next steps depend on your output:\n  ${downstreamDesc}\n`;
  } else if (isLastBeforeEnd) {
    context += 'You are the FINAL step in this workflow.\n';
  } else {
    context += `You are a MIDDLE step. The next steps depend on your output:\n  ${downstreamDesc}\n`;
  }

  // Universal rules — apply to ALL nodes regardless of position
  context += '\nACTIONS YOU CAN TAKE:\n';
  context += 'STOP ("__action": "stop"): Only if continuing the ENTIRE workflow is pointless — the task is fundamentally impossible, input is completely unintelligible, or a critical error makes all downstream steps meaningless. When in doubt, DO NOT STOP — produce your best output.\n';
  context += 'CLARIFY with retry ("__action": "clarify", "__clarify_action": "retry"): If you CANNOT produce output because essential information is missing or your input is broken/empty. Explain what you need AND why — mention what the next step needs from you so the user understands the impact.\n';
  context += 'CLARIFY with continue ("__action": "clarify", "__clarify_action": "continue"): If you CAN produce output but a human decision would significantly improve quality. Your output will be PRESERVED and the human\'s answer will be added for the next step.\n';
  context += '\nWhen using CLARIFY, you can optionally include "__clarify_fields" — an array of form fields the user should fill out. Each field has: name (string), type ("string"|"text"|"select"|"boolean"|"number"), label (string), required (boolean), and optionally options (string[] for select type). Example:\n';
  context += '"__clarify_fields": [{"name":"recipient","type":"string","label":"Who is the recipient?","required":true},{"name":"purpose","type":"select","label":"Purpose","options":["request","follow-up","thank you"],"required":true}]\n';
  context += 'If you don\'t include __clarify_fields, a simple text input will be shown.\n';

  if (isLastBeforeEnd || (!hasDownstream && isFirstNode)) {
    context += 'SKIP ("__action": "skip"): If your input is completely empty and there is genuinely nothing to produce. Only use this as the final step.\n';
  }

  context += '\nDEFAULT: Just produce your output normally. Do NOT include __action unless one of the above situations genuinely applies. Most of the time you should just do your job and move on.\n';

  return context;
}

/**
 * Extract auto-gate fields (__action, __reason, __clarify_action) from agent response,
 * even if they weren't in the declared outputs list.
 */
export function extractAutoGateFields(
  response: string,
  outputs: Record<string, unknown>,
): { action: string; reason?: string; clarifyAction?: string; clarifyFields?: any[] } {
  // Check if already in extracted outputs
  if (outputs.__action && typeof outputs.__action === 'string') {
    return {
      action: outputs.__action,
      reason: outputs.__reason as string | undefined,
      clarifyAction: (outputs.__clarify_action as string) ?? 'retry',
      clarifyFields: Array.isArray(outputs.__clarify_fields) ? outputs.__clarify_fields as any[] : undefined,
    };
  }

  // Try to find in JSON block
  const jsonMatch = response.match(/```json\s*\n?([\s\S]*?)\n?\s*```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (parsed.__action) {
        return {
          action: parsed.__action,
          reason: parsed.__reason,
          clarifyAction: parsed.__clarify_action ?? 'retry',
          clarifyFields: Array.isArray(parsed.__clarify_fields) ? parsed.__clarify_fields : undefined,
        };
      }
    } catch { /* fall through */ }
  }

  // Try key-value pattern
  const actionMatch = response.match(/__action\s*[:=]\s*["']?(stop|skip|clarify|continue)["']?/i);
  if (actionMatch) {
    const reasonMatch = response.match(/__reason\s*[:=]\s*["']?(.+?)["']?\s*$/m);
    const clarifyMatch = response.match(/__clarify_action\s*[:=]\s*["']?(retry|continue)["']?/i);
    return {
      action: actionMatch[1].toLowerCase(),
      reason: reasonMatch?.[1],
      clarifyAction: clarifyMatch?.[1]?.toLowerCase() ?? 'retry',
    };
  }

  return { action: 'continue' };
}
