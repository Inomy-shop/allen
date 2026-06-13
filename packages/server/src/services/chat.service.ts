/**
 * Chat Service
 * Manages chat sessions with tool-calling via Claude Code SDK (no API key needed).
 * Phase 3-4: Workflow execution + agent spawning
 * Phase 5-6: Database queries, debugging, dashboard stats
 */

import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import type { TokenUsageInfo } from '@allen/engine';
import type { Response } from 'express';
import { PROVIDERS, runChatLLM, type ChatLLMMessage, type ChatProvider } from './chat-llm.js';
import { getDefaultChatModel, getDefaultChatProvider, getEnabledProvidersInDefaultOrder, getEnabledProvidersFromRegistry, getTitleGenProviderModel, isClaudeCompatibleProvider, isClaudeFamilyProvider } from './chat-providers.js';
import { resolveAgentSettings, type AgentLike, type AgentOverrides, type ResolvedSettings } from './agent-settings.js';
import { buildPlannerSystemPrompt, selectChatPersona, type ChatPersona } from './chat-persona.js';
import { AlertService } from './alert.service.js';
import { registerActiveSession, unregisterActiveSession, waitForBackgroundTasks } from './chat-tools.js';
import { resolveCostUsd } from './model-cost.service.js';
import { CostRollupService } from './cost-rollup.service.js';
import { searchSimilar, backfillEmbeddings } from './embedding.service.js';
import { buildOrgContextBlock } from './org-context.js';
import { MonitoringService } from './self-healing-monitor.service.js';
import { ExecutionService } from './execution.service.js';
import { LinearService } from './linear.service.js';
import { runPersistentChatSlashCommand } from './chat-runtime-manager.js';
import { listSlashCommands, type SlashCommandInfo } from './slash-commands.js';
import type { RuntimeSlashCommand } from './chat-runtime-types.js';
import { ChatContextPacketService } from './context/core/chat-context-packet.service.js';
// Note: embedding.service.ts re-exports from @allen/engine — single implementation shared by engine + server

// ── Types ──

export interface SlackContext {
  channelId: string;
  threadTs: string;
  teamId: string;
}

export interface ArchivedWorkspaceSnapshot {
  id: string;
  name?: string;
  repoId?: string;
  repoName?: string;
  repoPath?: string;
  branch?: string;
  baseBranch?: string;
  prNumber?: number;
  prUrl?: string;
  archivedAt?: Date;
}

export interface ChatSession {
  _id?: ObjectId;
  title: string;
  titleSource?: 'default' | 'auto' | 'user';
  titleRefreshedAt?: Date;
  status: 'active' | 'archived';
  messageCount: number;
  lastMessageAt: Date;
  totalCostUsd: number;
  provider: ChatProvider;
  model?: string;
  llmSessionId?: string;
  source?: 'ui' | 'slack' | 'automation';
  automationKey?: string;
  slackContext?: SlackContext;
  repoId?: string;     // ObjectId string referencing repos collection
  repoPath?: string;   // Snapshot of repo.path at session creation time
  repoName?: string;   // Snapshot of repo.name for UI display
  workspaceId?: string;
  workspaceName?: string;
  workspaceRepoId?: string;
  workspaceRepoName?: string;
  workspaceBranch?: string;
  workspaceBaseBranch?: string;
  workspacePrNumber?: number;
  workspacePrUrl?: string;
  streaming?: boolean;
  archivedWorkspace?: ArchivedWorkspaceSnapshot;
  ownerUserId?: string | null;
  ownerName?: string | null;
  ownerEmail?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatMessage {
  _id?: ObjectId;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'completed' | 'streaming' | 'failed' | 'interrupted';
  senderUserId?: string;
  senderName?: string;
  senderEmail?: string;
  senderSource?: 'ui' | 'slack' | 'system';
  costUsd?: number;
  durationMs?: number;
  tokenUsage?: TokenUsageInfo | null;
  numTurns?: number;
  error?: string;
  toolCalls?: ToolCallRecord[];
  thinkingText?: string;
  createdAt: Date;
  completedAt?: Date;
}

function archivedWorkspaceSnapshot(workspace: Record<string, unknown>): ArchivedWorkspaceSnapshot {
  return {
    id: String(workspace._id ?? workspace.id ?? ''),
    name: typeof workspace.name === 'string' ? workspace.name : undefined,
    repoId: typeof workspace.repoId === 'string' ? workspace.repoId : undefined,
    repoName: typeof workspace.repoName === 'string' ? workspace.repoName : undefined,
    repoPath: typeof workspace.repoPath === 'string' ? workspace.repoPath : undefined,
    branch: typeof workspace.branch === 'string' ? workspace.branch : undefined,
    baseBranch: typeof workspace.baseBranch === 'string' ? workspace.baseBranch : undefined,
    prNumber: typeof workspace.prNumber === 'number' ? workspace.prNumber : undefined,
    prUrl: typeof workspace.prUrl === 'string' ? workspace.prUrl : undefined,
    archivedAt: workspace.updatedAt instanceof Date ? workspace.updatedAt : undefined,
  };
}

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  durationMs: number;
  timestamp: Date;
  toolUseId?: string;
}

export interface ChatMessageSender {
  userId?: string;
  name?: string;
  email?: string;
  source?: 'ui' | 'slack' | 'system';
}

export type ChatQueueStatus = 'queued' | 'editing' | 'running' | 'sent' | 'failed' | 'cancelled';

export interface ChatQueueItem {
  _id?: ObjectId;
  id?: string;
  sessionId: string;
  content: string;
  agent?: string | null;
  cwd?: string | null;
  status: ChatQueueStatus;
  sender?: ChatMessageSender;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

function senderFields(sender?: ChatMessageSender): Pick<ChatMessage, 'senderUserId' | 'senderName' | 'senderEmail' | 'senderSource'> {
  if (!sender) return {};
  return {
    ...(sender.userId ? { senderUserId: sender.userId } : {}),
    ...(sender.name ? { senderName: sender.name } : {}),
    ...(sender.email ? { senderEmail: sender.email } : {}),
    ...(sender.source ? { senderSource: sender.source } : {}),
  };
}

function parseSlashCommandText(content: string): { name: string; args: string; raw: string } | null {
  const trimmed = content.trim();
  const match = trimmed.match(/^(\/[^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { name: match[1], args: match[2] ?? '', raw: trimmed };
}

function resolveSlashCommand(content: string, commands: SlashCommandInfo[]): RuntimeSlashCommand | null {
  const parsed = parseSlashCommandText(content);
  if (!parsed) return null;
  const command = commands.find(item => item.name === parsed.name);
  if (!command || !command.dispatchable) return null;
  return {
    name: command.name,
    raw: parsed.raw,
    args: parsed.args,
    kind: command.kind,
    path: command.path,
  };
}

// ── SSE Helper ──

function sendSSE(res: Response, event: string, data: unknown): void {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch { /* client disconnected */ }
}

// ── Mention Resolution ──

export async function resolveMentions(content: string, db: Db): Promise<{ context: string; repoPath?: string }> {
  const mentionRegex = /@([\w-]+)/g;
  const matches = [...content.matchAll(mentionRegex)];
  if (matches.length === 0) return { context: '' };

  // ── Linear ticket resolution (checked FIRST, before workflow/repo/agent) ──
  let linearContext = '';
  {
    const identifierPattern = /^[A-Z]+-\d+$/;
    // Preserve match order, deduplicate, cap at 3
    const identifiers = new Set<string>();
    for (const m of matches) {
      if (identifierPattern.test(m[1])) {
        identifiers.add(m[1]);
        if (identifiers.size >= 3) break;
      }
    }
    let resolvedCount = 0;
    let skippedCount = 0;
    if (identifiers.size > 0) {
      const linearSvc = new LinearService(db);
      // Sequential — not parallel — to stay within Linear API rate limits (NFR-007).
      for (const identifier of identifiers) {
        try {
          const detail = await linearSvc.getIssue(identifier);
          if (!detail) {
            skippedCount++;
            continue;
          }
          const description = (detail.fullDescription ?? detail.description ?? '').slice(0, 800);
          linearContext += `\n[LINEAR TICKET: ${detail.identifier}] Title: ${detail.title}\nURL: ${detail.url}\nDescription: ${description}\n`;
          resolvedCount++;
        } catch {
          skippedCount++;
        }
      }
    }
    console.log(`[linear:resolveMentions] tokens=${identifiers.size} resolved=${resolvedCount} skipped=${skippedCount} cap=3`);
  }

  const names = [...new Set(matches.map(m => m[1]))];
  let context = linearContext;
  let repoPath: string | undefined;

  const _identifierPattern = /^[A-Z]+-\d+$/;
  for (const name of names) {
    // Skip Linear ticket identifiers — already resolved in the Linear branch above.
    // This prevents unnecessary workflow/repo/agent DB lookups for ticket IDs (EC-009).
    if (_identifierPattern.test(name)) continue;
    const wf = await db.collection('workflows').findOne({ name, archived: { $ne: true } });
    if (wf) {
      const nodeNames = wf.parsed?.nodes ? Object.keys(wf.parsed.nodes).join(', ') : 'none';
      const inputDef = wf.parsed?.input;
      const inputs = inputDef
        ? Object.entries(inputDef).map(([k, v]: [string, any]) => `${k}(${v.type}${v.required ? ', required' : ''})`).join(', ')
        : 'none';
      context += `\n[WORKFLOW: ${name}] ${wf.description ?? ''}\nID: ${(wf._id as ObjectId).toString()}\nNodes: ${nodeNames}\nInputs: ${inputs}\n`;
      continue;
    }
    const repo = await db.collection('repos').findOne({ name });
    if (repo) {
      context += `\n[REPO: ${name}] Path: ${repo.path}\nLanguage: ${(repo.detected?.language ?? []).join(', ')}\nFramework: ${(repo.detected?.framework ?? []).join(', ')}\nBranch: ${repo.detected?.defaultBranch ?? 'unknown'}\n`;
      if (!repoPath) repoPath = repo.path as string; // Use first mentioned repo as cwd
      continue;
    }
    const agent = await db.collection('agents').findOne({ name });
    if (agent) {
      context += `\n[AGENT: ${name}] Provider: ${agent.provider ?? 'claude'}\nModel: ${agent.model ?? 'default'}\nTools: ${(agent.tools ?? []).join(', ')}\nSystem: ${(agent.system ?? '').slice(0, 200)}\n`;
    }
  }
  return { context, repoPath };
}

// ── System Prompt ──

const API_PORT = process.env.PORT ?? '4023';

/**
 * System prompt varies by provider:
 * - claude-cli: uses <tool_call> protocol (appended by chat-llm.ts)
 * - codex: uses bash + curl against local API
 */
async function writeMemoryAudit(db: Db, input: {
  rootType: 'chat' | 'workflow_execution' | 'agent_execution';
  rootId: string;
  agentName?: string;
  query?: string;
  retrievedLearningIds?: string[];
  retrievalScores?: number[];
  injectedLearningIds?: string[];
  injectedTokenCount?: number;
  promptContextHash?: string;
  error?: string;
}): Promise<void> {
  try {
    await db.collection('memory_injection_audits').insertOne({
      ...input,
      retrievedLearningIds: input.retrievedLearningIds ?? [],
      retrievalScores: input.retrievalScores ?? [],
      injectedLearningIds: input.injectedLearningIds ?? [],
      injectedTokenCount: input.injectedTokenCount ?? 0,
      createdAt: new Date(),
    });
  } catch {
    // Monitoring data must never block prompt construction.
  }
}

function learningId(value: unknown): string | null {
  const id = (value as { _id?: unknown; id?: unknown })?._id ?? (value as { id?: unknown })?.id;
  return id ? String(id) : null;
}

function hasToolError(resultData: unknown): boolean {
  const text = typeof resultData === 'string' ? resultData : JSON.stringify(resultData ?? {});
  return /\b(error|failed|exception|timeout|timed out|invalid|missing|denied|not found)\b/i.test(text);
}

function isReportToUserTool(tool: string): boolean {
  return tool === 'report_to_user' || tool.endsWith('__report_to_user');
}

function reportToUserPayload(resultData: unknown): { message: string; status: string } | null {
  if (!resultData || typeof resultData !== 'object') return null;
  const result = resultData as Record<string, unknown>;
  const message = typeof result.message === 'string' ? result.message.trim() : '';
  if (!message) return null;
  const status = typeof result.status === 'string' ? result.status : 'in_progress';
  return { message, status };
}

async function getSystemPrompt(
  provider: ChatProvider,
  db: Db,
  userMessage?: string,
  auditContext?: { rootType: 'chat'; rootId: string; agentName?: string },
  persona: 'assistant' | 'planner' = 'assistant',
): Promise<string> {
  // Load relevant learnings using embedding similarity search
  let learningsBlock = '';
  try {
    // Backfill embeddings for any learnings that don't have them
    await backfillEmbeddings(db);

    if (userMessage) {
      // Semantic search — find learnings most relevant to the user's message
      const results = (await searchSimilar(db, userMessage, { limit: 10, threshold: 0.35 })).slice(0, 5);
      if (results.length > 0) {
        const items = results.map(l => `- [${l.type}] (relevance: ${(l.score * 100).toFixed(0)}%) ${l.content}`).join('\n');
        learningsBlock = `\n\n## Memory from previous conversations\nApply these learned preferences and facts:\n${items}`;
      }
      if (auditContext?.rootId) {
        await writeMemoryAudit(db, {
          rootType: auditContext.rootType,
          rootId: auditContext.rootId,
          agentName: auditContext.agentName ?? 'assistant',
          query: userMessage,
          retrievedLearningIds: results.map(learningId).filter((id): id is string => Boolean(id)),
          retrievalScores: results.map((l) => l.score),
          injectedLearningIds: results.map(learningId).filter((id): id is string => Boolean(id)),
          injectedTokenCount: Math.ceil(results.map((l) => l.content).join(' ').split(/\s+/).length * 1.3),
          promptContextHash: Buffer.from(userMessage).toString('base64').slice(0, 64),
        });
      }
    } else {
      // No message context — load top preferences
      const prefs = await db.collection('learnings')
        .find({ status: 'active', tags: 'chat', type: 'preference' })
        .sort({ confidence: -1 })
        .limit(5)
        .toArray();
      if (prefs.length > 0) {
        const items = prefs.map(l => `- [${l.type}] ${l.content}`).join('\n');
        learningsBlock = `\n\n## Memory from previous conversations\nApply these learned preferences and facts:\n${items}`;
      }
      if (auditContext?.rootId) {
        await writeMemoryAudit(db, {
          rootType: auditContext.rootType,
          rootId: auditContext.rootId,
          agentName: auditContext.agentName ?? 'assistant',
          retrievedLearningIds: prefs.map(learningId).filter((id): id is string => Boolean(id)),
          injectedLearningIds: prefs.map(learningId).filter((id): id is string => Boolean(id)),
          injectedTokenCount: Math.ceil(prefs.map((l) => String(l.content ?? '')).join(' ').split(/\s+/).length * 1.3),
        });
      }
    }
  } catch (err) {
    console.error('\x1b[35m[embedding]\x1b[0m Failed to load learnings:', (err as Error).message);
    if (auditContext?.rootId) {
      await writeMemoryAudit(db, {
        rootType: auditContext.rootType,
        rootId: auditContext.rootId,
        agentName: auditContext.agentName ?? 'assistant',
        query: userMessage,
        error: (err as Error).message,
      });
    }
  }

  const base = `You are Allen Assistant — the intelligent command center for the Allen workflow orchestration platform.
When users mention @workflow-name, @repo-name, or @agent-name, you receive context about those resources. Use this to answer or fill in parameters automatically.
Be concise, natural, and technical. Use markdown when it improves readability.
Include real resource IDs only when they help the user take action, disambiguate a resource, or continue a workflow. Do not create artificial tracking IDs, issue IDs, labels, or codes in normal chat responses.

═══ RESOURCE LINKS — HARD RULE ═══
Every time you reference an external resource in your response, render it as a clickable markdown link. NEVER just quote an ID or name — always make it clickable. This applies to:

- **Pull requests / MRs** → \`[#123 — Fix login race](https://github.com/org/repo/pull/123)\`. Use the \`html_url\` field from the GitHub MCP / \`gh\` response; never invent a URL.
- **GitHub / Linear / Jira issues and tickets** → \`[LIN-456 — Add billing guardrails](https://linear.app/workspace/issue/LIN-456)\`. Pull the exact URL from the tool response; don't reconstruct it by hand.
- **Uploaded files** (anything you created via \`upload_file\`) → \`[deployment-plan.md](<publicUrl>)\`. The \`upload_file\` tool returns a \`publicUrl\` that is viewable without login — use that URL verbatim. Never paste the raw file contents when a link will do.
- **Artifacts** (anything you created via \`allen_save_artifact\`) → \`[plan.md](<publicUrl>)\`. PREFER \`allen_save_artifact\` over \`upload_file\` when the file belongs to this conversation — plans, designs, query result CSVs, config JSON, investigation notes. Artifacts appear in the chat's Artifacts panel, are filed under this session, auto-render in the UI (markdown / JSON / CSV / text), and can be listed later with \`allen_list_artifacts\`. Use \`upload_file\` only for one-off shares destined for Slack / email / outside the chat. When spawning sub-agents via \`spawn_agent\`, remind them to save their own work the same way — their artifacts inherit this chat as the root.
- **Workflow runs, executions, agents, chat sessions** → link to the Allen UI route for that resource when you know it.
- **Slack messages, commits, CI runs, deploy URLs, dashboards** → always link, never just name.

If a tool call returned an external resource but no URL is visible to you, ASK the tool result for one (\`html_url\`, \`permalink\`, \`url\`, \`publicUrl\`) before giving up. For Allen internal resources, prefer a clickable UI link when the tool provides one or when the route is known with confidence. If no UI URL is available, present the resource by clear human-readable name/status/type and include the raw ID only when it is needed for follow-up, debugging, or disambiguation. Do not tell the user that a tool did not return a URL, and do not expose internal tool limitations, field names, or fallback reasoning.

Listing multiple resources? Render as a bulleted list of links, one per line, so the user can scan and click directly. Never hide a link behind prose like "I've opened a PR for this" with no link attached.

IMPORTANT RULES:
1. You are the routing brain. Decide from the user's intent whether to answer directly, inspect data with tools, run a workflow, or spawn the best matching agent/lead. Do not rely on a backend heuristic router.
2. When the user corrects you or states a preference ("no, use staging DB", "always run tests first", "I prefer TypeScript"), silently call save_learning to remember it. Write it as a generalized rule. Don't tell the user you're saving — just do it.
3. Evidence-first rule: do not make claims about a repository's existing implementation, supported behavior, available feature, bug cause, architecture, files, dependencies, tests, or prior execution unless you have clear evidence from code/docs/tool results/traces. Read or inspect the relevant source first, or spawn an agent that does. In your answer, briefly mention what evidence you checked. If you cannot verify it, say what is unknown and ask for permission/context rather than guessing.
4. Never change repository code directly from the top-level assistant. You may inspect files, docs, logs, and tool results for evidence, but implementation must go through run_workflow or spawn_agent for an agent working in an isolated Allen workspace. Do not edit files, commit, push, or open PRs yourself from the assistant response loop unless the user explicitly asks for a local-only emergency patch and accepts bypassing the normal workflow.
5. Normal conversation stays normal. If the user says "hi", asks a general question, brainstorms, asks for an explanation, or asks why you behaved a certain way, answer directly unless live Allen data is needed. For behavior questions, give the direct reason first; do not start with apology templates, synthetic issue labels, routing summaries, or workflow-style sections.
6. Allen Library skills are internal routing playbooks, distinct from Codex/Claude native runtime skills. In Allen chat, unqualified "skills" means Allen Library skills. For every non-trivial Allen-supported request, silently call list_skills first and use the full enabled skill metadata list (name, description, category, triggers, excludes, allowedRoutes, related workflows/agents, priority) to choose the right skill by user intent. Do not pick a skill only because search_skills ranked it highest; search_skills is only an optional hint after metadata review. After selecting the best skill from metadata, call get_skill for that skill before routing or answering. Do not load every skill body up front. Do not mention the selected skill name, skill id, or skill tool calls in user-facing responses unless the user explicitly asks. Only discuss Codex/Claude/plugin/runtime skills when the user explicitly asks for those.
7. Capability discovery before route selection: before proposing an execution route, inspect the available Allen workflows, specialized team leads/agents, and relevant external MCP tools that could do the job. Use list_workflows/get_workflow, list_teams/list_agents/get_team/get_agent, and any relevant external MCP discovery/list tools when available. Prefer the most specific workflow or specialized lead/agent that owns the end-to-end task; use raw external MCP tools directly only for simple tool-native queries/actions or as evidence for the selected route.
8. Intent clarity and confirmation: if the user intent, target repo/resource, scope, desired outcome, or best route is unclear, ask a concise clarifying question instead of guessing. Before starting execution that changes state or consumes a specialist/workflow run, present the selected route, short plan, required inputs, expected outputs, and risks/unknowns, then ask the user to confirm. Read-only answers and read-only data queries may proceed without confirmation after evidence is checked.
9. Tool contract: before run_workflow, inspect get_workflow and use exact parsed.input field names. After run_workflow or spawn_agent, wait/monitor until complete, blocked, or clearly still running. Surface progress, human-input pauses, workspace links, PR links, artifacts, and final output with clickable links.
9a. Context query for spawned agents: when calling spawn_agent for repo-related work, pass a compact context_query object as a separate tool argument. Include user_request, task_type, retrieval-relevant requirements, topics, target_files/path_hints, and required_categories/preferred_categories when obvious. Consolidate relevant prior chat discussion so phrases like "implement what we discussed" still carry the actual retrieval intent. Never embed context query XML/JSON in prompt. Keep execution guardrails, artifact instructions, no-edit/no-commit/no-PR constraints, and process constraints in prompt, not context_query.
10. Interrupted reruns: if this chat has interrupted/cancelled tasks and the user asks to rerun, retry, continue, or restart that work, ask whether they want a fresh start or to resume the cancelled execution. If they choose resume, use resume_execution. If they choose fresh start, route again from the user's current intent.
11. For product brainstorming or improvement requests about a known repo/system, first decide whether the answer depends on the existing implementation. If it does, inspect the repo first unless the user explicitly asks for product-level brainstorming only. If the user asks specifically about improving an existing product area, prefer a short repo-grounded inspection before recommendations.
12. Keep routing details, skill choice, workflow names, and confirmation plans out of normal answers unless the user asks how work will be routed or you are proposing execution.
13. Always surface resource links per the "Resource Links" rule above for PRs, tickets, uploads, artifacts, and deployments when available. For Allen internal resources, prefer links when available; otherwise present readable names/statuses and only include IDs when useful.${learningsBlock}`;

  // Inject the live org chart so the assistant knows who to spawn.
  let orgBlock = '';
  try {
    const chart = await buildOrgContextBlock(db, { includeFullChart: true, includeMeta: true, chartMode: 'summary' });
    if (chart) orgBlock = `\n\n${chart}`;
  } catch {}

  // Inject available repos
  let reposBlock = '';
  try {
    const repos = await db.collection('repos').find({ status: 'active' }).toArray();
    if (repos.length > 0) {
      reposBlock = `\n\nAvailable repos: ${repos.map((r: any) => `${r.name} (${r.path})`).join(', ')}. User references with @repo-name.`;
    }
    // Surface the default design repo regardless of status (active, registered,
    // placeholder, etc.) — only archived repos are excluded.  This block has
    // different semantics from Available Repositories and it is intentionally OK
    // for the same repo to appear in both sections.
    const defaultDesignRepo = await db.collection('repos').findOne({
      isDefaultDesignRepo: true,
      path: { $exists: true, $ne: '' },
      status: { $ne: 'archived' },
    }) as { name: string; path: string } | null;
    if (defaultDesignRepo) {
      reposBlock += `\n\nDefault design repo: ${defaultDesignRepo.name} at ${defaultDesignRepo.path} (use this path for design workflow \`repo_path\`/\`design_repo_path\` inputs).`;
    }
  } catch {}

  // ── Planner persona (Plan Mode) ──────────────────────────────────────────
  // When plan mode is toggled on for the base assistant, the chat is driven by
  // the Planner instead of the routing assistant. The Planner's only job is to
  // brainstorm ideas and, on request, author a PRD with explicit requirements
  // and acceptance criteria. It never guesses — it asks clarifying questions
  // first. The Planner runs with the SAME tools and permissions as the
  // assistant (Plan Mode only swaps the persona; runLLM clears the planMode
  // flag for this path so the SDK is not put into read-only 'plan' mode). The
  // prompt itself lives in chat-persona.ts so it can be unit-tested without the
  // engine/DB import graph.
  if (persona === 'planner') {
    return buildPlannerSystemPrompt({ learningsBlock, orgBlock, reposBlock });
  }

  // Single unified tail for both providers — keeps tool guidance,
  // examples, and artifact handling identical across codex and
  // claude-cli so the assistant behaves the same regardless of which
  // CLI is running. Tool name aliases (with / without `allen` prefix)
  // are listed so the model picks them up correctly under either MCP
  // surface (codex namespaces tools with the server prefix; claude-cli
  // surfaces them by bare name via buildToolInstructions()).
  return `${base}

You have MCP tools available. Use them to get data — don't describe what you would do, actually call the tool.

Key Allen tools (under the \`allen\` MCP server — codex shows them as \`allen.<name>\`, claude-cli as bare \`<name>\`):
- list_skills, search_skills, get_skill
- list_workflows, get_workflow, list_executions, wait_for_execution
- list_agents, get_agent, list_teams, get_team, list_team_members, list_repos
- get_dashboard_stats, search_executions, get_node_trace, get_execution_logs
- run_workflow, spawn_agent
- create_workspace, get_workspace, create_workspace_for_pr
- allen_save_artifact, allen_list_artifacts, allen_get_artifact, upload_file
- submit_execution_input, ask_user

Other MCP servers (Linear, GitHub, etc.) are also available when configured.
Before choosing a route for execution work, compare matching workflows, specialized leads/agents, and external MCP tools. Do not jump straight to a raw MCP tool if a specialist agent or lead owns the end-to-end task.

Examples:
- "What workflows do I have?" → list_workflows
- "Show me linear tickets" → linear_search_issues
- "Check execution abc123" → wait_for_execution(execution_id="abc123")
- "List my agents" → list_agents
- "What skills do we have?" → list_skills
- "What happened in my last run?" → list_executions then get_execution_logs / get_node_trace
- "Show me dashboard stats" → get_dashboard_stats
- "Find failed executions today" → search_executions
- "Hi" → answer directly; do not run a workflow or spawn an agent
- "Review code in @my-repo" → load the matching routing playbook silently, compare workflows/agents/MCP tools, gather repo context, present review route/plan, ask confirmation, then create_workspace and spawn_agent if confirmed
- "Implement a feature in @my-repo" → load the matching routing playbook silently, compare workflows/agents/MCP tools, inspect get_workflow(feature-plan-and-implement) if it fits, present plan and exact inputs, ask confirmation, then run_workflow if confirmed
- "Fix this bug in @my-repo" → load the matching routing playbook silently, compare workflows/agents/MCP tools, inspect get_workflow(bug-fix-by-severity) if it fits, present plan and exact inputs, ask confirmation, then run_workflow if confirmed
- "Assign this to engineering lead" → load the matching routing playbook silently, verify the lead/agent target, present spawn target and task, ask confirmation, then spawn_agent if confirmed
- "Run coding-reviewer on @my-repo" → load the matching routing playbook silently, verify the specialist target, present workspace/reviewer plan, ask confirmation, then create_workspace and spawn_agent if confirmed
- "Work on LIN-123" → load the matching routing playbook silently, inspect the ticket via Linear if available, compare workflows/agents/MCP tools, present plan and exact workflow/agent inputs, ask confirmation, then execute if confirmed
- If an execution is waiting for input → present the fields, then submit_execution_input

For code tasks: direct specialist spawns need an Allen workspace first; workflows with their own create_workspace node should receive the registered repo_path and create the worktree themselves. For read-only planning or explanation, answer directly or use read-only tools. Remind any sub-agent you spawn to save its deliverables via allen_save_artifact so they appear in this chat's Artifacts panel.${orgBlock}${reposBlock}`;
}

// ── Active Query Tracking ──

interface ActiveQuery {
  sessionId: string;
  messageId: string;
  userMessage: string;
  llmSessionId?: string;
  currentText: string;
  currentThinking: string;
  toolCalls: ToolCallRecord[];
  pendingToolCalls: Map<string, { tool: string; args: Record<string, unknown>; startMs: number }>;
  listeners: Set<Response>;
  eventHandlers?: Set<ChatEventHandler>;
  aborted: boolean;
  /** Abort controller for the underlying LLM subprocess. Calling .abort()
   *  kills the claude-cli process (SIGTERM) and stops token generation.
   *  Without this, clicking "Stop" in the UI only closes the SSE connection
   *  but the agent keeps running in the background burning tokens. */
  abortController: AbortController;
}

const activeQueries = new Map<string, ActiveQuery>();
const ACTIVE_EXECUTION_STATUSES = ['running', 'queued', 'waiting_for_input'];
const drainingQueues = new Set<string>();
const ACTIVE_QUEUE_STATUSES: ChatQueueStatus[] = ['queued', 'editing', 'running'];
const MAX_CHAT_QUEUE_ITEMS = 3;

// ── SSE Heartbeat ──
// Emits `: keepalive\n\n` every 15 s to every active SSE listener.
// This is a SSE comment line (starts with `:`) — the spec ignores it as
// event data but it resets the browser/proxy idle-timeout timer, preventing
// the "Error: network error" drop that occurs during long tool-execution
// quiet periods (ENG-1581).
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
// WeakMap so entries are GC-d automatically once a Response is released.
const listenerHeartbeats = new WeakMap<Response, ReturnType<typeof setInterval>>();

function attachHeartbeat(res: Response): void {
  const handle = setInterval(() => {
    try { res.write(': keepalive\n\n'); }
    catch {
      clearInterval(handle);
      listenerHeartbeats.delete(res);
    }
  }, SSE_HEARTBEAT_INTERVAL_MS);
  listenerHeartbeats.set(res, handle);
}

function detachHeartbeat(res: Response): void {
  const handle = listenerHeartbeats.get(res);
  if (handle !== undefined) {
    clearInterval(handle);
    listenerHeartbeats.delete(res);
  }
}

interface CancelledExecutionInfo {
  id: string;
  workflowName?: string;
  status?: string;
}

export interface ChatCancelResult {
  cancelled: boolean;
  sessionId: string;
  messageId?: string;
  content?: string;
  userMessage?: string;
  resumableSessionAvailable?: boolean;
  restoreDraft?: string;
  cancelledExecutions: CancelledExecutionInfo[];
}

export type ChatEventHandler = (event: string, data: unknown) => void;

const CHAT_TITLE_MAX_CHARS = 70;
const CHAT_TITLE_MAX_WORDS = 10;

function executionRequestTitle(exec: Record<string, unknown>): string {
  const meta = ((exec.meta ?? {}) as Record<string, unknown>) ?? {};
  const input = ((exec.input ?? {}) as Record<string, unknown>) ?? {};
  return String(
    meta.requestText
      ?? meta.linearTitle
      ?? input.task
      ?? input.prompt
      ?? input.request
      ?? exec.workflowName
      ?? exec.id
      ?? 'task',
  );
}

function compactChatTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = sanitizeChatTitle(value);
  if (!trimmed) return null;
  return trimmed;
}

export function deterministicSessionTaskTitle(userMessage: string): string | null {
  const linearTitleMatch = userMessage.match(/Linear title:\s*([^\n]+)/i)
    ?? userMessage.match(/Ticket title:\s*([^\n]+)/i)
    ?? userMessage.match(/Issue title:\s*([^\n]+)/i);
  const linearTitle = compactChatTitle(linearTitleMatch?.[1]);
  if (linearTitle) return linearTitle;

  const dispatchMatch = userMessage.match(/Dispatch Linear ticket\s+([A-Z][A-Z0-9]+-\d+)\s*(?:[:\-–—]\s*|\s+through\s+Allen\b\s*)?([^\n]*)/i);
  const dispatchTitle = compactChatTitle(dispatchMatch?.[2]);
  if (dispatchTitle && !/^through allen$/i.test(dispatchTitle)) return dispatchTitle;

  return null;
}

export function sanitizeChatTitle(candidate: unknown): string | null {
  if (typeof candidate !== 'string') return null;
  let title = candidate
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) ?? '';

  title = title
    .replace(/^[-*#>\s]+/, '')
    .replace(/^title\s*:\s*/i, '')
    .replace(/^["'`]+|["'`.]+$/g, '')
    .replace(/^\*\*(.+)\*\*$/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  if (!title) return null;

  const words = title.split(/\s+/);
  if (words.length > CHAT_TITLE_MAX_WORDS) {
    title = words.slice(0, CHAT_TITLE_MAX_WORDS).join(' ');
  }
  if (title.length > CHAT_TITLE_MAX_CHARS) {
    const truncated = title.slice(0, CHAT_TITLE_MAX_CHARS).replace(/\s+\S*$/, '').trim();
    title = truncated || title.slice(0, CHAT_TITLE_MAX_CHARS).trim();
  }

  title = title.replace(/[.,;:!?-]+$/g, '').trim();
  return title || null;
}

export function fallbackTitleFromUserMessage(userMessage: string): string {
  let cleaned = userMessage
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    // Strip "For Allen," / "Hey Allen," / "Hi Allen," / "Hello Allen," prefixes (case-insensitive)
    .replace(/^(for|hey|hi|hello)\s+allen\b[,.]?\s*/i, '')
    // Strip standalone "Hi," / "Hey," / "Hello," starters
    .replace(/^(for|hey|hi|hello)[,.]?\s+/i, '')
    // Normalize common typos
    .replace(/\bi\s+wan\s+to\b/gi, 'i want to')
    .replace(/\bi\s+wanna\b/gi, 'i want to')
    // Strip filler phrases
    .replace(/\b(can you|could you|please|do one thing|i want to|we need to)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Capitalize first letter
  cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);

  // Prepend "About " if the result starts with no action verb (likely a noun phrase)
  const startsWithActionVerb = /^(fix|build|debug|review|find|add|improve|analyse|analyze|investigate|create|update|delete|check|run|generate|write|test|implement|deploy|migrate|refactor|explore|configure|manage|plan|design|optimize|show|help|assist|identify|evaluate|propose|research|compare|summarize|list|get|set|use)\b/i.test(cleaned);
  if (!startsWithActionVerb && cleaned.length > 0) {
    cleaned = 'About ' + cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
  }

  return sanitizeChatTitle(cleaned) ?? 'New conversation';
}

function looksLikeFallbackTitle(title: string | undefined): boolean {
  if (!title) return true;
  const words = title.split(/\s+/);
  if (words.length >= CHAT_TITLE_MAX_WORDS) return true;
  if (title.length >= CHAT_TITLE_MAX_CHARS) return true;
  if (/^(for|hey|hi|hello)\s+allen\b/i.test(title)) return true;
  const startsWithActionVerb = /^(fix|build|debug|review|find|add|improve|analyse|analyze|investigate|create|update|delete|check|run|generate|write|test|implement|deploy|migrate|refactor|explore|configure|manage|plan|design|optimize|show|help|assist|identify|evaluate|propose|research|compare|summarize|list|get|set|use|about)\b/i.test(title);
  if (!startsWithActionVerb) return true;
  return false;
}

export function normalizeGeneratedChatTitle(candidate: unknown, userMessage: string): string {
  return sanitizeChatTitle(candidate) ?? fallbackTitleFromUserMessage(userMessage);
}

export function sanitizeChatAssistantResponse(candidate: unknown): string {
  if (typeof candidate !== 'string') return '';
  let text = candidate;
  let previous = '';
  while (text !== previous) {
    previous = text;
    text = stripTrailingRepoContextUsageMarker(text)
      .replace(/\s+$/g, '');
    text = stripTrailingRepoContextUsageJsonFence(text)
      .replace(/\s+$/g, '');
    text = stripTrailingRepoContextUsageJsonObject(text)
      .replace(/\s+$/g, '');
    text = stripTrailingRepoContextUsageSection(text)
      .replace(/\s+$/g, '');
  }
  return text;
}

function stripTrailingRepoContextUsageMarker(text: string): string {
  return text.replace(
    /(?:\n\s*)*(?:repo[_\s-]*context[_\s-]*usage|repocontextusage)\s*:\s*no\s+repo\s+context\s+used\.?\s*$/i,
    '',
  );
}

function stripTrailingRepoContextUsageJsonFence(text: string): string {
  const match = text.match(/(?:\n\s*)```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i);
  if (!match?.[1]) return text;
  return isStandaloneRepoContextUsageJson(match[1])
    ? text.slice(0, match.index).replace(/\s+$/g, '')
    : text;
}

function stripTrailingRepoContextUsageJsonObject(text: string): string {
  const starts = [...text.matchAll(/(?:^|\n)\s*\{/g)].map((match) => match.index ?? 0);
  for (let i = starts.length - 1; i >= 0; i -= 1) {
    const start = starts[i];
    const candidate = text.slice(start).trim();
    if (!candidate.endsWith('}')) continue;
    if (isStandaloneRepoContextUsageJson(candidate)) {
      return text.slice(0, start).replace(/\s+$/g, '');
    }
  }
  return text;
}

function stripTrailingRepoContextUsageSection(text: string): string {
  const marker = /(?:^|\n)\s*(?:[-*]\s*)?(?:#{1,6}\s*)?(?:`{1,3})?(?:repo[_\s-]*context[_\s-]*usage|repocontextusage)\b[\s\S]*$/i;
  const match = text.match(marker);
  if (!match || match.index == null) return text;
  return text.slice(0, match.index).replace(/\s+$/g, '');
}

function isStandaloneRepoContextUsageJson(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw.trim());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const keys = Object.keys(parsed as Record<string, unknown>);
    return keys.length === 1 && keys[0] === 'repo_context_usage';
  } catch {
    return false;
  }
}

function sanitizeChatMessagesForDisplay(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== 'assistant') return message;
    return {
      ...message,
      content: sanitizeChatAssistantResponse(message.content),
    };
  });
}

interface VerifiedTitle {
  title: string;
  confidence: number;  // 0.0–1.0; any value > 0 from a non-empty title is accepted
  notes?: string;
}

/**
 * Parse the LLM's structured self-verification response. Tolerates code-fence
 * wrappers, leading prose, and trailing prose by extracting the first JSON
 * object that looks right.
 */
function parseTitleVerification(raw: string): VerifiedTitle | null {
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1]);
  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (objMatch?.[0]) candidates.push(objMatch[0]);
  candidates.push(raw);

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c.trim());
      if (parsed && typeof parsed === 'object' && typeof parsed.final_title === 'string') {
        return {
          title: parsed.final_title,
          confidence: typeof parsed.confidence === 'number' ? parsed.confidence : (parsed.is_valid !== false ? 0.7 : 0.1),
          notes: typeof parsed.notes === 'string' ? parsed.notes : (typeof parsed.reason === 'string' ? parsed.reason : undefined),
        };
      }
    } catch {}
  }
  return null;
}

async function cancelLinkedChatExecutions(sessionId: string, db: Db, parentMessageId?: string): Promise<CancelledExecutionInfo[]> {
  const directFilter: Record<string, unknown> = { 'meta.chatSessionId': sessionId };
  if (parentMessageId) directFilter['meta.parentMessageId'] = parentMessageId;
  const linkedRows = await db.collection('executions')
    .find(
      directFilter,
      { projection: { id: 1, workflowName: 1 } },
    )
    .toArray();
  const linkedIds = linkedRows.map((row) => row.id as string).filter(Boolean);

  const activeRows = await db.collection('executions')
    .find(
      {
        status: { $in: ACTIVE_EXECUTION_STATUSES },
        $or: [
          directFilter,
          ...(linkedIds.length > 0 ? [
            { rootExecutionId: { $in: linkedIds } },
            { parentExecutionId: { $in: linkedIds } },
          ] : []),
        ],
      },
      { projection: { id: 1, workflowName: 1, status: 1 } },
    )
    .toArray();

  const service = new ExecutionService(db);
  const seen = new Set<string>();
  const cancelled: CancelledExecutionInfo[] = [];

  for (const row of activeRows) {
    const id = row.id as string | undefined;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    try {
      await service.cancel(id);
      await db.collection('execution_logs').insertOne({
        executionId: id,
        level: 'warn',
        category: 'system',
        message: 'Cancelled because the owning chat thread was interrupted.',
        timestamp: new Date(),
      }).catch(() => {});
      cancelled.push({
        id,
        workflowName: row.workflowName as string | undefined,
        status: 'cancelled',
      });
    } catch {
      // Best-effort: do not block chat interrupt cleanup.
    }
  }

  return cancelled;
}

async function interruptedTaskContext(db: Db, sessionId: string): Promise<string> {
  const rows = await db.collection('executions')
    .find(
      { 'meta.chatSessionId': sessionId, status: 'cancelled' },
      {
        projection: { id: 1, workflowName: 1, status: 1, input: 1, meta: 1, completedAt: 1, sessions: 1 },
        sort: { completedAt: -1, startedAt: -1 },
        limit: 5,
      },
    )
    .toArray()
    .catch(() => []);
  if (rows.length === 0) return '';
  const lines = rows.map((row) => {
    const id = row.id as string;
    const kind = String(row.workflowName ?? '').includes(':spawn_agent/') ? 'agent/lead' : 'workflow';
    const hasSession = row.sessions && Object.keys(row.sessions as Record<string, unknown>).length > 0;
    return `- ${id} (${kind}): ${executionRequestTitle(row)}${hasSession ? ' — resumable agent session available' : ''}`;
  });
  return `\n[INTERRUPTED TASKS IN THIS THREAD]\n${lines.join('\n')}\nIf the user asks to rerun/continue/retry one of these, ask whether they want a fresh start or resume. Use resume_execution only after they choose resume.`;
}

/**
 * Cancel a running chat session's LLM subprocess. Called from the
 * POST /api/chat/sessions/:id/cancel route.
 *
 * This is an INTERRUPT, not just a stop:
 *   1. Kills the claude-cli / codex subprocess (SIGTERM via AbortController)
 *   2. Preserves any captured llmSessionId so the next message can resume
 *      when the provider session was already created
 *   3. Marks the in-flight assistant message as cancelled
 *   4. Removes the session from activeQueries so it's not "busy"
 *   5. Broadcasts a cancel event to any SSE listeners, including restoreDraft
 *      when no resumable provider session was captured
 *
 * After cancel, the user can immediately send a new message.
 */
export async function cancelChatSession(sessionId: string, db?: Db): Promise<ChatCancelResult> {
  const entry = activeQueries.get(sessionId);
  let cancelledExecutions: CancelledExecutionInfo[] = [];
  let cancelledContent: string | undefined;

  const userMessage = entry?.userMessage;
  // Do not use chat_sessions.llmSessionId here: that can belong to a prior
  // turn. Draft restore depends on whether this interrupted turn reached the
  // provider, so only current-turn signals count.
  const resumableSessionAvailable = Boolean(
    entry?.llmSessionId
    || entry?.currentText
    || entry?.currentThinking
    || (entry?.pendingToolCalls.size ?? 0) > 0
    || (entry?.toolCalls.length ?? 0) > 0,
  );
  const restoreDraft = !resumableSessionAvailable ? userMessage : undefined;

  // 1. Kill the subprocess for THIS turn only
  if (entry) {
    entry.aborted = true;
    entry.abortController.abort();
  }

  // 2. Cancel linked workflow/agent executions spawned from this chat.
  if (db) {
    cancelledExecutions = await cancelLinkedChatExecutions(sessionId, db, entry?.messageId);
  }

  // 3. DO NOT touch llmSessionId — the thread still exists on the
  //    provider's side. We just killed our local subprocess. The next
  //    message resumes the same thread with full prior context.

  // 4. Mark the in-flight assistant message as cancelled
  if (entry && db) {
    const { ObjectId } = await import('mongodb');
    if (entry.messageId) {
      const executionNote = cancelledExecutions.length > 0
        ? `Interrupted by user. Cancelled linked tasks: ${cancelledExecutions.map((exec) => exec.id).join(', ')}. If you want to rerun, choose fresh start or resume.`
        : 'Interrupted by user.';
      cancelledContent = entry.currentText ? `${entry.currentText}\n\n${executionNote}` : executionNote;
      await db.collection('chat_messages').updateOne(
        { _id: new ObjectId(entry.messageId) },
        { $set: {
          status: 'cancelled',
          content: cancelledContent,
          completedAt: new Date(),
        } },
      ).catch(() => {});
    }
  }

  // 5. Broadcast cancel event so UI updates immediately
  if (entry) {
    broadcastToListeners(entry, 'cancelled', {
      messageId: entry.messageId,
      cancelledExecutions,
      userMessage,
      resumableSessionAvailable,
      restoreDraft,
    });
    closeStreamListeners(entry);
  }

  // 6. Remove from active queries so the user can send the next message
  if (entry) activeQueries.delete(sessionId);

  return {
    cancelled: Boolean(entry),
    sessionId,
    messageId: entry?.messageId,
    content: cancelledContent,
    userMessage,
    resumableSessionAvailable,
    restoreDraft,
    cancelledExecutions,
  };
}

function broadcastToListeners(entry: ActiveQuery, event: string, data: unknown): void {
  const payload = data && typeof data === 'object' && !Array.isArray(data) && !('messageId' in data)
    ? { ...(data as Record<string, unknown>), messageId: entry.messageId }
    : data;
  for (const listener of entry.listeners) {
    try { listener.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); }
    catch { entry.listeners.delete(listener); }
  }
  for (const handler of entry.eventHandlers ?? []) {
    try { handler(event, payload); } catch { entry.eventHandlers?.delete(handler); }
  }
}

function closeStreamListeners(entry: ActiveQuery): void {
  for (const listener of entry.listeners) {
    try {
      detachHeartbeat(listener);
      listener.end();
    } catch {}
  }
  entry.listeners.clear();
}

// ── Service ──

export class ChatService {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private get sessions() { return this.db.collection('chat_sessions'); }
  private get messages() { return this.db.collection('chat_messages'); }
  private get messageQueue() { return this.db.collection('chat_message_queue'); }

  async getProviders() {
    const providers = await getEnabledProvidersFromRegistry(this.db);
    // CLI providers are always enabled but only usable when logged in —
    // surface authStatus so the UI can gate dropdowns and show login state.
    const { getCliAuthStatus, isCliProvider } = await import('./cli-auth.service.js');
    return Promise.all(providers.map(async (p) => (
      isCliProvider(p.provider)
        ? { ...p, authStatus: await getCliAuthStatus(p.provider) }
        : p
    )));
  }

  async createSession(
    provider: ChatProvider = getDefaultChatProvider(),
    model?: string,
    source: 'ui' | 'slack' = 'ui',
    slackContext?: SlackContext,
    agentOverrides?: Record<string, unknown>,
    repoId?: string,
    owner?: { userId?: string; name?: string; email?: string },
  ): Promise<ChatSession> {
    const now = new Date();
    const effectiveModel = model ?? getDefaultChatModel(provider);
    let repoPath: string | undefined;
    let repoName: string | undefined;
    if (repoId) {
      try {
        const repo = await this.db.collection('repos').findOne({ _id: new ObjectId(repoId) });
        if (repo) {
          repoPath = repo.path as string;
          repoName = repo.name as string;
        }
      } catch (e) {
        // invalid ObjectId or missing repo — proceed without repo binding
      }
    }
    const doc: ChatSession = {
      title: 'New Conversation', titleSource: 'default', status: 'active', messageCount: 0,
      lastMessageAt: now, totalCostUsd: 0, provider, model: effectiveModel,
      source,
      ...(slackContext ? { slackContext } : {}),
      ...(repoId && repoPath ? { repoId, repoPath, repoName } : {}),
      ...(agentOverrides ? { agentOverrides } : {}),
      ...(owner?.userId ? { ownerUserId: owner.userId } : {}),
      ...(owner?.name ? { ownerName: owner.name } : {}),
      ...(owner?.email ? { ownerEmail: owner.email } : {}),
      createdAt: now, updatedAt: now,
    };
    const result = await this.sessions.insertOne(doc);
    return { ...doc, _id: result.insertedId };
  }

  async listSessions(filter?: { ownerUserId?: string | null }): Promise<ChatSession[]> {
    // Owner info is denormalized onto the session at creation time (and
    // backfilled at startup for legacy sessions), so this is a plain find().
    // Pass ownerUserId=null to filter for unowned sessions (automation / legacy
    // rows that the backfill couldn't resolve).
    const query: Record<string, unknown> = {};
    if (filter && 'ownerUserId' in filter) {
      // MongoDB: { field: null } matches both null and missing values.
      query.ownerUserId = filter.ownerUserId;
    }
    const sessions = await this.sessions
      .find(query)
      .sort({ lastMessageAt: -1 })
      .limit(100)
      .toArray() as unknown as ChatSession[];
    const hydrated = await this.hydrateArchivedWorkspaceSnapshots(sessions);
    // Session cost is computed on demand (messages + linked execution
    // trees) — the stored totalCostUsd field is legacy and no longer
    // written. Batched: three queries for the whole page.
    const ids = hydrated.map(s => s._id?.toString() ?? '').filter(Boolean);
    const costTotals = await new CostRollupService(this.db)
      .getChatSessionsCostBatch(ids)
      .catch(() => new Map<string, number>());
    return hydrated.map(session => ({
      ...session,
      totalCostUsd: costTotals.get(session._id?.toString() ?? '') ?? session.totalCostUsd ?? 0,
      streaming: this.isStreaming(session._id?.toString() ?? ''),
    }));
  }

  async getSession(id: string): Promise<(ChatSession & { messages: ChatMessage[] }) | null> {
    const session = await this.sessions.findOne({ _id: new ObjectId(id) });
    if (!session) return null;
    const msgs = await this.messages.find({ sessionId: id }).sort({ createdAt: -1 }).limit(50).toArray() as ChatMessage[];
    msgs.reverse();
    const [hydrated] = await this.hydrateArchivedWorkspaceSnapshots([session as unknown as ChatSession]);
    // On-demand session total: own messages + every chat-spawned execution
    // tree. Replaces the legacy stored totalCostUsd accumulator.
    const sessionCost = await new CostRollupService(this.db).getChatSessionCost(id).catch(() => null);
    return {
      ...hydrated,
      ...(sessionCost ? { totalCostUsd: sessionCost.totalCostUsd, costBreakdown: sessionCost } : {}),
      streaming: this.isStreaming(id),
      messages: sanitizeChatMessagesForDisplay(msgs),
    };
  }

  private async hydrateArchivedWorkspaceSnapshots<T extends ChatSession>(sessions: T[]): Promise<T[]> {
    const missing = sessions.filter(session => {
      const id = session._id?.toString();
      return id && !session.archivedWorkspace;
    });
    if (missing.length === 0) return sessions;

    const sessionIds = missing.map(session => session._id!.toString());
    const executionLinks = await this.db.collection('executions')
      .find(
        {
          'meta.chatSessionId': { $in: sessionIds },
          'meta.workspaceId': { $type: 'string' },
        },
        { projection: { 'meta.chatSessionId': 1, 'meta.workspaceId': 1, startedAt: 1, createdAt: 1 } },
      )
      .sort({ startedAt: -1, createdAt: -1 })
      .toArray();

    const workspaceIdBySession = new Map<string, string>();
    for (const session of missing) {
      const sessionId = session._id?.toString() ?? '';
      if (sessionId && typeof session.workspaceId === 'string' && ObjectId.isValid(session.workspaceId)) {
        workspaceIdBySession.set(sessionId, session.workspaceId);
      }
    }
    for (const link of executionLinks) {
      const chatSessionId = typeof link.meta?.chatSessionId === 'string' ? link.meta.chatSessionId : '';
      const workspaceId = typeof link.meta?.workspaceId === 'string' ? link.meta.workspaceId : '';
      if (chatSessionId && ObjectId.isValid(workspaceId) && !workspaceIdBySession.has(chatSessionId)) {
        workspaceIdBySession.set(chatSessionId, workspaceId);
      }
    }

    const workspaceIds = Array.from(new Set([...workspaceIdBySession.values()]))
      .filter(ObjectId.isValid)
      .map(id => new ObjectId(id));
    if (workspaceIds.length === 0) return sessions;

    const workspaces = await this.db.collection('workspaces')
      .find({ _id: { $in: workspaceIds } })
      .toArray();
    const workspaceById = new Map(
      workspaces.map(workspace => [workspace._id.toString(), workspace]),
    );
    const archivedSnapshotByWorkspaceId = new Map(
      workspaces
        .filter(workspace => workspace.status === 'archived')
        .map(workspace => [workspace._id.toString(), archivedWorkspaceSnapshot(workspace)]),
    );

    await Promise.all(sessionIds.map(async sessionId => {
      const workspaceId = workspaceIdBySession.get(sessionId);
      const snapshot = workspaceId ? archivedSnapshotByWorkspaceId.get(workspaceId) : undefined;
      if (!snapshot || !ObjectId.isValid(sessionId)) return;
      await this.sessions.updateOne(
        { _id: new ObjectId(sessionId), archivedWorkspace: { $exists: false } },
        {
          $set: { archivedWorkspace: snapshot, updatedAt: new Date() },
          $unset: { workspaceId: '' },
        },
      ).catch(() => {});
    }));

    return sessions.map(session => {
      const sessionId = session._id?.toString() ?? '';
      const workspaceId = workspaceIdBySession.get(sessionId);
      const snapshot = workspaceId ? archivedSnapshotByWorkspaceId.get(workspaceId) : undefined;
      if (snapshot) return { ...session, archivedWorkspace: snapshot, workspaceId: undefined };
      const workspace = workspaceId ? workspaceById.get(workspaceId) : undefined;
      if (!workspace) return session;
      return {
        ...session,
        workspaceId,
        workspaceName: typeof workspace.name === 'string' ? workspace.name : undefined,
        workspaceRepoId: typeof workspace.repoId === 'string' ? workspace.repoId : undefined,
        workspaceRepoName: typeof workspace.repoName === 'string' ? workspace.repoName : undefined,
        workspaceBranch: typeof workspace.branch === 'string' ? workspace.branch : undefined,
        workspaceBaseBranch: typeof workspace.baseBranch === 'string' ? workspace.baseBranch : undefined,
        workspacePrNumber: typeof workspace.prNumber === 'number' ? workspace.prNumber : undefined,
        workspacePrUrl: typeof workspace.prUrl === 'string' ? workspace.prUrl : undefined,
      };
    }) as T[];
  }

  async getMessages(sessionId: string, before?: string, limit = 50): Promise<{ data: ChatMessage[]; hasMore: boolean }> {
    const query: Record<string, unknown> = { sessionId };
    if (before) {
      const beforeDoc = await this.messages.findOne({ _id: new ObjectId(before) });
      if (beforeDoc) query.createdAt = { $lt: beforeDoc.createdAt };
    }
    const data = (await this.messages.find(query).sort({ createdAt: -1 }).limit(limit + 1).toArray()) as ChatMessage[];
    const hasMore = data.length > limit;
    if (hasMore) data.pop();
    data.reverse();
    return { data: sanitizeChatMessagesForDisplay(data), hasMore };
  }

  private serializeQueueItem(doc: Record<string, unknown>): ChatQueueItem {
    return {
      ...(doc as unknown as ChatQueueItem),
      id: doc._id instanceof ObjectId ? doc._id.toString() : String(doc._id ?? ''),
    };
  }

  async listQueuedMessages(sessionId: string): Promise<ChatQueueItem[]> {
    const rows = await this.messageQueue
      .find({ sessionId, status: { $in: ACTIVE_QUEUE_STATUSES } })
      .sort({ createdAt: 1 })
      .toArray();
    return rows.map(row => this.serializeQueueItem(row));
  }

  async enqueueQueuedMessage(
    sessionId: string,
    input: { content: string; agent?: string | null; cwd?: string | null },
    sender?: ChatMessageSender,
  ): Promise<ChatQueueItem> {
    if (!ObjectId.isValid(sessionId)) throw new Error('Invalid session id');
    const session = await this.sessions.findOne({ _id: new ObjectId(sessionId) });
    if (!session) throw new Error('Session not found');

    const activeCount = await this.messageQueue.countDocuments({
      sessionId,
      status: { $in: ACTIVE_QUEUE_STATUSES },
    });
    if (activeCount >= MAX_CHAT_QUEUE_ITEMS) {
      throw new Error(`Queue limit reached. Keep at most ${MAX_CHAT_QUEUE_ITEMS} queued messages per chat.`);
    }

    const now = new Date();
    const doc: ChatQueueItem = {
      sessionId,
      content: input.content,
      agent: input.agent ?? null,
      cwd: input.cwd ?? null,
      status: 'queued',
      sender,
      createdAt: now,
      updatedAt: now,
    };
    const result = await this.messageQueue.insertOne(doc as unknown as Record<string, unknown>);
    const item = { ...doc, _id: result.insertedId, id: result.insertedId.toString() };
    if (!activeQueries.has(sessionId)) {
      void this.drainQueuedMessages(sessionId).catch(err => console.warn('[chat_queue] drain failed:', err.message));
    }
    return item;
  }

  async updateQueuedMessage(
    sessionId: string,
    queueId: string,
    input: { content?: string; status?: 'queued' | 'editing' },
  ): Promise<ChatQueueItem> {
    if (!ObjectId.isValid(queueId)) throw new Error('Invalid queue item id');
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof input.content === 'string') set.content = input.content;
    if (input.status) set.status = input.status;
    const result = await this.messageQueue.findOneAndUpdate(
      {
        _id: new ObjectId(queueId),
        sessionId,
        status: { $in: ['queued', 'editing'] },
      },
      { $set: set },
      { returnDocument: 'after' },
    );
    if (!result) throw new Error('Queued message not found');
    if (input.status === 'queued' && !activeQueries.has(sessionId)) {
      void this.drainQueuedMessages(sessionId).catch(err => console.warn('[chat_queue] drain failed:', err.message));
    }
    return this.serializeQueueItem(result);
  }

  async deleteQueuedMessage(sessionId: string, queueId: string): Promise<void> {
    if (!ObjectId.isValid(queueId)) throw new Error('Invalid queue item id');
    await this.messageQueue.deleteOne({
      _id: new ObjectId(queueId),
      sessionId,
      status: { $in: ['queued', 'editing'] },
    });
  }

  async drainQueuedMessages(sessionId: string): Promise<void> {
    if (drainingQueues.has(sessionId)) return;
    drainingQueues.add(sessionId);
    try {
      while (!activeQueries.has(sessionId)) {
        const next = await this.messageQueue
          .find({ sessionId, status: { $in: ACTIVE_QUEUE_STATUSES } })
          .sort({ createdAt: 1 })
          .limit(1)
          .next() as ChatQueueItem | null;
        if (!next || next.status !== 'queued' || !next._id) break;

        const startedAt = new Date();
        const claimed = await this.messageQueue.updateOne(
          { _id: next._id, status: 'queued' },
          { $set: { status: 'running', startedAt, updatedAt: startedAt } },
        );
        if (claimed.modifiedCount === 0) continue;

        try {
          await this.sendMessageForSlack(
            sessionId,
            next.content,
            next.agent ?? undefined,
            next.sender,
            undefined,
            next.cwd ?? undefined,
          );
          const completedAt = new Date();
          await this.messageQueue.updateOne(
            { _id: next._id },
            { $set: { status: 'sent', completedAt, updatedAt: completedAt } },
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/session busy/i.test(message)) {
            await this.messageQueue.updateOne(
              { _id: next._id },
              { $set: { status: 'queued', updatedAt: new Date() }, $unset: { startedAt: '' } },
            );
            break;
          }
          const completedAt = new Date();
          await this.messageQueue.updateOne(
            { _id: next._id },
            { $set: { status: 'failed', error: message, completedAt, updatedAt: completedAt } },
          );
        }
      }
    } finally {
      drainingQueues.delete(sessionId);
    }
  }

  async sendMessage(sessionId: string, content: string, res: Response, agent?: string, cwd?: string, sender?: ChatMessageSender): Promise<void> {
    const session = await this.sessions.findOne({ _id: new ObjectId(sessionId) });
    if (!session) { res.status(404).json({ error: 'Session not found' }); return; }

    if (activeQueries.has(sessionId)) {
      res.status(409).json({ error: 'Session already has an active response' }); return;
    }

    const now = new Date();
    await this.messages.insertOne({
      sessionId, role: 'user', content, status: 'completed',
      ...senderFields(sender),
      createdAt: now, completedAt: now,
    });
    const assistantResult = await this.messages.insertOne({ sessionId, role: 'assistant', content: '', status: 'streaming', createdAt: new Date() });
    const assistantMsgId = assistantResult.insertedId.toString();

    await this.sessions.updateOne(
      { _id: new ObjectId(sessionId) },
      { $set: { lastMessageAt: new Date(), updatedAt: new Date() }, $inc: { messageCount: 2 } },
    );

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });

    const entry: ActiveQuery = {
      sessionId, messageId: assistantMsgId, userMessage: content, currentText: '', currentThinking: '', toolCalls: [],
      pendingToolCalls: new Map(), listeners: new Set([res]), aborted: false, abortController: new AbortController(),
    };
    activeQueries.set(sessionId, entry);
    attachHeartbeat(res);
    res.on('close', () => { detachHeartbeat(res); entry.listeners.delete(res); });

    this.runLLM(sessionId, assistantMsgId, content, entry, agent, 0, cwd).catch(() => {});
  }

  /**
   * Send a message and await the final result without an HTTP Response.
   * Used by the Slack integration: agent runs the same pipeline as sendMessage(),
   * but instead of streaming SSE the caller gets a Promise with the final text.
   * UI users can still watch progress by subscribing to /sessions/:id/stream.
   */
  async sendMessageForSlack(
    sessionId: string,
    content: string,
    agent?: string,
    sender?: ChatMessageSender,
    onEvent?: ChatEventHandler,
    cwd?: string,
  ): Promise<{ text: string; costUsd: number; durationMs: number }> {
    const session = await this.sessions.findOne({ _id: new ObjectId(sessionId) });
    if (!session) throw new Error('Session not found');
    if (activeQueries.has(sessionId)) throw new Error('Session busy');

    const now = new Date();
    await this.messages.insertOne({
      sessionId, role: 'user', content, status: 'completed',
      ...senderFields(sender),
      createdAt: now, completedAt: now,
    });
    const assistantResult = await this.messages.insertOne({
      sessionId, role: 'assistant', content: '', status: 'streaming', createdAt: new Date(),
    });
    const assistantMsgId = assistantResult.insertedId.toString();

    await this.sessions.updateOne(
      { _id: new ObjectId(sessionId) },
      { $set: { lastMessageAt: new Date(), updatedAt: new Date() }, $inc: { messageCount: 2 } },
    );

    // ActiveQuery with no SSE listeners — UI can still subscribe via GET /stream
    const entry: ActiveQuery = {
      sessionId, messageId: assistantMsgId, userMessage: content, currentText: '', currentThinking: '', toolCalls: [],
      pendingToolCalls: new Map(),
      listeners: new Set(), aborted: false, abortController: new AbortController(),
      ...(onEvent ? { eventHandlers: new Set([onEvent]) } : {}),
    };
    activeQueries.set(sessionId, entry);

    // runLLM handles all DB updates, error logging, and active session cleanup
    await this.runLLM(sessionId, assistantMsgId, content, entry, agent, 0, cwd);

    // Read the final result from DB (runLLM has already saved it)
    const msg = await this.messages.findOne({ _id: new ObjectId(assistantMsgId) });
    if (!msg) throw new Error('Assistant message not found after runLLM');
    if (msg.status === 'failed') {
      throw new Error((msg.error as string) || 'Agent failed to respond');
    }
    return {
      text: (msg.content as string) ?? '',
      costUsd: (msg.costUsd as number) ?? 0,
      durationMs: (msg.durationMs as number) ?? 0,
    };
  }

  subscribeToStream(sessionId: string, res: Response): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const entry = activeQueries.get(sessionId);
    if (entry) {
      if (entry.currentThinking) sendSSE(res, 'thinking', { text: entry.currentThinking, messageId: entry.messageId });
      if (entry.currentText) sendSSE(res, 'message_delta', { text: entry.currentText, messageId: entry.messageId });
      for (const [toolUseId, pending] of entry.pendingToolCalls) {
        sendSSE(res, 'tool_start', { tool: pending.tool, args: pending.args, toolUseId, tool_use_id: toolUseId, messageId: entry.messageId });
      }
      entry.listeners.add(res);
      attachHeartbeat(res);
      res.on('close', () => { detachHeartbeat(res); entry.listeners.delete(res); });
    } else {
      sendSSE(res, 'stream_inactive', { sessionId });
      res.end();
    }
  }

  isStreaming(sessionId: string): boolean { return activeQueries.has(sessionId); }

  /**
   * Broadcast an SSE event to every tab currently subscribed to this
   * session's stream. Used by the /agent-answer endpoint so a user who
   * answers an ask_user question in one tab instantly clears the popup
   * in their other tabs — without this, the ask_user tool's poll loop
   * is the only thing that fires `user_answer`, and its interval can
   * grow to 30s between checks, leaving sibling tabs stuck on the
   * question for that long.
   *
   * Returns the number of listeners the event was delivered to. 0 means
   * the session has no active query (nothing to broadcast to); the caller
   * can still rely on the DB write being visible via the poll loop.
   */
  broadcastToSession(sessionId: string, event: string, data: unknown): number {
    const entry = activeQueries.get(sessionId);
    if (!entry) return 0;
    broadcastToListeners(entry, event, data);
    return entry.listeners.size;
  }

  /**
   * Generate (or regenerate) a title for an existing session by fetching the
   * first user + first assistant message and running them through the LLM
   * title generator. Used by the manual backfill endpoint so operators can
   * fix sessions that were poorly titled.
   *
   * Returns the generated title string, or null if the session has no user
   * messages yet.
   */
  async generateTitleForSession(sessionId: string): Promise<string | null> {
    const [userMsg, assistantMsg] = await Promise.all([
      this.messages.findOne(
        { sessionId, role: 'user' },
        { sort: { createdAt: 1 } },
      ),
      this.messages.findOne(
        { sessionId, role: 'assistant' },
        { sort: { createdAt: 1 } },
      ),
    ]);

    if (!userMsg) return null;

    const title = await this.generateTitleWithLLM(
      userMsg.content as string,
      assistantMsg?.content as string | undefined,
    );

    await this.sessions.updateOne(
      { _id: new ObjectId(sessionId) },
      { $set: { title, titleSource: 'auto', updatedAt: new Date() } },
    );

    this.broadcastToSession(sessionId, 'session_update', { title });

    return title;
  }

  /**
   * Run a title-generating prompt against codex gpt-5.5, expecting structured
   * JSON with the model's own self-verification verdict. If the model marks
   * its draft invalid, retry once with the model's stated reason as feedback.
   * Returns the sanitized final title, or null if both attempts failed.
   */
  private async runVerifiedTitleLLM(prompt: string, userMessage: string): Promise<string | null> {
    const { provider: titleProvider, model: titleModel } = getTitleGenProviderModel();
    const callOnce = async (p: string): Promise<VerifiedTitle | null> => {
      try {
        const result = await runChatLLM(this.db, {
          provider: titleProvider,
          model: titleModel,
          systemPrompt: '',
          messages: [{ role: 'user', content: p }],
          skipTools: true,
          onText: () => {},
          onToolStart: () => {},
          onToolResult: () => {},
        });
        const parsed = parseTitleVerification(result.text.trim());
        if (!parsed) {
          console.log('[chat_title_llm_parse_failed] Could not parse LLM title response');
        }
        return parsed;
      } catch (err) {
        console.log('[chat_title_llm_threw] LLM title generation threw:', err instanceof Error ? err.message : err);
        return null;
      }
    };

    const first = await callOnce(prompt);
    // Accept any non-empty title from the first call, regardless of confidence
    if (first?.title) {
      if (first.confidence < 0.2) {
        console.log('[chat_title_llm_invalid] Low-confidence title accepted as best-effort:', first.confidence, first.notes);
      }
      return normalizeGeneratedChatTitle(first.title, userMessage);
    }

    // Only retry when first call produced no title at all
    const feedback = first?.notes || 'No title was produced. Generate a best-effort title even if imperfect.';
    const retryPrompt = `${prompt}\n\nYour previous attempt produced no title. Produce any best-effort title now. Reason: ${feedback}`;
    const second = await callOnce(retryPrompt);
    if (second?.title) {
      return normalizeGeneratedChatTitle(second.title, userMessage);
    }

    return null;
  }

  /**
   * Generate a concise, meaningful title for a conversation using the LLM.
   * Provider+model come from getTitleGenProviderModel() — the chat default
   * provider's defaultModel (so claude-only installs run titles through
   * claude-cli/sonnet, codex installs through codex/gpt-5.5).
   * Falls back to deterministic / truncation titles when the LLM fails.
   * assistantResponse is optional — omit it when titling from a user message only
   * (e.g. the first turn was aborted before the LLM responded).
   */
  private async generateTitleWithLLM(userMessage: string, assistantResponse?: string): Promise<string> {
    const prompt = assistantResponse
      ? `Generate a concise, descriptive title for this conversation.

Rules:
- Maximum 10 words
- Start with an action verb when possible (Fix, Build, Debug, Review, Find, Add, Improve, Analyse, etc.)
- Name the specific resource, feature, or system involved (repo name, component, API, etc.)
- Be concrete — avoid generic labels like "Chat about X" or "Help with Y"

Self-verification (the model MUST do this internally before answering):
- Read the user message (and assistant response if present).
- Draft a candidate title obeying every rule above.
- Check the candidate: is it a sentence fragment, an assistant-style reply, a single-word command (approve/yes/ok), a bare ID/URL/email, or a copy-pasted metadata line? If yes, reject and redraft.
- Confirm the final title actually summarises what the user is trying to accomplish.

Output format — RETURN ONLY this JSON object on a single line, nothing else:
{"final_title":"<the best title you can produce>","confidence":0.9,"notes":""}

Always return a best-effort title even if it is imperfect. Use a lower confidence (0.3–0.6) if you are uncertain. Never return an empty final_title.

Good examples (the title field):
- Fix visual search failure in image embeddings
- Review Allen chat productivity gaps
- Find extraction and transformation prompts
- Add authentication to the dashboard API
- Debug slow query in product search

User: ${userMessage.slice(0, 500)}

Assistant: ${assistantResponse.slice(0, 500)}`
      : `Generate a concise, descriptive title for a conversation that starts with the following message.

Rules:
- Maximum 10 words
- Start with an action verb when possible (Fix, Build, Debug, Review, Find, Add, Improve, Analyse, etc.)
- Name the specific resource, feature, or system involved (repo name, component, API, etc.)
- Be concrete — avoid generic labels like "Chat about X" or "Help with Y"

Self-verification (the model MUST do this internally before answering):
- Read the user message (and assistant response if present).
- Draft a candidate title obeying every rule above.
- Check the candidate: is it a sentence fragment, an assistant-style reply, a single-word command (approve/yes/ok), a bare ID/URL/email, or a copy-pasted metadata line? If yes, reject and redraft.
- Confirm the final title actually summarises what the user is trying to accomplish.

Output format — RETURN ONLY this JSON object on a single line, nothing else:
{"final_title":"<the best title you can produce>","confidence":0.9,"notes":""}

Always return a best-effort title even if it is imperfect. Use a lower confidence (0.3–0.6) if you are uncertain. Never return an empty final_title.

Good examples (the title field):
- Fix visual search failure in image embeddings
- Review Allen chat productivity gaps
- Find extraction and transformation prompts
- Add authentication to the dashboard API
- Debug slow query in product search

User: ${userMessage.slice(0, 500)}`;

    const verified = await this.runVerifiedTitleLLM(prompt, userMessage);
    if (verified) return verified;
    const deterministicResult = deterministicSessionTaskTitle(userMessage);
    if (deterministicResult) {
      const branch = /linear title:|ticket title:|issue title:/i.test(userMessage) ? 'deterministic-linear' : 'deterministic-dispatch';
      console.log(`[chat_title_fallback_used] branch=${branch}`);
      return deterministicResult;
    }
    console.log('[chat_title_fallback_used] branch=raw-truncation');
    return fallbackTitleFromUserMessage(userMessage);
  }

  /**
   * Run LLM via Anthropic Messages API with native tool calling.
   */
  private async runLLM(sessionId: string, assistantMsgId: string, content: string, entry: ActiveQuery, agent?: string, retryCount = 0, cwd?: string): Promise<void> {
    const saveInterval = setInterval(() => {
      if (entry.currentText) {
        this.messages.updateOne(
          { _id: new ObjectId(assistantMsgId) },
          { $set: { content: entry.currentText, thinkingText: entry.currentThinking, toolCalls: entry.toolCalls } },
        ).catch(() => {});
      }
    }, 5000);

    const startMs = Date.now();

    // Load session state BEFORE try block so catch can access these
    const session = await this.sessions.findOne({ _id: new ObjectId(sessionId) });
    const provider = (session?.provider as ChatProvider) ?? getDefaultChatProvider();
    const model = session?.model as string | undefined;
    const previousAgent = (session?.activeAgent as string | undefined) ?? undefined;
    // Agent is LOCKED to the session after first message — ignore agent param on subsequent messages
    const effectiveAgent = previousAgent ?? agent ?? undefined;
    const resumeSessionId = (session?.llmSessionId as string | undefined);

    try {

      // Set agent on first message only
      if (!previousAgent && effectiveAgent) {
        await this.sessions.updateOne(
          { _id: new ObjectId(sessionId) },
          { $set: { activeAgent: effectiveAgent } },
        );
      }

      // Resolve @mentions (returns context text + repo path if @repo was mentioned)
      const { context: mentionContext, repoPath: mentionRepoPath } = await resolveMentions(content, this.db);

      // Resolve workspace context — ONLY if this session is explicitly linked to a workspace
      let workspaceContext = '';
      let resolvedCwd: string | undefined;
      try {
        let linkedWs = await this.db.collection('workspaces').findOne({ chatSessionId: sessionId, status: { $nin: ['archived', 'failed'] } });
        // Fallback: session may be in chatSessionIds[] without being the latest chatSessionId.
        // In that case linkChat already set session.workspaceId — use it for CWD resolution.
        // REQ-13, AC-14
        if (!linkedWs && session?.workspaceId && ObjectId.isValid(session.workspaceId as string)) {
          linkedWs = await this.db.collection('workspaces').findOne({
            _id: new ObjectId(session.workspaceId as string),
            status: { $nin: ['archived', 'failed'] },
          });
          if (linkedWs) {
            console.info(
              { via: 'workspaceId', chatSessionId: sessionId, workspaceId: session.workspaceId, worktreePath: linkedWs.worktreePath },
              'allen.chat.workspace.cwd_resolved',
            );
          }
        }
        if (linkedWs) {
          workspaceContext = `\n[WORKSPACE: ${linkedWs.name}] Path: ${linkedWs.worktreePath}\nBranch: ${linkedWs.branch} → ${linkedWs.baseBranch}\nRepo: ${linkedWs.repoName}\nYou are working inside this workspace. All file paths are relative to: ${linkedWs.worktreePath}\n`;
          resolvedCwd = linkedWs.worktreePath as string;
        }
      } catch {}

      // Step 2 — session-level repo (only when no linked workspace)
      if (!resolvedCwd && session?.repoPath) {
        resolvedCwd = session.repoPath as string;
      }

      // If no workspace linked, use @repo mention path as cwd
      if (!resolvedCwd && mentionRepoPath) {
        resolvedCwd = mentionRepoPath;
      }

      // Final fallback: use agent-provided cwd (for non-builtin agents with sourceRepoPath)
      if (!resolvedCwd && cwd) {
        resolvedCwd = cwd;
      }

      // Register active session with resolved cwd — ALL tools in the chain read this
      registerActiveSession({
        chatSessionId: sessionId,
        parentMessageId: assistantMsgId,
        currentAgent: effectiveAgent,
        broadcastEvent: (event, data) => broadcastToListeners(entry, event, data),
        pendingBackgroundTasks: 0,
        resolvedCwd,
      });

      const interruptedContext = await interruptedTaskContext(this.db, sessionId);
      let chatRepoContextPacket: Awaited<ReturnType<ChatContextPacketService['buildChatContextPacket']>> | null = null;
      try {
        chatRepoContextPacket = await new ChatContextPacketService(this.db).buildChatContextPacket({
          sessionId,
          messageId: assistantMsgId,
          agentName: effectiveAgent ?? 'assistant',
          prompt: content,
          provider: provider === 'codex' ? 'codex' : 'claude',
          state: {
            chatSessionId: sessionId,
            chatMessageId: assistantMsgId,
            repoId: session?.repoId,
            repoPath: session?.repoPath,
            repoName: session?.repoName,
            repo_path: session?.repoPath,
            worktree_path: resolvedCwd,
            worktreePath: resolvedCwd,
          },
        });
        if (chatRepoContextPacket?.packetId) {
          console.log(`[chat-context] Resolved packet ${chatRepoContextPacket.packetId} for session ${sessionId}`);
        }
      } catch (err) {
        console.warn(`[chat-context] Failed to build chat context packet: ${(err as Error).message}`);
      }
      const allContext = [mentionContext, workspaceContext, interruptedContext, chatRepoContextPacket?.userTurnContextBlock].filter(Boolean).join('\n');
      const enrichedContent = allContext
        ? `CONTEXT:\n${allContext}\n\nUSER MESSAGE:\n${content}`
        : content;

      // Build message history
      let llmMessages: ChatLLMMessage[];
      const hasSessionResume = (provider === 'claude' || provider === 'codex' || isClaudeCompatibleProvider(provider)) && resumeSessionId;
      if (hasSessionResume) {
        // CLI providers use session resume — only send new message
        llmMessages = [{ role: 'user', content: enrichedContent }];
      } else {
        // API providers need full conversation history
        const history = await this.messages
          .find({ sessionId, status: 'completed' })
          .sort({ createdAt: -1 })
          .limit(30)
          .toArray();
        history.reverse();
        llmMessages = history.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content as string,
        }));
        // Replace last user message with enriched version
        if (llmMessages.length > 0 && llmMessages[llmMessages.length - 1].role === 'user') {
          llmMessages[llmMessages.length - 1].content = enrichedContent;
        }
      }

      // Resolve agent settings (reasoning effort, plan mode) BEFORE building the
      // system prompt — plan mode swaps the base assistant into the read-only
      // Planner persona (brainstorming + PRD authoring), so the resolved
      // planMode flag must be known here.
      //   session.agentOverrides  >  agent defaults  >  assistant default
      // Mutations never propagate back to the agent document — overrides are
      // ephemeral per-session state.
      //
      // When no team agent is selected, the chat talks to the raw assistant;
      // that pseudo-agent defaults to reasoningEffort='high' on codex (which
      // has its own reasoning budget) and 'medium' elsewhere, matching the UI
      // label shown in the ChatInput effort picker.
      const sessionOverrides = (session?.agentOverrides as AgentOverrides | undefined) ?? undefined;

      // The Planner persona (Plan Mode) applies ONLY to the base assistant (no
      // team agent selected) and is provider-agnostic: it is a system-prompt
      // swap, NOT Claude's read-only permissionMode='plan'. So we read the plan
      // toggle intent here and keep planMode OUT of the SDK settings for this
      // path — which also avoids the Claude-only validation in
      // resolveAgentSettings on non-Claude providers (e.g. codex). Team agents
      // keep the original planMode behavior (Claude-only read-only mode).
      const plannerActive = !effectiveAgent && (sessionOverrides?.planMode ?? false);

      let resolvedSettings: ResolvedSettings | undefined;
      try {
        const agentDoc = effectiveAgent
          ? (await this.db.collection('agents').findOne({ name: effectiveAgent }))
          : null;
        const assistantDefaultEffort = provider === 'codex' ? 'high' : 'medium';
        const agentLike: AgentLike = {
          name: effectiveAgent ?? 'default',
          provider,
          model,
          reasoningEffort: agentDoc?.reasoningEffort ?? (effectiveAgent ? undefined : assistantDefaultEffort),
          planMode: agentDoc?.planMode,
        };
        // For the Planner path, drop planMode from the override fed to the
        // resolver: the Planner doesn't use SDK plan mode, and planMode is
        // Claude-only in validation. Everything else (provider/model/effort)
        // resolves normally so the Planner runs exactly like the assistant.
        const overridesForResolve = plannerActive && sessionOverrides
          ? { ...sessionOverrides, planMode: null }
          : sessionOverrides;
        resolvedSettings = resolveAgentSettings(agentLike, [overridesForResolve]);
      } catch (err) {
        // If validation fails we keep going without the override — the log
        // makes it visible so the user can fix it in the UI.
        console.warn(`[chat] resolveAgentSettings failed: ${(err as Error).message}`);
      }

      // Build system prompt: team agent prompt if selected; otherwise the
      // default routing assistant, or the Planner persona when plan mode is
      // toggled on for the base assistant.
      let systemPrompt: string;
      if (effectiveAgent) {
        systemPrompt = await this.buildAgentSystemPrompt(effectiveAgent, provider, content, sessionId);
      } else {
        const persona: ChatPersona = selectChatPersona(plannerActive);
        systemPrompt = await getSystemPrompt(provider, this.db, content, { rootType: 'chat', rootId: sessionId, agentName: persona }, persona);
      }

      // Inject workspace path constraint into system prompt
      if (resolvedCwd && resolvedCwd !== '/tmp/allen') {
        systemPrompt += `\n\nWORKSPACE CONSTRAINT:\nYour working directory is: ${resolvedCwd}\nCRITICAL: ALL file operations (Read, Write, Edit, Grep, Glob, Bash) MUST use paths within this directory.\n- Use relative paths or paths starting with "${resolvedCwd}/"\n- NEVER read, write, or modify files outside this directory\n- If search results show paths outside this directory, replace the base with "${resolvedCwd}/"`;
      }

      // Use already-resolved cwd (workspace path or @repo path)
      const workspaceCwd = resolvedCwd;

      const callbacks = {
        signal: entry.abortController.signal,
        onText: (fullText: string) => {
          const visibleText = sanitizeChatAssistantResponse(fullText);
          entry.currentText = visibleText;
          broadcastToListeners(entry, 'message_delta', { text: visibleText, messageId: assistantMsgId });
        },
        onThinking: (thinking: string) => {
          entry.currentThinking = thinking;
          broadcastToListeners(entry, 'thinking', { text: thinking, messageId: assistantMsgId });
        },
        onToolStart: (tool: string, args: Record<string, unknown>, toolUseId: string) => {
          entry.pendingToolCalls.set(toolUseId, { tool, args, startMs: Date.now() });
          broadcastToListeners(entry, 'tool_start', { tool, args, toolUseId, tool_use_id: toolUseId });
        },
        onToolResult: (tool: string, resultData: Record<string, unknown>, toolUseId: string, durationMs: number) => {
          const pending = entry.pendingToolCalls.get(toolUseId);
          const record: ToolCallRecord = {
            tool,
            args: pending?.args ?? {},
            result: resultData,
            durationMs,
            timestamp: new Date(),
            toolUseId,
          };
          entry.toolCalls.push(record);
          entry.pendingToolCalls.delete(toolUseId);
          this.messages.updateOne(
            { _id: new ObjectId(assistantMsgId) },
            { $set: { content: entry.currentText, thinkingText: entry.currentThinking, toolCalls: entry.toolCalls } },
          ).catch(() => {});
          broadcastToListeners(entry, 'tool_result', { tool, args: record.args, result: resultData, toolUseId, tool_use_id: toolUseId, durationMs });
          const userReport = isReportToUserTool(tool) ? reportToUserPayload(resultData) : null;
          if (userReport) {
            broadcastToListeners(entry, 'agent_report', {
              agent: effectiveAgent ?? 'assistant',
              message: userReport.message,
              status: userReport.status,
              timestamp: new Date().toISOString(),
            });
          }
          if (hasToolError(resultData)) {
            new MonitoringService(this.db).handleEvent({
              sourceType: 'tool_call',
              sourceId: toolUseId ?? `${sessionId}:${tool}`,
              title: `Chat tool call issue: ${tool}`,
              error: typeof resultData === 'string' ? resultData : JSON.stringify(resultData).slice(0, 1000),
              rootCauseArea: 'tool_integration',
              severity: 'medium',
              confidence: 0.72,
              failureMode: 'chat_tool_result_error',
              relatedIds: { chatSessionId: sessionId, chatMessageId: assistantMsgId, tool },
            }).catch(() => {});
          }
        },
        onSessionId: (sid: string) => {
          entry.llmSessionId = sid;
          // Save session ID to DB immediately so auto-retry can resume even if the process times out
          this.sessions.updateOne(
            { _id: new ObjectId(sessionId) },
            { $set: { llmSessionId: sid } },
          ).catch(() => {});
        },
      };

      const effectiveProvider = (resolvedSettings?.provider as ChatProvider) ?? provider;
      const effectiveModel = resolvedSettings?.model || model || PROVIDERS.find(p => p.provider === effectiveProvider)?.defaultModel || 'gpt-5.5';
      const slashCommand = (() => {
        if (effectiveProvider === 'codex') {
          return resolveSlashCommand(content, listSlashCommands('codex', workspaceCwd));
        }
        if (isClaudeFamilyProvider(effectiveProvider)) {
          return resolveSlashCommand(content, listSlashCommands('claude', workspaceCwd));
        }
        return null;
      })();

      const result = slashCommand
        ? {
            ...(await runPersistentChatSlashCommand({
              db: this.db,
              chatSessionId: sessionId,
              provider: effectiveProvider,
              model: effectiveModel,
              resolvedSettings,
              systemPrompt,
              messages: llmMessages,
              resumeSessionId: hasSessionResume ? resumeSessionId : undefined,
              skipTools: undefined,
              cwd: workspaceCwd,
              callbacks,
            }, slashCommand)),
            durationMs: Date.now() - startMs,
            model: effectiveModel,
            provider: effectiveProvider,
          }
        : await runChatLLM(this.db, {
            provider: effectiveProvider,
            model: effectiveModel,
            resolvedSettings,
            systemPrompt,
            messages: llmMessages,
            resumeSessionId: hasSessionResume ? resumeSessionId : undefined,
            cwd: workspaceCwd,
            // Forwarded down to the Allen MCP subprocess as
            // ALLEN_ARTIFACT_ROOT_TYPE=chat / ALLEN_ARTIFACT_ROOT_ID=<sessionId>
            // so allen_save_artifact files under this chat session.
            chatSessionId: sessionId,
            ...callbacks,
          });

      clearInterval(saveInterval);
      const durationMs = Date.now() - startMs;
      const tokenUsage = result.tokenUsage ?? null;
      // Authoritative cost: registry per-MTok prices × token usage; the
      // provider-reported figure is only a fallback (REQ-021/022).
      const costUsd = (await resolveCostUsd(this.db, effectiveModel, tokenUsage, result.costUsd)).amount;
      const visibleResponseText = sanitizeChatAssistantResponse(result.text);
      entry.currentText = visibleResponseText;

      await this.messages.updateOne(
        { _id: new ObjectId(assistantMsgId) },
        { $set: { content: visibleResponseText, status: 'completed', costUsd, durationMs, tokenUsage, toolCalls: entry.toolCalls, thinkingText: entry.currentThinking, completedAt: new Date() } },
      );

      // Save execution trace to chat_logs (fire-and-forget)
      this.db.collection('chat_logs').insertOne({
        sessionId,
        messageId: assistantMsgId,
        llmSessionId: result.sessionId,
        userMessage: content,
        assistantResponse: visibleResponseText.slice(0, 2000),
        model: result.model,
        costUsd,
        tokenUsage,
        durationMs,
        toolCalls: entry.toolCalls,
        trace: result.trace,
        repoKnowledgeInjected: chatRepoContextPacket?.traceSummary,
        status: 'completed',
        timestamp: new Date(),
      }).catch(() => {});

      if (chatRepoContextPacket?.packetId) {
        new ChatContextPacketService(this.db).recordChatContextUsage({
          sessionId,
          messageId: assistantMsgId,
          agentName: effectiveAgent ?? 'assistant',
          packetId: chatRepoContextPacket.packetId,
          rawResponse: result.text,
          toolCalls: entry.toolCalls,
        }).catch((err) => console.warn(`[chat-context] Failed to record usage: ${(err as Error).message}`));
      }

      // Save llmSessionId for session resume on next message
      const sessionUpdate: Record<string, unknown> = { updatedAt: new Date() };
      if (result.sessionId) sessionUpdate.llmSessionId = result.sessionId;

      // No totalCostUsd accumulation — per-message costUsd rows are the only
      // stored record; session totals are computed on demand from messages
      // (+ linked execution trees). See cost-rollup.service.ts.
      await this.sessions.updateOne(
        { _id: new ObjectId(sessionId) },
        { $set: sessionUpdate },
      );

      broadcastToListeners(entry, 'message_complete', {
        messageId: assistantMsgId, text: visibleResponseText, costUsd, durationMs, tokenUsage, toolCalls: entry.toolCalls, thinkingText: entry.currentThinking,
      });

      // Auto-title strategy: fire exactly once on turn 1, using only the
      // first turn's user message + assistant response. Skip if the user
      // manually set a title or if a title was already generated.
      // Note: sendMessage() inserts both messages and increments messageCount
      // by 2 BEFORE calling runLLM, then runLLM reloads the session. So at
      // this point a "first turn" session has messageCount === 2, not 0.
      const priorCount = (session?.messageCount as number) ?? 0;
      const prevSource = session?.titleSource;
      const shouldAutoTitle = priorCount <= 2 && prevSource !== 'user' && prevSource !== 'auto';
      const responseText = visibleResponseText.trim() || undefined;

      if (shouldAutoTitle) {
        const deterministicTitle = deterministicSessionTaskTitle(content);
        Promise.resolve(deterministicTitle ?? this.generateTitleWithLLM(content, responseText))
          .then(async (generatedTitle) => {
            if (generatedTitle) {
              await this.updateSessionTitle(sessionId, generatedTitle, 'auto');
              broadcastToListeners(entry, 'session_update', { title: generatedTitle });
            }
          })
          .catch((err) => console.error('Failed to generate session title', err.message));
      }

      // One-shot title refresh after the conversation has more context.
      // Fires at most once per session (titleRefreshedAt guards against repeats).
      const refreshThreshold = 8; // messageCount >= 8 = >= 4 turns
      const shouldRefreshTitle =
        priorCount >= refreshThreshold &&
        prevSource === 'auto' &&
        !(session?.titleRefreshedAt) &&
        looksLikeFallbackTitle(session?.title as string | undefined);

      if (shouldRefreshTitle) {
        (async () => {
          try {
            // Fetch first user + first assistant messages for richer context
            const firstMessages = await this.messages
              .find({ sessionId, role: { $in: ['user', 'assistant'] } })
              .sort({ createdAt: 1 })
              .limit(4)
              .toArray();
            const firstUser = (firstMessages.find(m => m.role === 'user')?.content as string | undefined) ?? content;
            const firstAssistant = (firstMessages.find(m => m.role === 'assistant')?.content as string | undefined) ?? responseText ?? '';
            const refreshedTitle = await this.generateTitleWithLLM(firstUser, firstAssistant || undefined);
            if (refreshedTitle) {
              await this.sessions.updateOne(
                { _id: new ObjectId(sessionId) },
                { $set: { title: refreshedTitle, titleSource: 'auto', titleRefreshedAt: new Date(), updatedAt: new Date() } },
              );
              broadcastToListeners(entry, 'session_update', { title: refreshedTitle });
            }
          } catch (err) {
            console.error('[chat-title] one-shot refresh failed:', (err as Error).message);
          }
        })();
      }
    } catch (error) {
      clearInterval(saveInterval);
      const errorMsg = error instanceof Error ? error.message : String(error);

      // If the user cancelled this turn (clicked Stop), the subprocess was
      // killed and we get an abort error. cancelChatSession already marked
      // the message as 'cancelled' and cleaned up — just return silently.
      // Do NOT overwrite the status to 'failed' or log it as an error.
      if (entry.aborted) {
        console.log(`[chat] Turn cancelled by user — skipping error handler`);
        // Auto-title even on abort — same turn-1-only rule as the success path.
        // priorCount counts post-bump (sendMessage already inserted both messages
        // and incremented before runLLM was invoked), so turn 1 reads as 2.
        const priorCount = (session?.messageCount as number) ?? 0;
        const prevSource = session?.titleSource;
        const shouldAutoTitleOnAbort = priorCount <= 2 && prevSource !== 'user' && prevSource !== 'auto';

        if (shouldAutoTitleOnAbort) {
          const deterministicTitle = deterministicSessionTaskTitle(content);
          Promise.resolve(deterministicTitle ?? this.generateTitleWithLLM(content, entry.currentText.trim() || undefined))
            .then(async (generatedTitle) => {
              if (generatedTitle) {
                await this.updateSessionTitle(sessionId, generatedTitle, 'auto');
                broadcastToListeners(entry, 'session_update', { title: generatedTitle });
              }
            })
            .catch(() => {});
        }

        // One-shot title refresh — mirrors the success path refresh block.
        const refreshThresholdAbort = 8;
        const shouldRefreshTitleOnAbort =
          priorCount >= refreshThresholdAbort &&
          prevSource === 'auto' &&
          !(session?.titleRefreshedAt) &&
          looksLikeFallbackTitle(session?.title as string | undefined);

        if (shouldRefreshTitleOnAbort) {
          (async () => {
            try {
              const firstMessages = await this.messages
                .find({ sessionId, role: { $in: ['user', 'assistant'] } })
                .sort({ createdAt: 1 })
                .limit(4)
                .toArray();
              const firstUser = (firstMessages.find(m => m.role === 'user')?.content as string | undefined) ?? content;
              const firstAssistant = (firstMessages.find(m => m.role === 'assistant')?.content as string | undefined) ?? (entry.currentText.trim() || undefined);
              const refreshedTitle = await this.generateTitleWithLLM(firstUser, firstAssistant || undefined);
              if (refreshedTitle) {
                await this.sessions.updateOne(
                  { _id: new ObjectId(sessionId) },
                  { $set: { title: refreshedTitle, titleSource: 'auto', titleRefreshedAt: new Date(), updatedAt: new Date() } },
                );
                broadcastToListeners(entry, 'session_update', { title: refreshedTitle });
              }
            } catch (err) {
              console.error('[chat-title] one-shot refresh failed (abort):', (err as Error).message);
            }
          })();
        }
        return;
      }

      const isTimeout = errorMsg.toLowerCase().includes('timed out') || errorMsg.toLowerCase().includes('timeout');
      console.error('Chat LLM error:', errorMsg);

      // ── Fallback: resume failed after an interrupted turn ──
      // Codex returns "no rollout found" when the previous turn was killed
      // mid-execution. Claude CLI may return similar session-corruption
      // errors. In this case, clear the stale session ID and retry the
      // SAME message without resume — the agent starts a fresh thread but
      // the chat message history (stored in Mongo) is still intact for
      // the system prompt to reference.
      const isResumeFailed = /no rollout found|session.*not found|session.*expired|session.*invalid/i.test(errorMsg);
      const savedSessionId = (await this.sessions.findOne({ _id: new ObjectId(sessionId) }))?.llmSessionId as string | undefined;
      if (isResumeFailed && savedSessionId && retryCount < 1) {
        console.log(`[chat] Resume failed ("${errorMsg.slice(0, 60)}") — clearing stale session and retrying as fresh thread`);
        await this.sessions.updateOne(
          { _id: new ObjectId(sessionId) },
          { $unset: { llmSessionId: '' } },
        ).catch(() => {});
        // Retry the same message — runLLM will see no resumeSessionId and start fresh
        return this.runLLM(sessionId, assistantMsgId, content, entry, agent, retryCount + 1, cwd);
      }

      // Auto-retry on timeout: resume the session with "continue" prompt
      // This handles Codex/Claude CLI process timeouts during long tool runs
      if (isTimeout && savedSessionId && retryCount < 3) {
        console.log(`[chat] Auto-retrying after timeout (attempt ${retryCount + 1}/3), resuming session ${savedSessionId.slice(0, 12)}...`);
        broadcastToListeners(entry, 'agent_report', {
          agent: effectiveAgent ?? 'assistant',
          message: 'Connection timed out — automatically reconnecting and continuing...',
          status: 'in_progress',
          timestamp: new Date().toISOString(),
        });

        // Re-run with "continue from where you left off" as the prompt
        try {
          const retryResult = await runChatLLM(this.db, {
            provider,
            model,
            systemPrompt: effectiveAgent
              ? await this.buildAgentSystemPrompt(effectiveAgent, provider, 'continue', sessionId)
              : await getSystemPrompt(provider, this.db, 'continue', { rootType: 'chat', rootId: sessionId, agentName: 'assistant' }),
            messages: [{ role: 'user', content: 'Continue from where you left off. Complete the task and provide the final response.' }],
            resumeSessionId: savedSessionId,
            // Same artifact-root context as the primary call above so a
            // mid-retry allen_save_artifact still files under this chat.
            chatSessionId: sessionId,
            onText: (fullText) => {
              const visibleText = sanitizeChatAssistantResponse(fullText);
              entry.currentText = visibleText;
              broadcastToListeners(entry, 'message_delta', { text: visibleText, messageId: assistantMsgId });
            },
            onThinking: (thinking) => {
              entry.currentThinking = thinking;
              broadcastToListeners(entry, 'thinking', { text: thinking, messageId: assistantMsgId });
            },
            onToolStart: (tool, args, toolUseId) => {
              entry.pendingToolCalls.set(toolUseId, { tool, args, startMs: Date.now() });
              broadcastToListeners(entry, 'tool_start', { tool, args, toolUseId, tool_use_id: toolUseId });
            },
            onToolResult: (tool, resultData, toolUseId, durationMs) => {
              const pending = entry.pendingToolCalls.get(toolUseId);
              const record = { tool, args: pending?.args ?? {}, result: resultData, durationMs, timestamp: new Date(), toolUseId };
              entry.toolCalls.push(record);
              entry.pendingToolCalls.delete(toolUseId);
              this.messages.updateOne(
                { _id: new ObjectId(assistantMsgId) },
                { $set: { content: entry.currentText, thinkingText: entry.currentThinking, toolCalls: entry.toolCalls } },
              ).catch(() => {});
              broadcastToListeners(entry, 'tool_result', { tool, args: record.args, result: resultData, toolUseId, tool_use_id: toolUseId, durationMs });
              const userReport = isReportToUserTool(tool) ? reportToUserPayload(resultData) : null;
              if (userReport) {
                broadcastToListeners(entry, 'agent_report', {
                  agent: effectiveAgent ?? 'assistant',
                  message: userReport.message,
                  status: userReport.status,
                  timestamp: new Date().toISOString(),
                });
              }
              if (hasToolError(resultData)) {
                new MonitoringService(this.db).handleEvent({
                  sourceType: 'tool_call',
                  sourceId: toolUseId ?? `${sessionId}:${tool}:retry`,
                  title: `Chat retry tool call issue: ${tool}`,
                  error: typeof resultData === 'string' ? resultData : JSON.stringify(resultData).slice(0, 1000),
                  rootCauseArea: 'tool_integration',
                  severity: 'medium',
                  confidence: 0.72,
                  failureMode: 'chat_retry_tool_result_error',
                  relatedIds: { chatSessionId: sessionId, chatMessageId: assistantMsgId, tool },
                }).catch(() => {});
              }
            },
            onSessionId: (sid) => {
              this.sessions.updateOne({ _id: new ObjectId(sessionId) }, { $set: { llmSessionId: sid } }).catch(() => {});
            },
          });

          // Save successful retry result
          const durationMs = Date.now() - startMs;
          const tokenUsage = retryResult.tokenUsage ?? null;
          const retryCostUsd = (await resolveCostUsd(this.db, model, tokenUsage, retryResult.costUsd)).amount;
          const visibleRetryText = sanitizeChatAssistantResponse(retryResult.text);
          entry.currentText = visibleRetryText;
          await this.messages.updateOne(
            { _id: new ObjectId(assistantMsgId) },
            { $set: { content: visibleRetryText, status: 'completed', costUsd: retryCostUsd, durationMs, tokenUsage, toolCalls: entry.toolCalls, thinkingText: entry.currentThinking, completedAt: new Date() } },
          );
          if (retryResult.sessionId) {
            await this.sessions.updateOne({ _id: new ObjectId(sessionId) }, { $set: { llmSessionId: retryResult.sessionId } });
          }
          broadcastToListeners(entry, 'message_complete', { messageId: assistantMsgId, text: visibleRetryText, costUsd: retryCostUsd, durationMs, tokenUsage, toolCalls: entry.toolCalls, thinkingText: entry.currentThinking });
          return; // success — skip error handling below
        } catch (retryErr) {
          console.error('Auto-retry also failed:', retryErr instanceof Error ? retryErr.message : retryErr);
          // Fall through to normal error handling
        }
      }

      await this.messages.updateOne(
        { _id: new ObjectId(assistantMsgId) },
        { $set: { content: entry.currentText || '', status: 'failed', error: errorMsg, toolCalls: entry.toolCalls, thinkingText: entry.currentThinking, completedAt: new Date() } },
      );

      this.db.collection('chat_logs').insertOne({
        sessionId, messageId: assistantMsgId, userMessage: content,
        error: errorMsg, toolCalls: entry.toolCalls, status: 'failed',
        durationMs: Date.now() - startMs, timestamp: new Date(),
      }).catch(() => {});
      new MonitoringService(this.db).handleEvent({
        sourceType: 'chat',
        sourceId: assistantMsgId,
        title: 'Chat LLM error',
        error: errorMsg,
        rootCauseArea: isResumeFailed ? 'allen_repo' : 'unknown',
        severity: isTimeout ? 'medium' : 'high',
        confidence: isResumeFailed || isTimeout ? 0.78 : 0.68,
        failureMode: isTimeout ? 'chat_timeout' : 'chat_llm_error',
        relatedIds: { chatSessionId: sessionId, chatMessageId: assistantMsgId, agent: effectiveAgent },
      }).catch(() => {});

      broadcastToListeners(entry, 'error', { error: errorMsg, messageId: assistantMsgId });
      new AlertService(this.db).onChatError(sessionId, errorMsg).catch(() => {});
    } finally {
      // Wait for background spawns to finish before closing SSE stream
      // Cap at 30s for cleanup — if background tasks are still running after that,
      // they'll complete on their own but the SSE stream closes so UI isn't stuck
      await waitForBackgroundTasks(sessionId, 30_000);
      unregisterActiveSession(sessionId);
      closeStreamListeners(entry);
      activeQueries.delete(sessionId);
      void this.drainQueuedMessages(sessionId).catch(err => console.warn('[chat_queue] drain failed:', err.message));
    }
  }

  /**
   * Build a system prompt for a team agent (PM, Engineer, QA, etc.).
   * Uses the agent's own system prompt and capabilities.
   */
  private async buildAgentSystemPrompt(agentName: string, provider: string, userMessage: string, sessionId?: string): Promise<string> {
    const agentDoc = await this.db.collection('agents').findOne({ name: agentName });
    if (!agentDoc) {
      // Fallback to default if agent not found
      return getSystemPrompt(provider as any, this.db, userMessage);
    }

    const system = (agentDoc.system as string) ?? '';
    const personality = (agentDoc.personality as string) ?? '';
    const displayName = (agentDoc.displayName as string) ?? agentName;
    const canTrigger = (agentDoc.canTrigger as string[]) ?? [];

    const parts = [
      `You are ${displayName} — a team agent in Allen.`,
      system,
    ];

    if (personality) parts.push(`\nPersonality: ${personality}`);

    // Inject the live org chart so the agent can choose the best spawn target.
    try {
      const orgBlock = await buildOrgContextBlock(this.db, {
        forAgent: agentName,
        includeFullChart: true,
        includeMeta: true,
        chartMode: 'summary',
      });
      if (orgBlock) parts.push(`\n${orgBlock}`);
    } catch {}

    if (canTrigger.length > 0) {
      parts.push(`You can trigger workflows: ${canTrigger.join(', ')} using run_workflow.`);
    }

    parts.push(`
SPAWN FLOW:
1. spawn_agent(agent_name, prompt) → returns { execution_id }
2. wait_for_execution(execution_id) → blocks up to 90s
   - "waiting": call wait_for_execution again
   - "waiting_for_input": explain the requested input to the user
   - "completed": done, read response
3. To follow up with context, spawn the same agent again and include the prior execution result or session_id when available.

ASKING THE USER:
- If you need info from the user, call ask_user(question). Blocks until user answers.
- Only use ask_user when NO agent can answer.

RULES:
1. You are an LLM routing agent. Decide from the user's intent whether to answer directly, inspect data with tools, spawn a team/lead/specialist agent, or run an allowed workflow. Do not rely on a backend heuristic router.
2. When the user corrects you, silently call save_learning.
3. Allen Library skills are internal routing playbooks, distinct from Codex/Claude native runtime skills. In Allen chat, unqualified "skills" means Allen Library skills. For every non-trivial Allen-supported request, silently call list_skills first and use the full enabled skill metadata list (name, description, category, triggers, excludes, allowedRoutes, related workflows/agents, priority) to choose the right skill by user intent. Do not pick a skill only because search_skills ranked it highest; search_skills is only an optional hint after metadata review. After selecting the best skill from metadata, call get_skill for that skill before routing or answering. Do not load every skill body up front. Do not mention the selected skill name, skill id, or skill tool calls in user-facing responses unless the user explicitly asks.
4. Capability discovery before route selection: before proposing an execution route, inspect the available Allen workflows, specialized team leads/agents, and relevant external MCP tools that could do the job. Use list_workflows/get_workflow, list_teams/list_agents/get_team/get_agent, and any relevant external MCP discovery/list tools when available. Prefer the most specific workflow or specialized lead/agent that owns the end-to-end task; use raw external MCP tools directly only for simple tool-native queries/actions or as evidence for the selected route.
5. Intent clarity and confirmation: if the user intent, target repo/resource, scope, desired outcome, or best route is unclear, ask a concise clarifying question instead of guessing. Before starting execution that changes state or consumes a specialist/workflow run, present the selected route, short plan, required inputs, expected outputs, and risks/unknowns, then ask the user to confirm. Read-only answers and read-only data queries may proceed without confirmation after evidence is checked.
6. Route by intent:
   - Explicit user target wins when valid. If the user names a workflow, inspect it with get_workflow and run it with exact schema inputs. If the user names an agent/lead, use that agent unless the request is impossible for them.
   - Use spawn_agent for team leads, cross-team coordination, user requests to assign/route/hand off, and specialist execution such as code inspection, implementation, review, testing, docs, or git operations.
   - Use run_workflow only for allowed repeatable multi-step processes that match the task and whose required input schema you can satisfy exactly.
   - Answer directly for normal conversation, explanations, behavior questions, brainstorming, and simple read-only questions unless live Allen data or repo inspection is needed. Give the direct answer first; do not use apology templates, synthetic issue labels, routing summaries, or workflow-style sections for normal answers.
7. For workflows: before every run_workflow call, inspect get_workflow and build input using only the exact parsed.input field names. Do not invent aliases or nested objects.
8. Workspace handling:
   - Direct specialist spawns for implementation/review/testing/docs/git need create_workspace first; pass the returned worktree_path as repo_path.
   - Workflows that already contain a create_workspace node should receive the registered repo_path and create their own isolated worktree.
   - Ask "Which repo?" only when code work is required and no repo/workspace context is available.
9. If a spawned execution is waiting_for_input, explain the requested input to the user and use submit_execution_input after the user answers.
10. If you don't know required information, call ask_user to ask the user.
11. NEVER respond to the user before ALL spawned executions you started for the task are complete, failed, blocked, or clearly still running after progress has been surfaced.
12. Use report_to_user for progress updates. When wait_for_execution returns status="waiting" with progress_message or activity_summary, call report_to_user with a short human-readable update before waiting again. Pass activity_cursor back as activity_since on the next wait call so updates move forward instead of repeating old activity.
12a. Context query for spawned agents: when calling spawn_agent for repo-related work, pass a compact context_query object as a separate tool argument. Include user_request, task_type, retrieval-relevant requirements, topics, target_files/path_hints, and required_categories/preferred_categories when obvious. Consolidate relevant prior chat discussion so phrases like "implement what we discussed" still carry the actual retrieval intent. Never embed context query XML/JSON in prompt. Keep execution guardrails, artifact instructions, no-edit/no-commit/no-PR constraints, and process constraints in prompt, not context_query.
13. RESOURCE LINKS — every PR, ticket, issue, commit, uploaded file, artifact, or deploy you mention MUST be rendered as a clickable markdown link when a URL is available. Use html_url / permalink / publicUrl from the tool response verbatim for external resources; never invent external URLs. For Allen internal resources such as workflow runs, executions, agents, and chat sessions, prefer a UI link when one is provided or the route is known with confidence; otherwise present readable names/statuses and include raw IDs only when useful. Do not expose URL/tool fallback reasoning to the user.
14. INTERRUPTED RERUNS — if this chat has interrupted/cancelled tasks and the user asks to rerun, retry, continue, or restart that work, ask whether to start fresh or resume the cancelled execution. Use resume_execution only after the user chooses resume.
15. ARTIFACTS — when you or a spawned agent produces a standalone document (plan, design, investigation notes, CSV results, JSON config, scratch output), save it via allen_save_artifact. Files are filed under this chat session and appear in the Artifacts panel. Prefer allen_save_artifact over upload_file for in-conversation deliverables — it renders inline (markdown/JSON/CSV) and is scoped to the chat. When spawning sub-agents, tell them to save their own work the same way.
16. Be concise and natural. Respond in markdown when it improves readability. Do not create artificial tracking IDs, issue IDs, labels, or codes unless the user asks for a tracked plan or the ID came from a real tool/resource.`);

    // Inject available repos so agent knows what exists
    try {
      const repos = await this.db.collection('repos').find({ status: 'active' }).toArray();
      if (repos.length > 0) {
        const repoList = repos.map((r: any) => `- ${r.name}: ${r.path} (${(r.detected?.language ?? []).join(', ')})`).join('\n');
        parts.push(`\n## Available Repositories\n${repoList}\nUser references repos with @repo-name. Only ask which repo if the task requires code changes and it's ambiguous.`);
      }
      // Surface the default design repo regardless of status (active, registered,
      // placeholder, etc.) — only archived repos are excluded.  Having a usable
      // path is the key requirement.  This block has different semantics from
      // Available Repositories; it is intentionally OK for the same repo to appear
      // in both sections.  The "do not ask" instruction below is what matters here.
      const defaultDesignRepo = await this.db.collection('repos').findOne({
        isDefaultDesignRepo: true,
        path: { $exists: true, $ne: '' },
        status: { $ne: 'archived' },
      }) as { name: string; path: string } | null;
      if (defaultDesignRepo) {
        parts.push(
          `\n## Default Design Repository\nThe default design output repo is **${defaultDesignRepo.name}** at \`${defaultDesignRepo.path}\`. ` +
          `Use this path as \`repo_path\`/\`design_repo_path\` for design workflow inputs unless the user explicitly provides a different path. ` +
          `Do NOT ask the user which design repo to use when this default is set.`,
        );
      }
    } catch {}

    // Load learnings — agent-scoped + global
    try {
      // 1. Agent-specific learnings
      const agentLearnings = await this.db.collection('learnings')
        .find({ 'scope.level': 'agent', 'scope.agentName': agentName, status: 'active' })
        .sort({ confidence: -1, updatedAt: -1 })
        .limit(5)
        .toArray();

      // 2. Global learnings via embedding similarity
      const { searchSimilar } = await import('./embedding.service.js');
      const globalLearnings = await searchSimilar(this.db, userMessage, { limit: 5, threshold: 0.25 });

      const allLearnings = [
        ...agentLearnings.map(l => `- [${l.type}, ${displayName}] ${l.content}`),
        ...globalLearnings.map(l => `- [${l.type}, global] ${l.content}`),
      ];

      if (allLearnings.length > 0) {
        parts.push(`\n## Memory from past conversations\n${allLearnings.join('\n')}`);
      }
      if (sessionId) {
        await writeMemoryAudit(this.db, {
          rootType: 'chat',
          rootId: sessionId,
          agentName,
          query: userMessage,
          retrievedLearningIds: [
            ...agentLearnings.map(learningId).filter((id): id is string => Boolean(id)),
            ...globalLearnings.map(learningId).filter((id): id is string => Boolean(id)),
          ],
          retrievalScores: globalLearnings.map((l) => l.score),
          injectedLearningIds: [
            ...agentLearnings.map(learningId).filter((id): id is string => Boolean(id)),
            ...globalLearnings.map(learningId).filter((id): id is string => Boolean(id)),
          ],
          injectedTokenCount: Math.ceil(allLearnings.join(' ').split(/\s+/).length * 1.3),
          promptContextHash: Buffer.from(`${agentName}:${userMessage}`).toString('base64').slice(0, 64),
        });
      }
    } catch {}

    return parts.join('\n');
  }

  /**
   * Append a message authored by the automation system to an existing chat session.
   * Used by automation agents to post their generated content into a
   * persistent linked chat thread.
   *
   * Called from POST /api/chat/sessions/:id/automation-message (internal endpoint,
   * token minted by buildInternalApiHeaders in cron.service.ts).
   */
  async appendAutomationMessage(
    sessionId: string,
    role: 'user' | 'assistant',
    content: string,
  ): Promise<{ messageId: string }> {
    // Validate role
    if (!role || !['user', 'assistant'].includes(role)) {
      throw new Error('role must be one of: user, assistant');
    }
    // Validate content
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('content is required');
    }
    if (content.length > 1_000_000) {
      throw new Error('content exceeds maximum length');
    }

    let objectId: ObjectId;
    try {
      objectId = new ObjectId(sessionId);
    } catch {
      throw new Error('Session not found');
    }

    const session = await this.sessions.findOne({ _id: objectId });
    if (!session) {
      throw new Error('Session not found');
    }
    if ((session as Record<string, unknown>).source !== 'automation') {
      throw new Error('Not an automation session');
    }

    const now = new Date();
    const result = await this.messages.insertOne({
      sessionId,
      role,
      content,
      status: 'completed',
      senderSource: 'system',
      createdAt: now,
      completedAt: now,
    });

    await this.sessions.updateOne(
      { _id: objectId },
      {
        $inc: { messageCount: 1 },
        $set: { lastMessageAt: now, updatedAt: now },
      },
    );

    return { messageId: result.insertedId.toHexString() };
  }

  async updateSessionTitle(sessionId: string, title: string, titleSource: 'default' | 'auto' | 'user' = 'user'): Promise<void> {
    const safeTitle = titleSource === 'user'
      ? (sanitizeChatTitle(title) ?? 'New Conversation')
      : (sanitizeChatTitle(title) ?? fallbackTitleFromUserMessage(title));
    await this.sessions.updateOne(
      { _id: new ObjectId(sessionId) },
      { $set: { title: safeTitle, titleSource, updatedAt: new Date() } }
    );
  }

  async updateSession(
    id: string,
    update: {
      title?: string;
      status?: 'active' | 'archived';
      provider?: string;
      model?: string;
      agentOverrides?: Record<string, unknown> | null;
    },
  ): Promise<ChatSession | null> {
    // Only whitelist known fields so clients can't smuggle arbitrary keys in.
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (update.title !== undefined) {
      set.title = sanitizeChatTitle(update.title) ?? 'New Conversation';
      set.titleSource = 'user';
    }
    if (update.status !== undefined) set.status = update.status;
    if (update.provider !== undefined) set.provider = update.provider;
    if (update.model !== undefined) set.model = update.model;
    if (update.agentOverrides !== undefined) set.agentOverrides = update.agentOverrides;
    await this.sessions.updateOne({ _id: new ObjectId(id) }, { $set: set });
    return this.sessions.findOne({ _id: new ObjectId(id) }) as Promise<ChatSession | null>;
  }

  async deleteSession(id: string): Promise<void> {
    await this.messages.deleteMany({ sessionId: id });
    await this.sessions.deleteOne({ _id: new ObjectId(id) });
  }
}

/**
 * Idempotent startup migration. For sessions missing ownerUserId, derive the
 * owner from the session's earliest user message (the same heuristic the old
 * read-side $lookup used). Run once at boot — sessions created after this
 * change get ownerUserId set inline in createSession().
 *
 * Uses only plain find/update calls so it works on Amazon DocumentDB, which
 * doesn't support $lookup with let+pipeline combining $expr and a field match.
 */
export async function backfillSessionOwners(db: Db): Promise<{ scanned: number; updated: number }> {
  const sessions = db.collection('chat_sessions');
  const messages = db.collection('chat_messages');
  const cursor = sessions.find(
    { ownerUserId: { $exists: false } },
    { projection: { _id: 1 } },
  );
  let scanned = 0;
  let updated = 0;
  for await (const s of cursor) {
    scanned++;
    const sid = String(s._id);
    const firstUserMsg = await messages.findOne(
      { sessionId: sid, role: 'user' },
      { sort: { createdAt: 1 }, projection: { senderUserId: 1, senderName: 1, senderEmail: 1 } },
    );
    const set: Record<string, unknown> = {
      ownerUserId: firstUserMsg?.senderUserId ?? null,
      ownerName: firstUserMsg?.senderName ?? null,
      ownerEmail: firstUserMsg?.senderEmail ?? null,
    };
    await sessions.updateOne({ _id: s._id }, { $set: set });
    updated++;
  }
  return { scanned, updated };
}
