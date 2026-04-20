/**
 * Shared tool-call record type used to persist tool invocations from
 * both the Claude SDK and Codex CLI providers into the MongoDB
 * `execution_traces` and `chat_messages` collections.
 *
 * Populated by provider-specific capture code and read by UI components
 * that render the per-execution / per-chat tool log.
 */

const DEFAULT_PAYLOAD_CAP_BYTES = 10 * 1024;

export interface ToolCallRecord {
  /** Tool identifier as emitted by the provider. e.g. "Bash", "mcp__allen__list_repos". */
  tool: string;
  /** One-line human-readable summary, derived via describeTool. */
  description: string;
  /** Arguments passed to the tool. JSON-serializable. May be truncated — see truncated.args. */
  args: Record<string, unknown>;
  /** Result returned by the tool. May be truncated — see truncated.result. */
  result?: unknown;
  /** Duration from tool_use emission to tool_result, in ms. 0 if unknown. */
  durationMs: number;
  /** When the tool call started (server clock). */
  startedAt: Date;
  /** Whether the tool reported an error. */
  isError?: boolean;
  /** Which payload fields were truncated due to the size cap. */
  truncated?: { args?: boolean; result?: boolean };
  /** Provider-assigned id (tool_use_id / item.id) — used to pair start/complete events. */
  toolUseId?: string;
}

/**
 * Render a compact one-line description of a tool call. Recognizes common
 * built-in names (Bash, Read, Edit, Grep, Glob, Write, etc.) and MCP tools
 * (mcp__<server>__<tool>). Unknown tools fall back to a safe generic line.
 */
export function describeTool(tool: string, args: Record<string, unknown>): string {
  const str = (k: string): string => typeof args[k] === 'string' ? (args[k] as string) : '';
  const firstLine = (s: string, n = 120): string => {
    const one = s.split('\n', 1)[0];
    return one.length > n ? one.slice(0, n) + '…' : one;
  };

  if (tool === 'Bash') return `Bash: ${firstLine(str('command'))}`;
  if (tool === 'Read') return `Read ${str('file_path') || '(file)'}`;
  if (tool === 'Write') return `Write ${str('file_path') || '(file)'}`;
  if (tool === 'Edit') return `Edit ${str('file_path') || '(file)'}`;
  if (tool === 'NotebookEdit') return `NotebookEdit ${str('notebook_path') || '(notebook)'}`;
  if (tool === 'Grep') return `Grep ${JSON.stringify(str('pattern'))} in ${str('path') || '.'}`;
  if (tool === 'Glob') return `Glob ${str('pattern')}`;
  if (tool === 'WebFetch') return `WebFetch ${str('url')}`;
  if (tool === 'WebSearch') return `WebSearch ${JSON.stringify(str('query'))}`;
  if (tool === 'Task' || tool === 'Agent') return `Delegate → ${str('subagent_type') || str('description') || 'subagent'}`;
  if (tool === 'TodoWrite') return `TodoWrite (${Array.isArray(args.todos) ? (args.todos as unknown[]).length : 0} items)`;

  // MCP tools: mcp__<server>__<tool>
  const mcpMatch = /^mcp__([^_]+)__(.+)$/.exec(tool);
  if (mcpMatch) {
    const [, server, fn] = mcpMatch;
    const firstArgKey = Object.keys(args)[0];
    const firstArgVal = firstArgKey ? args[firstArgKey] : undefined;
    const hint = typeof firstArgVal === 'string' && firstArgVal
      ? ` ${firstArgKey}=${firstLine(firstArgVal, 40)}`
      : Object.keys(args).length > 0
        ? ` ${Object.keys(args).slice(0, 3).join(',')}`
        : '';
    return `${server}:${fn}${hint}`;
  }

  // Unknown — first ~3 arg keys as a hint
  const keys = Object.keys(args).slice(0, 3).join(',');
  return keys ? `${tool} (${keys})` : tool;
}

/**
 * Clamp a payload to maxBytes of JSON, returning { value, truncated }.
 * Strings are trimmed; objects/arrays are JSON-stringified and then trimmed
 * with a final `"...": "[truncated N bytes]"` marker so the UI can show it.
 * Primitive scalars (numbers, booleans, null) are returned as-is.
 */
export function truncatePayload<T = unknown>(
  value: T,
  maxBytes = DEFAULT_PAYLOAD_CAP_BYTES,
): { value: unknown; truncated: boolean } {
  if (value === null || value === undefined) return { value, truncated: false };
  if (typeof value === 'number' || typeof value === 'boolean') return { value, truncated: false };

  if (typeof value === 'string') {
    if (value.length <= maxBytes) return { value, truncated: false };
    return {
      value: value.slice(0, maxBytes) + `\n…[truncated ${value.length - maxBytes} chars]`,
      truncated: true,
    };
  }

  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return { value: '[unserializable]', truncated: true };
  }
  if (json.length <= maxBytes) return { value, truncated: false };

  // Re-parse a trimmed view so the stored record remains valid JSON for
  // UIs that want to render structured output. Fall back to a string form
  // if the trimmed prefix isn't valid JSON.
  const trimmed = json.slice(0, maxBytes) + '"…[truncated]"';
  try {
    return { value: JSON.parse(trimmed), truncated: true };
  } catch {
    return {
      value: { __truncated__: true, preview: json.slice(0, maxBytes) },
      truncated: true,
    };
  }
}

/**
 * Build a ToolCallRecord from the primitives emitted by either provider,
 * applying truncation and description in one place so both paths produce
 * identical records.
 */
export function buildToolCallRecord(input: {
  tool: string;
  args: Record<string, unknown>;
  result?: unknown;
  durationMs: number;
  startedAt: Date;
  isError?: boolean;
  toolUseId?: string;
  payloadCapBytes?: number;
}): ToolCallRecord {
  const cap = input.payloadCapBytes ?? DEFAULT_PAYLOAD_CAP_BYTES;
  const argsT = truncatePayload(input.args, cap);
  const resultT = input.result === undefined
    ? { value: undefined, truncated: false }
    : truncatePayload(input.result, cap);

  const rec: ToolCallRecord = {
    tool: input.tool,
    description: describeTool(input.tool, input.args),
    args: argsT.value as Record<string, unknown>,
    durationMs: input.durationMs,
    startedAt: input.startedAt,
  };
  if (resultT.value !== undefined) rec.result = resultT.value;
  if (input.isError) rec.isError = true;
  if (input.toolUseId) rec.toolUseId = input.toolUseId;
  if (argsT.truncated || resultT.truncated) {
    rec.truncated = {};
    if (argsT.truncated) rec.truncated.args = true;
    if (resultT.truncated) rec.truncated.result = true;
  }
  return rec;
}
