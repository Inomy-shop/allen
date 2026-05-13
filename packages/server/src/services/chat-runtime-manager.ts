import type { Db } from 'mongodb';
import { AGENT_FALLBACK_CWD, type ChatProvider } from './chat-providers.js';
import { ClaudePersistentRuntime } from './claude-persistent-runtime.js';
import { CodexAppServerRuntime } from './codex-app-server-runtime.js';
import { logRuntimeEvent } from './chat-runtime-logs.js';
import type { PersistentChatRuntime, RuntimeCreateInput, RuntimeTurnInput, RuntimeTurnResult } from './chat-runtime-types.js';

type RuntimeEntry = {
  runtime: PersistentChatRuntime;
  idleTimer?: NodeJS.Timeout;
  chain: Promise<unknown>;
};

const runtimes = new Map<string, RuntimeEntry>();

export function persistentChatRuntimeEnabled(): boolean {
  return process.env.CHAT_PERSISTENT_RUNTIME_ENABLED !== 'false';
}

export async function runPersistentChatTurn(input: RuntimeTurnInput): Promise<RuntimeTurnResult> {
  if (!input.chatSessionId) throw new Error('Persistent chat runtime requires chatSessionId');
  const key = runtimeKey(input);
  const entry = getOrCreateRuntime(key, input);
  clearIdleTimer(entry);

  const run = async () => {
    const onAbort = () => {
      void closeRuntime(key, 'abort');
    };
    if (input.callbacks.signal?.aborted) onAbort();
    else input.callbacks.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      logRuntimeEvent({
        db: input.db,
        sessionId: input.chatSessionId,
        provider: input.provider,
        runtimeId: entry.runtime.id,
        eventType: 'lifecycle',
        event: 'runtime_reuse',
        data: { key },
      });
      return await entry.runtime.sendTurn(input);
    } catch (err) {
      await closeRuntime(key, `turn_error:${err instanceof Error ? err.message : String(err)}`);
      throw err;
    } finally {
      input.callbacks.signal?.removeEventListener('abort', onAbort);
      armIdleTimer(key, entry, input.db, input.chatSessionId, input.provider);
    }
  };

  const turn = entry.chain.then(run, run);
  entry.chain = turn.catch(() => {});
  return turn;
}

export async function closeRuntimeForChatSession(chatSessionId: string, reason: string): Promise<void> {
  const matches = [...runtimes.keys()].filter((key) => key.includes(`session=${chatSessionId}|`));
  await Promise.all(matches.map((key) => closeRuntime(key, reason)));
}

function getOrCreateRuntime(key: string, input: RuntimeTurnInput): RuntimeEntry {
  const existing = runtimes.get(key);
  if (existing) return existing;
  const createInput: RuntimeCreateInput = {
    db: input.db,
    key,
    provider: input.provider,
    model: input.model,
    cwd: input.cwd,
    chatSessionId: input.chatSessionId,
    systemPrompt: input.systemPrompt,
    resolvedSettings: input.resolvedSettings,
    skipTools: input.skipTools,
    resumeSessionId: input.resumeSessionId,
  };
  const runtime = createRuntime(createInput);
  const entry: RuntimeEntry = { runtime, chain: Promise.resolve() };
  runtimes.set(key, entry);
  logRuntimeEvent({
    db: input.db,
    sessionId: input.chatSessionId,
    provider: input.provider,
    runtimeId: runtime.id,
    eventType: 'lifecycle',
    event: 'runtime_created',
    data: { key, resumeSessionId: input.resumeSessionId },
  });
  return entry;
}

function createRuntime(input: RuntimeCreateInput): PersistentChatRuntime {
  if (input.provider === 'claude-cli') return new ClaudePersistentRuntime(input);
  if (input.provider === 'codex') return new CodexAppServerRuntime(input);
  throw new Error(`Unsupported persistent chat provider: ${input.provider satisfies never}`);
}

function runtimeKey(input: RuntimeTurnInput): string {
  return [
    `session=${input.chatSessionId ?? ''}`,
    `provider=${input.provider}`,
    `model=${input.model}`,
    `cwd=${input.cwd ?? AGENT_FALLBACK_CWD}`,
    `plan=${input.resolvedSettings?.planMode ?? false}`,
  ].join('|');
}

function idleMs(): number {
  const value = Number(process.env.CHAT_RUNTIME_IDLE_MS ?? process.env.CHAT_PERSISTENT_RUNTIME_IDLE_MS ?? 900_000);
  return Number.isFinite(value) && value > 0 ? value : 900_000;
}

function clearIdleTimer(entry: RuntimeEntry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = undefined;
}

function armIdleTimer(key: string, entry: RuntimeEntry, db: Db, sessionId: string | undefined, provider: ChatProvider): void {
  clearIdleTimer(entry);
  const timeoutMs = idleMs();
  logRuntimeEvent({
    db,
    sessionId,
    provider,
    runtimeId: entry.runtime.id,
    eventType: 'lifecycle',
    event: 'runtime_idle',
    data: { closeAfterMs: timeoutMs },
  });
  entry.idleTimer = setTimeout(() => {
    void closeRuntime(key, 'idle_timeout');
  }, timeoutMs);
  entry.idleTimer.unref();
}

async function closeRuntime(key: string, reason: string): Promise<void> {
  const entry = runtimes.get(key);
  if (!entry) return;
  clearIdleTimer(entry);
  runtimes.delete(key);
  await entry.runtime.close(reason);
}
