import type { RuntimeLogInput } from './chat-runtime-types.js';

function runtimeLogsEnabled(): boolean {
  return process.env.CHAT_RUNTIME_LOGS_ENABLED === 'true' || process.env.CHAT_PERSISTENT_RUNTIME_LOGS === 'true';
}

export function logRuntimeEvent(input: RuntimeLogInput): void {
  if (!runtimeLogsEnabled()) return;
  if (!input.db || !input.sessionId) return;

  input.db.collection('chat_runtime_logs').insertOne({
    sessionId: input.sessionId,
    ...(input.messageId ? { messageId: input.messageId } : {}),
    provider: input.provider,
    ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
    eventType: input.eventType,
    event: input.event,
    data: input.data ?? {},
    timestamp: new Date(),
  }).catch(() => {});
}
