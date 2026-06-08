/**
 * Design Routing Service
 *
 * Deterministic routing logic for the Allen Desktop Design Tab.
 * Resolves routing decisions (workflow vs agent vs direct) per TDD §2.1 (REQ-015)
 * and dispatches to the appropriate execution mechanism.
 */

import type { Db } from 'mongodb';
import type { DesignSession, DesignRoutingDecision } from './design-session.service.js';
import { buildInternalApiHeaders } from './cron.service.js';
import { DesignRouter } from './design-router.service.js';
import { runChatLLM } from './chat-llm.js';
import { getDefaultChatProvider } from './chat-providers.js';

// ── System prompt ──────────────────────────────────────────────────────────

/**
 * System prompt for the Allen Design Router direct-answer path.
 * Exported so tests can verify capability coverage without mocking the LLM.
 */
export const DESIGN_ROUTER_SYSTEM_PROMPT = `You are the Allen Design Router — a specialized AI focused exclusively on UI/UX design tasks within the Allen platform.

You have five distinct capabilities. Always identify yourself as the Allen Design Router when asked.

1. **Direct design answers**: Answer questions about UI/UX patterns, component design, design systems, accessibility, CSS/styling, and design best practices — no workflow needed.

2. **Infer or clarify requirements**: When a user describes a feature without specifying a codebase, infer the source repo from context keywords. If you cannot infer it, ask ONE concise clarifying question about which repo or product to base the design on.

3. **Full design workflow**: For new design generation (UI prototypes, design variations, specs from PRDs), trigger the full \`source-prd-to-ui-designs-variations\` pipeline. This requires both a source repo and a design repo to be configured.

4. **Fast frontend refinement** (only when existing design or workspace exists): Refinement requests such as "improve this", "tweak the layout", or "adjust colors" are dispatched directly to the frontend-developer agent — no full pipeline needed.

5. **Decline non-design requests**: Backend bugs, SQL queries, server logic, math, weather, and medical advice are outside your scope. Politely note your design-only focus and ask if the user has a design task.

When asked "what can you do?", "who are you?", "how do you work?", or any capability question, describe yourself as the Allen Design Router and explain these five capabilities. Do NOT give a generic AI assistant answer.
Keep all responses concise, friendly, and helpful.`;

// ── Service ────────────────────────────────────────────────────────────────

export class DesignRoutingService {
  private db: Db;
  private router = new DesignRouter();

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Resolve the routing decision for a design session.
   *
   * Priority order per TDD §2.1 (REQ-015):
   *   1. User override wins first
   *   2. Classify prompt intent via DesignRouter
   *      - direct   → answer inline (greeting / ack / capability question)
   *      - workflow → full design-generation pipeline
   *      - frontend → frontend-developer agent
   *      - unsupported_non_design → direct (out-of-scope reply)
   */
  async resolveRoute(session: DesignSession, overrideKey?: string, prompt?: string): Promise<DesignRoutingDecision> {
    const hasExistingContext = !!(session.workspaceId || session.hasExistingOutputs);
    const outputMode = session.outputMode ?? 'spec_only';
    const normalizedPrompt = (prompt ?? '').trim();

    // Conversational prompts (greetings, acks, identity Qs, non-design) always direct-answer,
    // even when an explicit override is active. The empty-prompt gate (length < 3)
    // preserves existing behavior: override wins when no message has been typed yet.
    if (normalizedPrompt.length >= 3) {
      const convClassification = this.router.classify(normalizedPrompt, undefined, { hasExistingContext });
      if (convClassification.route === 'direct') {
        return {
          mode: 'direct',
          resolvedBy: 'auto',
          reason: convClassification.reason,
          outputMode,
        };
      }
      if (convClassification.route === 'unsupported_non_design') {
        return {
          mode: 'direct',
          resolvedBy: 'auto',
          reason: convClassification.reason,
          outputMode,
        };
      }
    }

    // Override wins for substantive (non-conversational) prompts and for
    // empty-prompt UI state (user has mode selected but hasn't typed yet).
    if (overrideKey && overrideKey !== 'auto') {
      return this.resolveOverride(session, overrideKey);
    }

    // Auto-classify the prompt intent via DesignRouter.
    // hasExistingContext gates whether refinement prompts go to frontend-developer.
    const classification = this.router.classify(prompt ?? '', overrideKey, { hasExistingContext });

    if (classification.route === 'direct' || classification.route === 'unsupported_non_design') {
      return {
        mode: 'direct',
        resolvedBy: 'auto',
        reason: classification.reason,
        outputMode,
      };
    }

    if (classification.route === 'workflow') {
      return {
        mode: 'workflow',
        workflowName: 'source-prd-to-ui-designs-variations',
        resolvedBy: 'auto',
        reason: classification.reason,
        outputMode,
        needsConfirmation: classification.needsConfirmation ?? true,
      };
    }

    // frontend
    return {
      mode: 'agent',
      agentName: 'frontend-developer',
      resolvedBy: 'auto',
      reason: classification.reason,
      outputMode,
    };
  }

  /**
   * Resolve an explicit user override key to a routing decision.
   * AC-011 override map.
   */
  private resolveOverride(session: DesignSession, overrideKey: string): DesignRoutingDecision {
    const outputMode = session.outputMode ?? 'spec_only';
    switch (overrideKey) {
      case 'full_workflow':
        return {
          mode: 'workflow',
          workflowName: 'source-prd-to-ui-designs-variations',
          resolvedBy: 'user_override',
          reason: 'User selected full design workflow',
          outputMode,
          overrideKey: 'full_workflow',
        };
      case 'fast_frontend':
        return {
          mode: 'agent',
          agentName: 'frontend-developer',
          resolvedBy: 'user_override',
          reason: 'User selected fast frontend',
          outputMode,
          overrideKey: 'fast_frontend',
        };
      case 'design_refinement':
        return {
          mode: 'agent',
          // Fallback to frontend-developer if design-iteration-refiner agent not found
          agentName: 'design-iteration-refiner',
          resolvedBy: 'user_override',
          reason: 'User selected design refinement',
          outputMode,
          overrideKey: 'design_refinement',
        };
      case 'design_review':
        return {
          mode: 'agent',
          agentName: 'design-critic',
          resolvedBy: 'user_override',
          reason: 'User selected design review',
          outputMode,
          overrideKey: 'design_review',
        };
      default: {
        const err = new Error(`Unknown routing override key: ${overrideKey}`) as Error & { code: string };
        err.code = 'DESIGN_ROUTING_OVERRIDE_UNKNOWN';
        throw err;
      }
    }
  }

  /**
   * Dispatch a routing decision to the appropriate execution mechanism.
   *
   * For mode='workflow': finds the workflow by name and starts an execution
   * via ExecutionService.start().
   *
   * For mode='agent': spawns the agent via the internal chat/spawn-agent
   * endpoint using a direct HTTP call.
   *
   * For mode='direct': answers immediately via LLM (design assistant), no agent
   * or workflow is spawned.
   */
  async dispatch(
    decision: DesignRoutingDecision,
    options: {
      prompt: string;
      designRepoPath?: string;
      sourceRepoPath?: string;
      designSessionId: string;
      messageId: string;
    },
  ): Promise<{ executionId?: string; agentRunId?: string; directResponse?: string }> {
    if (decision.mode === 'workflow') {
      return this.dispatchWorkflow(decision, options);
    }
    if (decision.mode === 'direct') {
      return this.dispatchDirect(options);
    }
    return this.dispatchAgent(decision, options);
  }

  private async dispatchWorkflow(
    decision: DesignRoutingDecision,
    options: {
      prompt: string;
      designRepoPath?: string;
      sourceRepoPath?: string;
      designSessionId: string;
      messageId: string;
    },
  ): Promise<{ executionId?: string }> {
    const workflowName = decision.workflowName;
    if (!workflowName) {
      throw Object.assign(new Error('Workflow name missing from routing decision'), { code: 'DESIGN_DISPATCH_FAILED' });
    }

    const workflow = await this.db.collection('workflows').findOne({ name: workflowName });
    if (!workflow) {
      throw Object.assign(
        new Error(`Workflow not found: ${workflowName}`),
        { code: 'DESIGN_DISPATCH_FAILED', details: { workflowName } },
      );
    }

    const { ExecutionService } = await import('./execution.service.js');
    const execService = new ExecutionService(this.db);

    const workflowInput: Record<string, unknown> = {
      requirement_or_prd: options.prompt,
      prd_slug: options.designSessionId,
      output_mode: decision.outputMode,
      design_session_id: options.designSessionId,
    };
    if (options.designRepoPath) {
      workflowInput.repo_path = options.designRepoPath;
      workflowInput.design_repo_path = options.designRepoPath;
    }
    if (options.sourceRepoPath) {
      workflowInput.source_repo_path = options.sourceRepoPath;
    }

    // Try to infer source_repo_path from prompt if not already set
    if (!workflowInput.source_repo_path) {
      const inferred = await this.inferSourceRepo(options.prompt, this.db);
      if (inferred) workflowInput.source_repo_path = inferred;
    }

    // Validate required workflow inputs before dispatching.
    // If source_repo_path or repo_path are missing, return a user-friendly
    // clarification instead of letting the engine throw a raw schema error.
    const missingInputs: string[] = [];
    if (!workflowInput.source_repo_path) missingInputs.push('source_repo_path');
    if (!workflowInput.repo_path) missingInputs.push('repo_path');

    if (missingInputs.length > 0) {
      const parts: string[] = [
        "I'd love to generate design variations for you! To do that I need a bit more information:",
      ];
      if (!workflowInput.source_repo_path) {
        parts.push("\n\n• **Source repository** — which code repo should the designs be based on? Please set a source repo for this session (use the source repo selector in the Design context controls).");
      }
      if (!workflowInput.repo_path) {
        parts.push("\n\n• **Design repository** — no design repo path could be resolved. Please configure a design repo in the Design tab settings.");
      }
      parts.push("\n\nOnce those are set, I'll be ready to generate your designs!");
      const clarification = parts.join('');
      throw Object.assign(new Error(clarification), {
        code: 'DESIGN_MISSING_WORKFLOW_INPUTS',
        clarification,
        missingInputs,
      });
    }

    const result = await execService.start(workflow._id.toString(), workflowInput, {});
    const executionId = (result.id ?? result.executionId) as string | undefined;

    // REQ-031 / REQ-013 — stamp sourceSurface and designSessionId on the execution record
    if (executionId) {
      await this.db.collection('executions').updateOne(
        { id: executionId },
        { $set: { 'meta.sourceSurface': 'design_tab', 'meta.designSessionId': options.designSessionId } },
      );
    }

    console.info('[design] workflow dispatched', {
      workflowName,
      executionId,
      designSessionId: options.designSessionId,
    });

    return { executionId };
  }

  private async dispatchAgent(
    decision: DesignRoutingDecision,
    options: {
      prompt: string;
      designRepoPath?: string;
      sourceRepoPath?: string;
      designSessionId: string;
      messageId: string;
    },
  ): Promise<{ agentRunId?: string }> {
    const agentName = decision.agentName;
    if (!agentName) {
      throw Object.assign(new Error('Agent name missing from routing decision'), { code: 'DESIGN_DISPATCH_FAILED' });
    }

    // Build the spawn prompt with available context
    const spawnPrompt = [
      options.prompt,
      options.designRepoPath ? `\nDesign repo: ${options.designRepoPath}` : '',
      options.sourceRepoPath ? `\nSource repo (read-only): ${options.sourceRepoPath}` : '',
      `\nDesign session ID: ${options.designSessionId}`,
    ]
      .filter(Boolean)
      .join('');

    // Spawn the agent via internal HTTP call to the Allen API.
    // We use the ALLEN_INTERNAL_API_URL env var which is set at server start.
    const internalApiUrl = process.env.ALLEN_INTERNAL_API_URL ?? 'http://localhost:4023';
    const spawnUrl = `${internalApiUrl}/api/chat/spawn-agent`;

    let agentRunId: string | undefined;
    try {
      const response = await fetch(spawnUrl, {
        method: 'POST',
        // buildInternalApiHeaders() mints a short-lived signed JWT so this
        // server-to-server call passes the requireAuth middleware (fixes 401).
        headers: buildInternalApiHeaders(),
        body: JSON.stringify({
          agent_name: agentName,
          prompt: spawnPrompt,
          context_query: {
            designSessionId: options.designSessionId,
            sourceSurface: 'design_tab',
          },
          repo_path: options.designRepoPath,
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw Object.assign(
          new Error(`Agent spawn failed (${response.status}): ${body}`),
          { code: 'DESIGN_DISPATCH_FAILED' },
        );
      }

      const data = await response.json() as Record<string, unknown>;
      agentRunId = (data.execution_id ?? data.executionId ?? data.agentRunId ?? data.id) as string | undefined;

      // REQ-031 / REQ-013 — stamp sourceSurface and designSessionId on the agent execution record
      if (agentRunId) {
        try {
          await this.db.collection('executions').updateOne(
            { id: agentRunId },
            { $set: { 'meta.sourceSurface': 'design_tab', 'meta.designSessionId': options.designSessionId } },
          );
        } catch {
          // Non-blocking — agent run may not yet be persisted; session meta is sufficient
        }
      }
    } catch (err: unknown) {
      if ((err as any).code === 'DESIGN_DISPATCH_FAILED') throw err;
      throw Object.assign(
        new Error(`Agent dispatch failed: ${(err as Error).message}`),
        { code: 'DESIGN_DISPATCH_FAILED' },
      );
    }

    console.info('[design] agent dispatched', {
      agentName,
      agentRunId,
      designSessionId: options.designSessionId,
    });

    return { agentRunId };
  }

  private async dispatchDirect(
    options: { prompt: string; designSessionId: string; messageId: string },
  ): Promise<{ directResponse: string }> {
    const normalized = options.prompt.trim();

    // Minimal safety gate: empty/very short → instant response, skip LLM
    if (normalized.length < 3) {
      return { directResponse: 'Hello! How can I help you with your design work today?' };
    }

    let response = '';
    try {
      const provider = getDefaultChatProvider();
      await runChatLLM(this.db, {
        provider,
        systemPrompt: DESIGN_ROUTER_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: options.prompt }],
        skipTools: true,
        onText: (text: string) => { response = text; },
        onToolStart: () => {},
        onToolResult: () => {},
      });
    } catch (err: unknown) {
      console.error('[design] LLM direct response failed, using fallback', (err as Error).message);
    }

    return {
      directResponse:
        response.trim() ||
        "I'm the Allen Design Router. I can help you generate UI designs, refine existing designs, or answer design questions. What would you like to work on?",
    };
  }

  /**
   * Infer source repo path from prompt keywords by matching against registered repos.
   * Best-effort: returns null if no match or on any error.
   */
  private async inferSourceRepo(
    prompt: string,
    db: import('mongodb').Db,
  ): Promise<string | null> {
    try {
      const repos = await db.collection('repos').find({}, { projection: { name: 1, path: 1 } }).toArray() as unknown as Array<{ name: string; path: string }>;
      const normalized = prompt.toLowerCase();
      for (const repo of repos) {
        if (!repo.name || !repo.path) continue;
        const repoName = repo.name.toLowerCase();
        if (normalized.includes(repoName)) return repo.path;
        const spacedName = repoName.replace(/-/g, ' ');
        if (spacedName !== repoName && normalized.includes(spacedName)) return repo.path;
      }
    } catch {
      // Non-blocking
    }
    return null;
  }
}
