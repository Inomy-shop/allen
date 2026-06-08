/**
 * OrchestratorDispatchAdapter — injectable adapter for spawning the orchestrator agent.
 *
 * Keeps the spawn mechanism swappable so tests and offline environments can use
 * NullOrchestratorDispatchAdapter while production uses AllenSpawnOrchestratorDispatchAdapter.
 */

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface OrchestratorDispatchRequest {
  runId: string;
  triggeredBy: string;
  repoId?: string;
  repoIds?: string[];
  global: boolean;
}

export interface OrchestratorDispatchResult {
  executionId?: string;
  queued: boolean;
  error?: string;
}

export interface IOrchestratorDispatchAdapter {
  dispatch(request: OrchestratorDispatchRequest): Promise<OrchestratorDispatchResult>;
}

// ─── NullOrchestratorDispatchAdapter ─────────────────────────────────────────

/**
 * Used in tests and when no agent runtime is available.
 * Performs no side effects; always returns { queued: false }.
 */
export class NullOrchestratorDispatchAdapter implements IOrchestratorDispatchAdapter {
  async dispatch(_request: OrchestratorDispatchRequest): Promise<OrchestratorDispatchResult> {
    return { queued: false };
  }
}

// ─── AllenSpawnOrchestratorDispatchAdapter ────────────────────────────────────

/**
 * Calls ALLEN_AGENT_SPAWN_URL (passed as constructor arg) to spawn
 * the context-judge-orchestrator in the Allen runtime.
 */
export class AllenSpawnOrchestratorDispatchAdapter implements IOrchestratorDispatchAdapter {
  private spawnUrl: string;

  constructor(spawnUrl: string) {
    this.spawnUrl = spawnUrl;
  }

  async dispatch(request: OrchestratorDispatchRequest): Promise<OrchestratorDispatchResult> {
    const prompt = buildOrchestratorPrompt(request);
    const response = await fetch(this.spawnUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentName: 'context-judge-orchestrator', prompt }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    return {
      executionId: body['executionId'] as string | undefined,
      queued: true,
    };
  }
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

/**
 * Build a structured prompt for the orchestrator agent based on the run record.
 */
function buildOrchestratorPrompt(request: OrchestratorDispatchRequest): string {
  const scopeDescription = request.repoId
    ? `Repo-scoped scan: repoId=${request.repoId}`
    : request.repoIds?.length
    ? `Multi-repo scan: repoIds=${request.repoIds.join(',')}`
    : 'Global scan across all repos';

  return [
    `Context Judge Orchestrator Run: runId=${request.runId}`,
    `Triggered by: ${request.triggeredBy}`,
    `Scope: ${scopeDescription}`,
    ``,
    `Use mcp__allen__spawn_agent as the primary mechanism to launch worker agents.`,
    `Scan pending sources, evaluate context quality, create findings, cluster into review tasks, assign eligible tasks to worker agents.`,
    `Update the run record (runId=${request.runId}) via the API as you progress.`,
  ].join('\n');
}
