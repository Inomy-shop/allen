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
