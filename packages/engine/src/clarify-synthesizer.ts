/**
 * Clarify synthesizer — Haiku fallback for when an agent triggers a
 * clarify gate without supplying useful context.
 *
 * Many agents emit `{ "__action": "clarify" }` with no `__reason` and no
 * `__clarify_fields`. The user ends up staring at "Agent decided to
 * clarify" with a single text box, which is useless. This module calls
 * Claude Haiku (cheap, fast) to synthesize a targeted question + fields
 * from whatever context IS available:
 *   - the node's raw agent response (often contains the real confusion)
 *   - the input state variables the node was run against
 *   - the node's prompt template (hints the agent's intent)
 *
 * Uses the same Claude Code SDK path as node-executor, so it piggybacks
 * on the user's existing Claude auth — no separate ANTHROPIC_API_KEY
 * wiring. Returns `null` on any failure so the caller can gracefully
 * fall back to the agent-provided values (or the engine default).
 */

import { normalizeModelAlias } from './model-alias.js';

export interface ClarifySynthesisInput {
  /** Node that emitted the clarify. */
  nodeName: string;
  /** The prompt the agent was given (rendered from the node's template). */
  nodePrompt?: string;
  /** The agent's raw response text — may contain the real question hidden in prose. */
  rawResponse?: string;
  /** Top-level state variables available to the node at execution time. */
  inputVars: Record<string, unknown>;
  /** Agent-provided reason, if any — used as seed context. */
  agentReason?: string;
  /** Placeholder names referenced by `{{name}}` in the node's prompt
   *  template. The synthesizer should prefer these names when the clarify
   *  is about an existing input the user can overwrite. */
  templatePlaceholders?: string[];
  /** Fields declared on upstream human nodes that fed into this node's
   *  state. Each entry identifies a variable the user originally filled,
   *  so the synthesizer can reuse the right name and type when asking
   *  the user to correct a bad input. */
  upstreamFields?: Array<{ nodeName: string; name: string; type?: string; label?: string }>;
  /** Keys this node is declared to produce. The synthesizer must NOT pick
   *  any of these as a clarify field name — doing so would pre-fill the
   *  output the agent is supposed to produce. */
  nodeOutputs?: string[];
  /** Optional model override (default: haiku). */
  model?: string;
  /** Optional abort signal — stops the Haiku call if the execution is cancelled. */
  abortSignal?: AbortSignal;
  /** Optional logger hook — the engine pipes these into its execution log
   *  so operators see the synthesis step in the normal log stream. Called
   *  with structured data the engine can format or store. */
  log?: (entry: SynthLogEntry) => void;
}

export type SynthLogEntry =
  | { phase: 'start'; model: string; reasonProvided: boolean; fieldsProvided: number; contextChars: number }
  | { phase: 'haiku_response'; durationMs: number; textLen: number; preview: string }
  | { phase: 'parsed'; reason: string; fieldCount: number; fieldTypes: string[] }
  | { phase: 'skipped'; reason: string }
  | { phase: 'strict_rewrite'; detail: string; originalNames: string[]; finalNames: string[] }
  | { phase: 'failed'; reason: string; stage: 'sdk' | 'empty_response' | 'no_json' | 'parse' | 'validate'; detail?: string };

export interface ClarifyField {
  name: string;
  type: string;
  label?: string;
  required?: boolean;
  options?: string[];
  placeholder?: string;
}

export interface ClarifySynthesisOutput {
  reason: string;
  fields: ClarifyField[];
  /** True when this came from Haiku, false when returned as-is from input. */
  synthesized: boolean;
}

/**
 * Only call the synthesizer when the agent-supplied context is too thin
 * to render a meaningful dialog.
 */
export function needsSynthesis(
  agentReason: string | undefined,
  agentFields: unknown[] | undefined,
): boolean {
  const hasFields = Array.isArray(agentFields) && agentFields.length > 0;
  if (hasFields) return false;
  if (!agentReason) return true;
  const trimmed = agentReason.trim();
  if (trimmed.length < 12) return true;
  // The engine's own fallback looks like "Agent decided to clarify" — always
  // boilerplate, never actionable.
  if (/^agent decided to /i.test(trimmed)) return true;
  return false;
}

const SYNTH_SYSTEM_PROMPT = `You are generating clarification UI for a workflow engine that paused because an agent couldn't produce valid output.

Given:
- The agent's raw response (often a natural-language confusion or question hidden in prose)
- The input variables the agent had access to
- The node's prompt template (what the agent was asked to do)
- TEMPLATE PLACEHOLDERS — the variable names the node's prompt reads via {{name}}. These are the keys that will be re-templated into the prompt on retry.
- UPSTREAM FIELDS — fields the user filled on upstream human nodes. The current values of these keys flow into the template.
- NODE OUTPUTS — keys this node is supposed to PRODUCE. Never use these as clarify field names.

Decide which scenario applies, then produce the JSON.

SCENARIO A — "fix a bad input": the agent failed because a value already available to the node is wrong, empty, or nonsense (gibberish input, missing file path, malformed JSON the user typed). The fix is to OVERWRITE that value.
  → For each broken input, emit a field whose name matches the placeholder / upstream field name EXACTLY. Reuse the upstream field's type when available. This makes the user's answer replace the broken value on retry.

SCENARIO B — "ask for missing info": the agent needs a NEW piece of information the workflow never collected. There's no existing name to reuse.
  → Emit a field with a new snake_case name that describes the variable. The engine will store it transiently for this retry only.

SCENARIO C — "hybrid": both an existing input is broken AND new info is needed.
  → Emit both kinds of fields in the array.

Output shape:
{
  "reason": string,   // 1-2 sentences, written AS THE QUESTION the human should answer. Direct — "Which region should we target?" not "The agent needs to know the region."
  "fields": [         // 1-3 fields, minimal and targeted.
    {
      "name": string,       // snake_case. For Scenario A: MUST match a TEMPLATE PLACEHOLDER or UPSTREAM FIELD name. For Scenario B: a fresh name that doesn't collide with NODE OUTPUTS.
      "type": "text" | "textarea" | "select" | "number" | "boolean",
      "label": string,      // human-readable label
      "required": boolean,  // usually true
      "options": string[]?  // only for type=select — concrete enum values inferred from context
    }
  ]
}

Hard rules (enforced — violations will be rewritten by the engine):
- Output ONLY the JSON object. No markdown fences, no prose before/after.
- When TEMPLATE PLACEHOLDERS or UPSTREAM FIELDS is non-empty, at least one field in your response MUST have a \`name\` taken EXACTLY from one of those two lists. This is non-negotiable for Scenario A — the engine will reject your response and deterministically pick a placeholder name if you fail to match.
- NEVER use a name that appears in NODE OUTPUTS.
- Reuse types from UPSTREAM FIELDS when reusing their names, so the UI stays consistent.
- Prefer "textarea" for free-form questions; "select" ONLY when you can enumerate ALL plausible options; "text" for short strings.
- Keep reason concise; don't echo the agent's full response.
- Do NOT call any tools. Just write the JSON.

IMPORTANT: Do NOT invent field names like \`question\`, \`user_input\`, or \`clarification\` when TEMPLATE PLACEHOLDERS already contains a matching or more-specific name. Pick the placeholder name verbatim so the user's answer overwrites the broken value.`;

/**
 * Ask Haiku to produce `{ reason, fields }` for the clarify dialog.
 * Uses the Claude Code SDK so it runs through the user's existing auth
 * (subscription or API key — whichever the SDK is configured with).
 * Returns null on any failure so the caller can gracefully fall back.
 */
export async function synthesizeClarifyContext(
  input: ClarifySynthesisInput,
): Promise<ClarifySynthesisOutput | null> {
  const log = input.log ?? (() => {});
  const model = normalizeModelAlias(input.model ?? 'haiku') ?? 'haiku';
  const userContent = buildContext(input);

  log({
    phase: 'start',
    model,
    reasonProvided: !!(input.agentReason && input.agentReason.trim().length > 0),
    fieldsProvided: 0,
    contextChars: userContent.length,
  });

  try {
    const { query } = await import('@anthropic-ai/claude-code');

    const startMs = Date.now();
    const conv = query({
      prompt: userContent,
      options: {
        customSystemPrompt: SYNTH_SYSTEM_PROMPT,
        model,
        permissionMode: 'bypassPermissions',
        env: process.env as Record<string, string>,
        ...(input.abortSignal
          ? { abortController: { signal: input.abortSignal, abort() { /* no-op */ } } as unknown as AbortController }
          : {}),
      } as Record<string, unknown>,
    });

    let text = '';
    for await (const message of conv) {
      if ((message as { type?: string }).type === 'assistant') {
        const blocks = ((message as { message?: { content?: Array<{ type: string; text?: string }> } })
          .message?.content) ?? [];
        for (const block of blocks) {
          if (block.type === 'text' && typeof block.text === 'string') {
            text += block.text;
          }
        }
      }
      if ((message as { type?: string }).type === 'result') break;
    }

    const durationMs = Date.now() - startMs;
    log({
      phase: 'haiku_response',
      durationMs,
      textLen: text.length,
      preview: text.slice(0, 200),
    });

    const cleaned = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim();
    if (!cleaned) {
      log({ phase: 'failed', stage: 'empty_response', reason: 'Haiku returned empty text' });
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const jsonBlock = extractFirstJsonObject(cleaned);
      if (!jsonBlock) {
        log({ phase: 'failed', stage: 'no_json', reason: 'No JSON object in response', detail: cleaned.slice(0, 200) });
        return null;
      }
      try { parsed = JSON.parse(jsonBlock); }
      catch (e) {
        log({ phase: 'failed', stage: 'parse', reason: 'JSON parse error', detail: (e as Error).message });
        return null;
      }
    }

    const result = validateSynthesis(parsed, new Set(input.nodeOutputs ?? []));
    if (!result) {
      log({ phase: 'failed', stage: 'validate', reason: 'Synthesis shape invalid (missing reason or malformed fields)' });
      return null;
    }

    // Strict-mode rewrite — if there are known overwrite targets
    // (template placeholders or upstream fields), the synthesized fields
    // MUST include at least one of those names. When Haiku invents a
    // generic name like "question" or "clarification" instead, rewrite
    // the first field to use the best overwrite target deterministically.
    // This makes the user's answer actually replace the broken value
    // on retry, instead of creating a new state key the workflow won't
    // template against.
    const allowed = new Set<string>([
      ...(input.templatePlaceholders ?? []).map((p) => p.split('.')[0]).filter(Boolean),
      ...(input.upstreamFields ?? []).map((f) => f.name),
    ]);
    const hasAllowed = allowed.size > 0;
    const intersects = result.fields.some((f) => allowed.has(f.name));
    if (hasAllowed && !intersects) {
      const target = pickBestOverwriteTarget(input);
      if (target) {
        const originalNames = result.fields.map((f) => f.name);
        // Keep reason text; replace the primary field's name + type with
        // the overwrite target. If Haiku emitted multiple fields, keep
        // the extras (they may be legitimate Scenario C additions).
        const [primary, ...rest] = result.fields;
        const rewritten: ClarifyField = {
          name: target.name,
          type: target.type ?? primary?.type ?? 'textarea',
          label: target.label ?? primary?.label ?? target.name,
          required: primary?.required ?? true,
        };
        if (primary?.options) rewritten.options = primary.options;
        if (primary?.placeholder) rewritten.placeholder = primary.placeholder;
        result.fields = [rewritten, ...rest.filter((f) => !allowed.has(f.name) && f.name !== target.name)];
        log({
          phase: 'strict_rewrite',
          detail: `Haiku picked names [${originalNames.join(', ')}] but none matched a placeholder; forced to "${target.name}".`,
          originalNames,
          finalNames: result.fields.map((f) => f.name),
        });
      }
    }

    log({
      phase: 'parsed',
      reason: result.reason,
      fieldCount: result.fields.length,
      fieldTypes: result.fields.map(f => `${f.name}:${f.type}`),
    });

    return { ...result, synthesized: true };
  } catch (err) {
    log({ phase: 'failed', stage: 'sdk', reason: 'SDK call threw', detail: (err as Error).message });
    return null;
  }
}

function buildContext(input: ClarifySynthesisInput): string {
  const lines: string[] = [];
  lines.push(`NODE: ${input.nodeName}`);
  if (input.nodePrompt) {
    lines.push(`\nNODE PROMPT (what the agent was asked):\n${truncate(input.nodePrompt, 1500)}`);
  }
  if (input.agentReason) {
    lines.push(`\nAGENT'S STATED REASON:\n${truncate(input.agentReason, 400)}`);
  }
  if (input.rawResponse) {
    lines.push(`\nAGENT'S RAW RESPONSE:\n${truncate(input.rawResponse, 2000)}`);
  }

  // Template placeholders — the keys the node's prompt reads. Scenario A
  // field names must come from this list. Show current values so Haiku
  // can judge which one is broken.
  if (input.templatePlaceholders && input.templatePlaceholders.length > 0) {
    const placeholderLines = input.templatePlaceholders.map((p) => {
      const v = readPath(input.inputVars, p);
      return `  {{${p}}} = ${formatValue(v)}`;
    });
    lines.push(`\nTEMPLATE PLACEHOLDERS (current values — "bad input" overwrite targets):\n${placeholderLines.join('\n')}`);
  }

  // Upstream fields — Scenario A can also reuse these names. Types are
  // shown so Haiku can match them.
  if (input.upstreamFields && input.upstreamFields.length > 0) {
    const fieldLines = input.upstreamFields.map((f) => {
      const t = f.type ? `:${f.type}` : '';
      const lbl = f.label ? ` (label: "${f.label}")` : '';
      return `  ${f.name}${t} from ${f.nodeName}${lbl}`;
    });
    lines.push(`\nUPSTREAM HUMAN FIELDS (reusable names if the user should re-fill one):\n${fieldLines.join('\n')}`);
  }

  // Node outputs — forbidden names.
  if (input.nodeOutputs && input.nodeOutputs.length > 0) {
    lines.push(`\nNODE OUTPUTS (FORBIDDEN field names — these are the keys this node is supposed to produce):\n  ${input.nodeOutputs.join(', ')}`);
  }

  // All other input variables for context.
  const placeholderSet = new Set(input.templatePlaceholders ?? []);
  const vars = Object.entries(input.inputVars)
    .filter(([k]) => !k.startsWith('__') && k !== 'retry_context' && k !== 'retry_count' && !placeholderSet.has(k))
    .map(([k, v]) => `${k} = ${formatValue(v)}`)
    .join('\n');
  if (vars) {
    lines.push(`\nOTHER STATE VARIABLES (not templated by this node):\n${vars}`);
  }
  return lines.join('\n');
}

/**
 * Deterministic fallback when Haiku's picked names don't intersect the
 * overwrite-target set. Prefers the placeholder whose current value
 * looks broken (empty / null / gibberish / very short). Falls back to
 * the first placeholder, then the first upstream field.
 *
 * Returns null when no overwrite target exists at all — in that case
 * the caller leaves Haiku's invented names alone (it's a Scenario B
 * clarify with no variable to overwrite).
 */
function pickBestOverwriteTarget(
  input: ClarifySynthesisInput,
): { name: string; type?: string; label?: string } | null {
  const placeholders = (input.templatePlaceholders ?? [])
    .map((p) => p.split('.')[0])
    .filter(Boolean);

  // Score each placeholder by how "broken" its current value looks. The
  // most-broken one is the most likely overwrite target — that's what
  // caused the agent's clarify in the first place.
  const scored = placeholders.map((name) => ({
    name,
    score: brokennessScore(input.inputVars[name]),
  }));
  scored.sort((a, b) => b.score - a.score);
  const winner = scored[0];
  if (winner && winner.score > 0) {
    const upstream = input.upstreamFields?.find((f) => f.name === winner.name);
    return { name: winner.name, type: upstream?.type, label: upstream?.label };
  }

  // No placeholder flagged as broken — take whichever the workflow actually
  // exposes upstream (more ergonomic type + label), else the first placeholder.
  const firstUpstream = (input.upstreamFields ?? []).find((f) =>
    placeholders.length === 0 || placeholders.includes(f.name),
  );
  if (firstUpstream) {
    return { name: firstUpstream.name, type: firstUpstream.type, label: firstUpstream.label };
  }
  if (placeholders.length > 0) {
    return { name: placeholders[0] };
  }
  return null;
}

/**
 * Heuristic score for how "broken" a value looks. Higher = more broken.
 *   3: null / undefined / empty string
 *   2: looks like keyboard mashing (short, all alpha lowercase, no spaces)
 *   1: very short (<3 chars)
 *   0: looks legitimate
 */
function brokennessScore(v: unknown): number {
  if (v == null) return 3;
  if (typeof v !== 'string') return 0;
  const s = v.trim();
  if (s.length === 0) return 3;
  if (s.length < 3) return 1;
  // Gibberish heuristic: all ASCII lowercase letters, no spaces or punct,
  // and no recognizable word boundaries. Catches "lskjflksjkfljklfk" etc.
  if (s.length < 40 && /^[a-z]+$/.test(s) && !/[aeiou]{2,}/.test(s)) return 2;
  return 0;
}

/** Walk a dotted path like "user.name" into a nested object. Returns
 *  undefined when any segment is missing. Used to show current values
 *  for each template placeholder so Haiku can spot which one is bad. */
function readPath(context: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.').filter(Boolean);
  let cur: unknown = context;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
    if (cur === undefined) return undefined;
  }
  return cur;
}

/**
 * Find and return the first balanced JSON object in a string. Used when
 * Haiku adds prose around the JSON despite system instructions. Handles
 * nested braces; returns null if no balanced object is found.
 */
function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** Defensive validation — Haiku is capable, but still verify the shape
 *  and enforce the hard "don't use nodeOutputs as field names" rule. */
function validateSynthesis(
  v: unknown,
  forbiddenNames: Set<string>,
): { reason: string; fields: ClarifyField[] } | null {
  if (!v || typeof v !== 'object') return null;
  const obj = v as Record<string, unknown>;
  const reason = typeof obj.reason === 'string' && obj.reason.trim().length > 0
    ? obj.reason.trim()
    : null;
  if (!reason) return null;
  const rawFields = Array.isArray(obj.fields) ? obj.fields : [];
  const fields: ClarifyField[] = [];
  const usedNames = new Set<string>();
  for (const f of rawFields) {
    if (!f || typeof f !== 'object') continue;
    const fo = f as Record<string, unknown>;
    const name = typeof fo.name === 'string' ? fo.name.trim() : '';
    if (!name || name.startsWith('__')) continue;
    // Don't let Haiku pre-fill a declared output of this node — that's
    // the agent's job to produce, not the user's to supply.
    if (forbiddenNames.has(name)) continue;
    // De-dupe — a well-formed response has unique names, but defend anyway.
    if (usedNames.has(name)) continue;
    usedNames.add(name);
    const type = typeof fo.type === 'string' ? fo.type : 'text';
    const cleaned: ClarifyField = { name, type };
    if (typeof fo.label === 'string') cleaned.label = fo.label;
    if (typeof fo.required === 'boolean') cleaned.required = fo.required;
    if (Array.isArray(fo.options)) {
      cleaned.options = fo.options.filter((o: unknown): o is string => typeof o === 'string');
    }
    if (typeof fo.placeholder === 'string') cleaned.placeholder = fo.placeholder;
    fields.push(cleaned);
  }
  // Guarantee at least one field so the dialog is actionable. If Haiku
  // returned nothing usable, we fall back to a free-form textarea whose
  // value the engine will later treat as "ephemeral" (auto-cleaned).
  if (fields.length === 0) {
    fields.push({
      name: 'clarification',
      type: 'textarea',
      label: 'Your response',
      required: true,
    });
  }
  return { reason, fields };
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)} ... (${s.length - max} chars truncated)` : s;
}

function formatValue(v: unknown): string {
  if (v == null) return String(v);
  if (typeof v === 'string') return truncate(v, 300);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return truncate(JSON.stringify(v), 300); }
  catch { return String(v); }
}
