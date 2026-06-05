import type { Db } from 'mongodb';
import type { TokenUsageInfo } from '@allen/engine';
import type { ChatLLMMessage, ChatTraceEvent } from './chat-llm.js';
import type { ChatProvider, ProviderCallbacks } from './chat-providers.js';
import type { ResolvedSettings } from './agent-settings.js';

export interface RuntimeTurnInput {
  db: Db;
  chatSessionId?: string;
  provider: ChatProvider;
  model: string;
  resolvedSettings?: ResolvedSettings;
  systemPrompt: string;
  messages: ChatLLMMessage[];
  resumeSessionId?: string;
  skipTools?: boolean;
  cwd?: string;
  callbacks: ProviderCallbacks;
}

export interface RuntimeTurnResult {
  text: string;
  costUsd: number;
  sessionId?: string;
  trace: ChatTraceEvent[];
  tokenUsage?: TokenUsageInfo | null;
}

export interface RuntimeSlashCommand {
  name: string;
  raw: string;
  args: string;
  kind?: 'builtin' | 'skill' | 'command';
  path?: string;
}

export interface PersistentChatRuntime {
  readonly id: string;
  readonly provider: ChatProvider;
  readonly key: string;
  sendTurn(input: RuntimeTurnInput): Promise<RuntimeTurnResult>;
  close(reason: string): Promise<void>;
}

export interface RuntimeCreateInput {
  db: Db;
  key: string;
  provider: ChatProvider;
  model: string;
  cwd?: string;
  chatSessionId?: string;
  systemPrompt: string;
  resolvedSettings?: ResolvedSettings;
  skipTools?: boolean;
  resumeSessionId?: string;
}

export interface RuntimeLogInput {
  db?: Db;
  sessionId?: string;
  messageId?: string;
  provider: ChatProvider | string;
  runtimeId?: string;
  eventType: 'lifecycle' | 'normalized' | 'raw_provider' | 'mcp' | 'error';
  event: string;
  data?: unknown;
}
