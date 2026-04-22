import type { NodeDef, OutputsSpec } from './types.js';
import { normalizeModelAlias } from './model-alias.js';

/**
 * Extract structured outputs from agent response text.
 * Layer 1: JSON code block extraction
 * Layer 2: Regex extraction (per-field custom patterns)
 * Layer 3: Key-value pattern matching
 * Layer 4: LLM fallback via Haiku
 */
/** Gate fields that should always be preserved if present in parsed JSON */
const GATE_FIELDS = ['__action', '__reason', '__clarify_action', '__clarify_fields', '__learnings'];

/** Flat list of output keys from the OutputsSpec object. */
export function outputKeys(outputs: OutputsSpec | undefined): string[] {
  if (!outputs) return [];
  return Object.keys(outputs);
}

/** Return the key → description map. */
export function outputDescriptions(outputs: OutputsSpec | undefined): Record<string, string> {
  return outputs ? { ...outputs } : {};
}

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
  /** Skip Layer 4 (Haiku LLM fallback). Used when caller will run a better
   * retry strategy (e.g. resuming the original agent session) before falling
   * back to Haiku. */
  skipLLMFallback?: boolean,
): Promise<Record<string, unknown>> {
  const outputs = outputKeys(nodeDef.outputs);
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

  // Layer 4: LLM fallback via Haiku — extract outputs + gate fields.
  // Skipped when caller wants to run its own retry strategy first.
  if (!skipLLMFallback) {
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
  } else {
    log?.('Layer 4 (LLM fallback): skipped — caller will handle retry');
  }

  // Layer 5: Auto-detect clarification — ONLY if no outputs were extracted at all
  // and the response looks like a direct question to the user (not a report with question words)
  if (outputs.length === 0 && response.trim().length > 10 && response.trim().length < 500) {
    // Only match if the LAST sentence is a direct question (ends with ?)
    // Don't match question words in the middle of a report/analysis
    const lastSentence = response.trim().split(/[.!]\s+/).pop()?.trim() ?? '';
    const isDirectQuestion = /\?\s*$/.test(lastSentence) &&
      /^(could you|can you|please|what|which|where|do you|would you|should I|shall I)/i.test(lastSentence);
    if (isDirectQuestion) {
      log?.(`Layer 5 (auto-detect): last sentence is a direct question — treating as clarify`);
      return {
        __action: 'clarify',
        __reason: lastSentence.slice(0, 300),
        __clarify_action: 'retry',
      };
    }
    log?.('Layer 5 (auto-detect): no direct question found');
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
  const outputs = outputKeys(nodeDef.outputs);
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
      model: normalizeModelAlias('haiku'),
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
 *
 * Accepts either the legacy array form or the rich object form. Rich-form
 * descriptions are inlined as comments in the JSON schema block so the agent
 * knows exactly what each key should contain.
 */
export function buildOutputInstruction(outputs: OutputsSpec | undefined, format: string | undefined): string {
  const keys = outputKeys(outputs);
  if (!keys.length) return '';
  if (format === 'freeform') return '';

  const descriptions = outputDescriptions(outputs);

  const fields = keys
    .map((k) => `  // ${descriptions[k] ?? ''}\n  "${k}": ...`)
    .join(',\n');

  const fieldGuide = keys.map((k) => `- ${k}: ${descriptions[k] ?? ''}`).join('\n');

  return `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IMPORTANT — RESPONSE FORMAT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You MUST end your response with a JSON code block containing EXACTLY these keys:

\`\`\`json
{
${fields}
}
\`\`\`

Each key must contain:
${fieldGuide}

- Include the JSON block at the very end of your response.
- All listed keys are required. Use null if you don't have a value.
- Do not omit any keys.
- Do not rename any keys.
- Values may be nested objects or arrays — use whatever shape matches the description above.
- The downstream workflow will fail if this JSON block is missing or malformed.`;
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

  // Has conditional outgoing edges. Historically we skipped emitting the
  // auto-gate instruction for these nodes on the theory that they already
  // had a routing mechanism. That was wrong: auto-gate is about SHORT-
  // CIRCUITING the whole workflow (STOP / SKIP), which is orthogonal to
  // picking a downstream branch via edge conditions. A node with conditional
  // edges still has legitimate reasons to say "none of my branches matter,
  // the premise is broken" — e.g. an investigator discovering the repo
  // doesn't exist, a feature-planner discovering the feature is already
  // built, a daily-poster discovering today's posts are already done.
  // We still surface the conditional edges in the downstream description
  // so the agent knows what its continue-path looks like.
  const hasConditionalOut = downstreamEdges.some(
    (e) => e.condition || e.max_retries != null,
  );

  // Build downstream descriptions so agent knows what next steps need
  const downstreamDesc = downstreamNodes.map(name => {
    const def = allNodes[name] as Record<string, unknown> | undefined;
    if (!def) return name;
    const role = def.role ? ` (${def.role})` : '';
    const keys = outputKeys(def.outputs as OutputsSpec | undefined);
    const outputs = keys.length > 0 ? ` — needs: ${keys.join(', ')}` : '';
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
  if (hasConditionalOut) {
    context += 'Your downstream edges are conditional — your JSON output fields drive routing between them. Use the STOP action below ONLY to short-circuit the entire workflow, never as a substitute for picking a branch.\n';
  }

  // Universal rules — apply to ALL nodes regardless of position or routing.
  context += '\nACTIONS YOU CAN TAKE:\n';
  context += 'STOP ("__action": "stop", "__reason": "<short explanation>"): Short-circuit the entire workflow because there is no point continuing. Use this ONLY when the situation cannot be fixed by asking the user a question:\n';
  context += '  • The task is already done — e.g. the feature being requested already exists, the bug being reported is already fixed, the daily posts are already posted, the tests you were asked to write already exist and pass.\n';
  context += '  • The premise is structurally broken — e.g. the bug report describes behavior that is actually the documented spec, the feature violates a constraint that cannot be relaxed.\n';
  context += '  • An environmental precondition failed — e.g. the target repo path does not exist, a required service is unreachable, credentials are missing.\n';
  context += '  • A critical error at this step makes all downstream work pointless AND no amount of user clarification would help.\n';
  context += 'Always include "__reason" so the operator can see why you stopped. Do NOT use STOP for problems a clarifying question could solve — prefer CLARIFY in that case.\n';
  context += 'CLARIFY with retry ("__action": "clarify", "__clarify_action": "retry"): Use when you CANNOT produce valid output and asking the user would unblock you. This covers:\n';
  context += '  • Input is unintelligible, gibberish, empty, or ambiguous (e.g. the user typed random characters, or asked something you can\'t parse).\n';
  context += '  • Essential information is missing that only the user can supply — a file path, an enum choice, a target audience, a constraint.\n';
  context += '  • You need a decision between equally-valid options you can\'t pick on your own.\n';
  context += '  Explain what you need AND why — mention what the next step needs from you so the user understands the impact. Prefer CLARIFY over STOP whenever a human answer would fix the problem.\n';
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
