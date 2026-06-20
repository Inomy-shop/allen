export type WaitExecutionMessageType =
  | 'text'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'log'
  | 'final_response'
  | 'error'
  | 'input_request';

export interface WaitExecutionMessage {
  at: string;
  type: WaitExecutionMessageType;
  source?: string;
  text: string;
}

const MESSAGE_TEXT_CAP = 500;

function trimText(value: unknown, max = MESSAGE_TEXT_CAP): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.length > max ? `${cleaned.slice(0, max)}...` : cleaned;
}

function toIso(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return undefined;
}

function sourceFrom(...values: unknown[]): string | undefined {
  for (const value of values) {
    const trimmed = trimText(value, 80);
    if (trimmed) return trimmed;
  }
  return undefined;
}

export function activityToWaitMessage(row: Record<string, unknown>): WaitExecutionMessage | undefined {
  const at = toIso(row.at ?? row.timestamp ?? row.createdAt) ?? new Date().toISOString();
  const rawType = String(row.type ?? 'text');
  const source = sourceFrom(row.agent);
  const tool = trimText(row.tool, 80);
  const content = trimText(row.content ?? row.label, 360);

  if (rawType === 'tool_call') {
    return {
      at,
      type: 'tool_call',
      source,
      text: trimText(`${source ?? 'agent'} called ${tool ?? 'tool'}${content ? `: ${content}` : ''}`) ?? 'Tool call',
    };
  }

  if (rawType === 'tool_result') {
    return {
      at,
      type: 'tool_result',
      source,
      text: trimText(`${source ?? 'agent'} received ${tool ?? 'tool'} result${content ? `: ${content}` : ''}`) ?? 'Tool result',
    };
  }

  if (rawType === 'thinking') {
    return {
      at,
      type: 'thinking',
      source,
      text: content ? `${source ?? 'agent'} is thinking: ${content}` : `${source ?? 'agent'} is thinking`,
    };
  }

  if (!content) return undefined;
  return {
    at,
    type: 'text',
    source,
    text: source ? `${source}: ${content}` : content,
  };
}

export function logToWaitMessage(row: Record<string, unknown>): WaitExecutionMessage | undefined {
  const text = trimText(row.message ?? row.content ?? row.command ?? row.tool ?? row.type);
  if (!text) return undefined;
  const node = sourceFrom(row.node, row.childAgentName, row.category, row.type);
  return {
    at: toIso(row.timestamp ?? row.createdAt) ?? new Date().toISOString(),
    type: 'log',
    source: node,
    text: node ? `[${node}] ${text}` : text,
  };
}

export function finalResponseToWaitMessage(
  response: unknown,
  at?: unknown,
  source?: unknown,
): WaitExecutionMessage | undefined {
  const text = trimText(response);
  if (!text) return undefined;
  return {
    at: toIso(at) ?? new Date().toISOString(),
    type: 'final_response',
    source: sourceFrom(source) ?? 'execution',
    text,
  };
}

export function errorToWaitMessage(error: unknown, at?: unknown, source?: unknown): WaitExecutionMessage | undefined {
  const text = trimText(error);
  if (!text) return undefined;
  return {
    at: toIso(at) ?? new Date().toISOString(),
    type: 'error',
    source: sourceFrom(source) ?? 'execution',
    text,
  };
}

export function inputRequestToWaitMessage(execution: Record<string, unknown>): WaitExecutionMessage | undefined {
  const state = execution.state && typeof execution.state === 'object'
    ? execution.state as Record<string, unknown>
    : {};
  const currentNodes = Array.isArray(execution.currentNodes) ? execution.currentNodes : [];
  const node = sourceFrom(currentNodes[0]);
  const reason = trimText(state.__reason, 260) ?? 'The execution is waiting for input.';
  const fields = Array.isArray(state.__clarify_fields)
    ? state.__clarify_fields
      .map((field) => {
        if (!field || typeof field !== 'object') return undefined;
        const record = field as Record<string, unknown>;
        return trimText(record.label ?? record.name, 80);
      })
      .filter((value): value is string => Boolean(value))
    : [];
  const reviewContent = trimText(
    typeof state.__clarify_content === 'string'
      ? state.__clarify_content
      : state.__clarify_content != null
        ? JSON.stringify(state.__clarify_content)
        : undefined,
    180,
  );
  const details = [
    node ? `node: ${node}` : undefined,
    fields.length > 0 ? `fields: ${fields.join(', ')}` : undefined,
    reviewContent ? `review: ${reviewContent}` : undefined,
  ].filter(Boolean).join('; ');
  return {
    at: toIso(execution.updatedAt ?? execution.completedAt ?? execution.startedAt) ?? new Date().toISOString(),
    type: 'input_request',
    source: node,
    text: details ? `${reason} (${details})` : reason,
  };
}

export function compactWaitMessages(messages: Array<WaitExecutionMessage | undefined>, limit = 10): WaitExecutionMessage[] {
  return messages
    .filter((message): message is WaitExecutionMessage => Boolean(message?.text))
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
    .slice(-Math.max(1, limit));
}
