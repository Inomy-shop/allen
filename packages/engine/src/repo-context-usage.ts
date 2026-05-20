import type { NodeDef } from './types.js';
import type { ToolCallRecord } from './tool-call.js';

const ENABLE_REPO_CONTEXT_LOADING_COMPLIANCE_RETRY = false;

interface RepoKnowledgeContextForUsage {
  packetId?: string;
}

export function withRepoContextUsageOutput(nodeDef: NodeDef): NodeDef {
  if (nodeDef.output_format === 'freeform') return nodeDef;
  const outputs = { ...(nodeDef.outputs ?? {}) };
  if (!outputs.repo_context_usage) {
    outputs.repo_context_usage = 'Repo context usage report following the injected system repo_context_usage contract.';
  }
  return { ...nodeDef, outputs };
}

export function shouldRetryForRepoContextLoadingCompliance(
  outputs: Record<string, unknown>,
  rawResponse: string | undefined,
  toolCalls: ToolCallRecord[],
  repoKnowledgeContext: RepoKnowledgeContextForUsage | undefined,
  sessionId?: string,
): boolean {
  if (!ENABLE_REPO_CONTEXT_LOADING_COMPLIANCE_RETRY) return false;
  if (!repoKnowledgeContext?.packetId || !sessionId) return false;
  if (toolCalls.some(isRepoContextLoaderToolCall)) return false;
  const usage = findRepoContextUsage(outputs) ?? findRepoContextUsageInText(rawResponse);
  if (!usage) return false;
  if (normalizeUsageRows(usage.context_loaded).length > 0 || normalizeUsageRows(usage.context_applied).length > 0) {
    return true;
  }
  return [...normalizeUsageRows(usage.context_preselected), ...normalizeUsageRows(usage.context_summary_used)]
    .some((row) => contextUsageReasonImpliesReliance(row));
}

export function isRepoContextLoaderToolCall(call: ToolCallRecord): boolean {
  const tool = String(call.tool ?? '');
  return tool === 'get_repo_context_body' ||
    tool === 'get_repo_skill_body' ||
    tool.endsWith('__get_repo_context_body') ||
    tool.endsWith('__get_repo_skill_body');
}

export function buildRepoContextLoadingCompliancePrompt(requiredOutputs: string[], outputs: Record<string, unknown>): string {
  const previous = JSON.stringify(outputs, null, 2).slice(0, 12000);
  return `Repo context loading compliance retry.

Your previous response reported or relied on repo context selection/summary, but this session has no recorded Allen MCP body-loader calls.

Before finalizing:
- Review the repo context selection already present in this session.
- For every selected ref, summary, skill, production note, instruction file, doc, runbook, or Cognee ref that is relevant enough to influence your reasoning, code, tests, QA, review, or docs, call get_repo_context_body or get_repo_skill_body and read the complete body.
- If selected context is insufficient, call search_repo_knowledge, then load any relevant returned full body.
- If a ref is not relevant, do not load it; put it in context_skipped with a clear reason.
- Do not report Read/Grep/source-code inspection as context_loaded.
- Report context_loaded/context_applied only for successful get_repo_context_body/get_repo_skill_body calls.

Previous extracted output:
\`\`\`json
${previous}
\`\`\`

Respond with ONLY a JSON code block. Include any keys you need to correct. Required workflow output keys are:
${requiredOutputs.map((key) => `- ${key}`).join('\n')}

It is acceptable to return only repo_context_usage if the other outputs remain unchanged.`;
}

export function findRepoContextUsage(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 8 || typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.repo_context_usage === 'object' && record.repo_context_usage !== null) {
    return record.repo_context_usage as Record<string, unknown>;
  }
  if ('context_preselected' in record || 'context_summary_used' in record || 'context_loaded' in record || 'context_applied' in record) {
    return record;
  }
  for (const child of Object.values(record)) {
    const found = findRepoContextUsage(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

export function findRepoContextUsageInText(rawResponse?: string): Record<string, unknown> | undefined {
  if (!rawResponse) return undefined;
  for (const match of rawResponse.matchAll(/```json\s*([\s\S]*?)```/gi)) {
    try {
      const parsed = JSON.parse(match[1]);
      const usage = findRepoContextUsage(parsed);
      if (usage) return usage;
    } catch {}
  }
  const body = rawResponse.match(/\{[\s\S]*\}/)?.[0];
  if (body) {
    try {
      return findRepoContextUsage(JSON.parse(body));
    } catch {}
  }
  return undefined;
}

function normalizeUsageRows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    : [];
}

function contextUsageReasonImpliesReliance(row: Record<string, unknown>): boolean {
  const text = String(row.reason ?? row.summary ?? row.value ?? '').toLowerCase();
  if (!text) return false;
  if (/not relevant|irrelevant|skipped|did not rely|not relied|relevance only|triage only|orientation only|not used for final/.test(text)) {
    return false;
  }
  return /reviewed|confirmed|used|inspected|scanned|followed|applied|pointed|directed|influence|must follow|loaded via read|loaded actual file|final work/.test(text);
}
