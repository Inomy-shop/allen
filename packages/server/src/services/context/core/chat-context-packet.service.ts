import { randomUUID } from 'node:crypto';
import { ObjectId, type Db } from 'mongodb';
import {
  MultiDatasetCogneeProvider,
  CogneeMemoryProvider,
} from '../cognee/repo-context-cognee-provider.js';
import { isCogneeContextEnabled } from '../config/context-provider-config.js';
import { firstString, isRecord } from '../common/context-utils.js';
import { collectCurrentFiles, normalizeRepoContextProvider, resolveRepoFromPath } from '../common/repo-context-paths.js';
import { ContextLifecycleStore } from '../lifecycle/context-lifecycle-store.js';
import {
  RepoContextEngine,
  type RepoContextProvider,
} from './repo-context-engine.js';
import {
  WorkflowContextInjectionAdapter,
  summarizeInjection,
} from './workflow-context-injection-adapter.js';
import type { UsageToolCall } from '../common/context-usage.types.js';
import { RepoContextPacketService } from './repo-context-packet.service.js';

export type ChatContextRetrievalDecision = {
  shouldSkip: boolean;
  reason?: 'low_signal_action_turn';
  normalizedText: string;
  wordCount: number;
};

export class ChatContextPacketService {
  private lifecycle: ContextLifecycleStore;

  constructor(private readonly db: Db) {
    this.lifecycle = new ContextLifecycleStore(db);
  }

  async buildChatContextPacket(input: {
    sessionId: string;
    messageId: string;
    agentName?: string | null;
    prompt: string;
    provider?: RepoContextProvider;
    state: Record<string, unknown>;
  }): Promise<{
    packetId: string;
    promptBlock: string;
    injectedPromptBlock: string;
    userTurnContextBlock: string;
    traceSummary: Record<string, unknown>;
  } | null> {
    if (!isCogneeContextEnabled()) return null;
    const retrievalDecision = classifyChatContextRetrievalPrompt(input.prompt);
    if (retrievalDecision.shouldSkip) {
      const packetId = randomUUID();
      const nowAttempt = Date.now();
      await this.lifecycle.recordAttemptBuildStarted({
        contextAttemptId: packetId,
        executionId: input.sessionId,
        executionTraceId: input.messageId,
        workflowName: 'chat',
        nodeName: input.agentName || 'assistant',
        nodeRole: input.agentName || 'assistant',
        executionKind: 'chat_agent',
        targetRole: input.agentName || 'assistant',
        attempt: nowAttempt,
        repoId: '__chat_context_skipped__',
        repoName: 'Chat context skipped',
        repoPath: '',
        indexId: 'chat:cognee:skipped',
        indexFreshness: 'provider_runtime',
        taskPrompt: input.prompt,
        currentFiles: [],
        contextProvider: 'cognee_memory',
        contextRetrievalMode: 'chat_skipped_low_signal',
      });
      await this.lifecycle.markAttemptBuildStatus(packetId, 'skipped', {
        error: retrievalDecision.reason,
        skipReason: retrievalDecision.reason,
        skipDetails: retrievalDecision,
      });
      return {
        packetId,
        promptBlock: '',
        injectedPromptBlock: '',
        userTurnContextBlock: '',
        traceSummary: {
          packetId,
          executionId: input.sessionId,
          executionTraceId: input.messageId,
          repoId: '__chat_context_skipped__',
          repoName: 'Chat context skipped',
          indexId: 'chat:cognee:skipped',
          indexFreshness: 'provider_runtime',
          contextScope: 'skipped',
          status: 'skipped',
          skipReason: retrievalDecision.reason,
          skipDetails: retrievalDecision,
          retrievalProviders: [],
          selectedContextCount: 0,
          injectableContextCount: 0,
          injectedContextCount: 0,
          rejectedContextCount: 0,
          contextInjection: {
            injectedCount: 0,
            selectedCount: 0,
            skippedCount: 0,
            skipReason: retrievalDecision.reason,
          },
        },
      };
    }
    const repo = await this.resolveRepo(input.state);
    const repoScoped = Boolean(repo);
    const repoId = repoScoped ? String(repo!._id) : '__multi_repo_chat__';
    const repoName = repoScoped ? firstString(repo!.name) ?? 'repo' : 'All active repos';
    const repoPath = repoScoped ? firstString(repo!.path) ?? '' : '';
    const packetId = randomUUID();
    const provider = normalizeRepoContextProvider(input.provider);
    const contextEngine = repoScoped
      ? new RepoContextEngine([new CogneeMemoryProvider(this.db)], undefined, { db: this.db })
      : new RepoContextEngine([new MultiDatasetCogneeProvider(this.db)], undefined, { db: this.db });
    const adapter = new WorkflowContextInjectionAdapter();
    const packet = await contextEngine.buildPacket({
      packetId,
      executionId: input.sessionId,
      executionTraceId: input.messageId,
      repoId,
      repoName,
      repoPath,
      indexId: repoScoped ? `chat:cognee:${repoId}` : 'chat:cognee:multi_repo',
      indexFreshness: 'provider_runtime',
      workflowName: 'chat',
      nodeName: input.agentName || 'assistant',
      nodeRole: input.agentName || 'assistant',
      executionKind: 'chat_agent',
      targetRole: input.agentName || 'assistant',
      attempt: Date.now(),
      state: input.state,
      prompt: input.prompt,
      provider,
      currentFiles: collectCurrentFiles(input.state, input.prompt),
      nodes: [],
      worktreePath: input.state.worktree_path ?? input.state.worktreePath,
    });
    packet.providerDiagnostics.push({
      code: repoScoped ? 'chat_context_repo_scoped' : 'chat_context_multi_repo',
      severity: 'info',
      scope: repoScoped ? 'repo' : 'multi_repo',
      message: repoScoped
        ? 'Chat context searched the active repo dataset and excluded mandatory mappings.'
        : 'Chat context searched active repo/global datasets because no repo was specified.',
    });
    const previouslyInjectedRefs = await this.lifecycle.getPriorChatInjectedContextRefs(input.sessionId);
    const injection = await adapter.buildInjection({
      packet,
      provider,
      repoPath,
      worktreePath: firstString(input.state.worktree_path, input.state.worktreePath, input.state.repo_path, input.state.repoPath),
      targetLayer: 'user_prompt',
      previouslyInjectedRefs,
    });
    const injectedPromptBlock = adapter.renderSystemPromptBlock(injection);
    const promptBlock = adapter.renderContextPacket(packet);
    const contextInjection = summarizeInjection(injection);
    await this.lifecycle.saveAttemptFromPacket({
      packet,
      injection,
      contextInjection,
      promptBlock,
      systemPromptBlock: injectedPromptBlock,
      contextProvider: 'cognee_memory',
      contextRetrievalMode: repoScoped ? 'chat_repo' : 'chat_multi_repo',
    });
    const traceSummary = {
      packetId,
      executionId: input.sessionId,
      executionTraceId: input.messageId,
      repoId,
      repoName,
      indexId: packet.indexId,
      indexFreshness: packet.indexFreshness,
      contextScope: repoScoped ? 'repo' : 'multi_repo',
      retrievalProviders: packet.retrievalProviders,
      selectedContextCount: packet.selectedRefs.length,
      injectableContextCount: packet.injectableRefs?.length ?? 0,
      injectedContextCount: injection.injectedRefs.length,
      rejectedContextCount: packet.rejectedRefs.length,
      contextInjection,
    };
    const blocks = [injectedPromptBlock, promptBlock].filter((value) => value.trim());
    return {
      packetId,
      promptBlock,
      injectedPromptBlock,
      userTurnContextBlock: blocks.length
        ? `CHAT REPO CONTEXT (read-only, scoped to this user turn):\n${blocks.join('\n\n')}`
        : '',
      traceSummary,
    };
  }

  async recordChatContextUsage(input: {
    sessionId: string;
    messageId: string;
    agentName?: string | null;
    packetId?: string;
    rawResponse?: string;
    toolCalls?: UsageToolCall[];
  }): Promise<Record<string, unknown> | null> {
    if (!input.packetId) return null;
    return new RepoContextPacketService(this.db).recordContextUsage({
      executionId: input.sessionId,
      executionTraceId: input.messageId,
      workflowName: 'chat',
      nodeName: input.agentName || 'assistant',
      nodeRole: input.agentName || 'assistant',
      executionKind: 'chat_agent',
      targetRole: input.agentName || 'assistant',
      attempt: Date.now(),
      packetId: input.packetId,
      outputs: {},
      rawResponse: input.rawResponse,
      toolCalls: input.toolCalls,
    }).catch((err) => ({
      error: (err as Error).message,
      packetId: input.packetId,
    }));
  }

  getChatContextUsageReport(sessionId: string): Promise<Record<string, unknown>> {
    return this.lifecycle.getChatContextUsageReport(sessionId);
  }

  private async resolveRepo(state: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const repoId = firstString(
      state.repoId,
      state.repo_id,
      isRecord(state.repo) ? state.repo.repoId : undefined,
    );
    if (repoId) {
      try {
        const repo = await this.db.collection('repos').findOne({ _id: new ObjectId(repoId) }).catch(() => null);
        if (repo) return repo;
      } catch {
        // Fall back to path resolution below.
      }
    }
    const pathHint = firstString(state.worktree_path, state.worktreePath, state.repo_path, state.repoPath);
    return resolveRepoFromPath(this.db, pathHint);
  }
}

export function classifyChatContextRetrievalPrompt(prompt: string): ChatContextRetrievalDecision {
  const normalizedText = prompt
    .replace(/[`*_~>#\[\](){}]/g, ' ')
    .replace(/[.!?,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const words = normalizedText ? normalizedText.split(' ').filter(Boolean) : [];
  const wordCount = words.length;
  const base = { normalizedText, wordCount };
  if (!normalizedText || wordCount > 3) return { ...base, shouldSkip: false };
  if (hasRetrievalBearingSignal(prompt)) return { ...base, shouldSkip: false };
  if (LOW_SIGNAL_ACTION_PHRASES.has(normalizedText)) {
    return { ...base, shouldSkip: true, reason: 'low_signal_action_turn' };
  }
  const [verb, second, third] = words;
  const object = third && second === 'the' ? third : second;
  if (LOW_SIGNAL_ACTION_VERBS.has(verb) && (!object || LOW_SIGNAL_ACTION_OBJECTS.has(object))) {
    return { ...base, shouldSkip: true, reason: 'low_signal_action_turn' };
  }
  return { ...base, shouldSkip: false };
}

const LOW_SIGNAL_ACTION_PHRASES = new Set([
  'approved',
  'continue',
  'continue this',
  'do it',
  'execute',
  'go ahead',
  'implement',
  'implement changes',
  'implement it',
  'implement plan',
  'implement the plan',
  'make it happen',
  'ok',
  'okay',
  'please continue',
  'please proceed',
  'proceed',
  'retry',
  'rerun',
  'resume',
  'run agent',
  'run it',
  'run the agent',
  'run the workflow',
  'run workflow',
  'ship it',
  'start',
  'start agent',
  'yes',
  'no',
]);

const LOW_SIGNAL_ACTION_VERBS = new Set([
  'continue',
  'execute',
  'implement',
  'proceed',
  'retry',
  'rerun',
  'resume',
  'run',
  'start',
]);

const LOW_SIGNAL_ACTION_OBJECTS = new Set([
  'agent',
  'changes',
  'it',
  'plan',
  'task',
  'that',
  'this',
  'workflow',
  'work',
]);

function hasRetrievalBearingSignal(prompt: string): boolean {
  return /https?:\/\//i.test(prompt)
    || /(^|\s)@\S+/.test(prompt)
    || /\b[A-Z][A-Z0-9]+-\d+\b/.test(prompt)
    || /[`'"][^`'"]{3,}[`'"]/.test(prompt)
    || /(^|\s)[\w.-]+\/[\w./-]+/.test(prompt)
    || /\b\w+\.\w{1,6}\b/.test(prompt)
    || /\b[a-z]+[A-Z][A-Za-z0-9]*\b/.test(prompt)
    || /\b\w+[-_]\w+\b/.test(prompt);
}
