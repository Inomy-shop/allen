import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import type { Db } from 'mongodb';
import { loadAgents, validateWorkflow, getBuiltIns } from '@allen/engine';
import type { WorkflowDef } from '@allen/engine';
import { isSeedOverrideEnabled } from './services/seed-policy.js';
import { normalizeNodeOverridesForProvider } from './services/llm-defaults.js';
import type { SkillInput } from './services/skill.service.js';
import { notDeletedFilter, restoreSet } from './services/soft-delete.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Full text of the coding-guidelines skill body. Exported so OrgSeedService can
 * inline the same content into the system prompts of code-writing and
 * design/planning specialist agents — keeping the skill row and the inlined
 * prompt copies in lock-step from a single source.
 */
export const CODING_GUIDELINES_BODY = `# Coding Guidelines

These guidelines exist to reduce common failure modes when LLMs write or modify code. Apply them whenever you are editing, creating, or refactoring files — not for routing decisions, planning, or investigation work.

## Think Before Coding

Before touching any file:
1. **Surface assumptions** — state every assumption explicitly. If you are not sure about scope, intent, or expected behaviour, surface the uncertainty and ask rather than guess.
2. **Define success criteria** — articulate what "done" looks like in concrete, verifiable terms before you start. "The build passes and the test for AC-003 goes green" is good; "looks right" is not.
3. **Read the existing code** — always read the files you intend to change before changing them. Match existing conventions, naming patterns, and import style.

## Simplicity First

- **Minimum code** — write the least code that correctly satisfies the requirement. No speculative abstractions, no unused helpers, no "we'll need this later" scaffolding.
- **No over-engineering** — if a simple imperative block works, prefer it over a generic abstraction. Introduce abstractions only when they directly reduce duplication that exists *today*.
- **Boring is good** — prefer well-understood patterns and library features over novel or clever constructs.

## Surgical Changes

- **Touch only what you must** — change only the files and lines the task requires. Do not fix style issues, rename symbols, or refactor code that is not in your task unless explicitly asked.
- **One concern per change** — do not bundle unrelated fixes into a single diff. If you spot a secondary issue, note it in your output but do not change it without instruction.
- **Match the existing style** — indentation, quote style, import order, line length — match what is already there, even if your preference differs.

## Goal-Driven Execution

- **Every changed line traces to the request** — if you cannot name the requirement, acceptance criterion, or task item that justifies a line of code, remove that line.
- **Verify before reporting done** — run the build, the lint, and the relevant tests. Report the concrete command output, not "it should work". If a check fails, fix it or escalate; never silently skip it.
- **Fail loudly** — if a constraint cannot be met (type error, missing dependency, conflicting requirement), surface the exact error and stop rather than working around it silently.`;

/**
 * Full text of the prd-authoring skill body. Exported so the Planner persona
 * (and any design/product agent) can load the same playbook for writing clear,
 * implementation-ready PRDs from a single source of truth. The defining
 * constraint: a PRD describes WHAT and WHY in plain language so a downstream
 * agent can implement it — it never contains code, pseudo-code, or other
 * technical implementation snippets.
 */
export const PRD_AUTHORING_BODY = `# PRD Authoring

A playbook for writing a Product Requirements Document that a downstream implementing agent can pick up and build without guessing. Apply it whenever you are asked to produce a PRD, product spec, or requirements doc.

## When to use
Use when the user asks for a PRD / spec / requirements doc, or confirms they want the brainstorm written up as one.

## When not to use
Not for implementing, routing work to agents, reviewing code, or casual questions. Writing a PRD is a planning/authoring act, not an execution act.

## Core principles
- **Never assume.** If the problem, target users, scope, constraints, or success criteria are unclear, ask concise clarifying questions first. Capture anything still unconfirmed under "Open questions" — never invent a requirement, user, metric, or acceptance criterion to fill a gap.
- **Write for the implementer.** The reader is an AI (or human) agent who will build this. Every statement must be unambiguous, self-contained, and testable. Prefer plain, precise language over cleverness.
- **NO technical code snippets.** A PRD describes WHAT must be true and WHY, not HOW to code it. Do not include code, pseudo-code, function/class signatures, API request/response bodies, SQL/DDL, config file contents, shell commands, or file diffs. If an interface or data point matters, describe it in prose (e.g. "the user supplies an email address and a password"), not as code. Naming a technology only belongs here if the user explicitly required it — then state it as a constraint, in words.
- **Requirements are behavioral, acceptance criteria are observable.** Requirements say what the user/system must be able to do. Acceptance criteria are the checkable conditions that prove a requirement is met — not implementation steps.

## Structure
Produce these sections (omit any that genuinely do not apply; never pad with invented content):
1. **Title & one-line summary**
2. **Problem / background** — why this matters, who is affected, what is broken or missing today.
3. **Goals & non-goals** — explicit scope boundaries; non-goals prevent scope creep.
4. **Target users / personas** — who this is for and what they are trying to achieve.
5. **User requirements** — numbered functional requirements (R1, R2, …), each a single clear statement of what the user must be able to do.
6. **Acceptance criteria** — for each requirement, one or more testable, unambiguous criteria (Given/When/Then or a checklist). These define "done".
7. **Success metrics** — only if the user has given or confirmed them.
8. **Dependencies, constraints, risks** — external systems, prerequisites, known limits.
9. **Open questions** — everything still unconfirmed. Never silently resolve these by assumption.

## Quality bar (so an agent can implement it directly)
- Every requirement has a unique ID and at least one acceptance criterion.
- Acceptance criteria are observable/verifiable, free of implementation detail.
- No code or technical snippets anywhere in the document.
- Scope is bounded by explicit non-goals.
- All ambiguity is captured as Open questions, not guessed.

## Output
Save the PRD as a markdown artifact via allen_save_artifact (e.g. \`prd-<slug>.md\`), filed under the current chat session, link to it with its publicUrl, and also show it inline so the user can read it without leaving chat.`;

/**
 * Seed the database with agents returned by loadAgents().
 *
 * NOTE: loadAgents() no longer reads agents.yml by default — the legacy
 * fallback was removed in favour of OrgSeedService (org-seed.ts), which is
 * the authoritative agent seed called at startup. This function is kept for
 * compatibility but is NOT invoked by app.ts (see the commented-out call
 * there). Calling it without a customPath argument will produce zero agents.
 */
export async function seedDefaultAgents(db: Db): Promise<void> {
  const col = db.collection('agents');
  const agents = loadAgents();
  const override = isSeedOverrideEnabled();
  let created = 0;
  let updated = 0;

  for (const [name, agent] of Object.entries(agents)) {
    const existing = await col.findOne({ name });
    const doc = {
      system: agent.system,
      model: agent.model,
      provider: agent.provider,
      tools: agent.tools,
      icon: agent.icon,
      color: agent.color,
      type: agent.type ?? 'technical',
      displayName: agent.displayName ?? name,
      personality: agent.personality,
      capabilities: agent.capabilities ?? [],
      spawnTargets: agent.spawnTargets ?? [],
      canTrigger: agent.canTrigger ?? [],
      isBuiltIn: true,
      createdBy: 'seed',
    };

    if (!existing) {
      await col.insertOne({ name, ...doc, createdAt: new Date(), updatedAt: new Date() });
      created++;
    } else if (existing.isDeleted) {
      if (override) {
        // Restore soft-deleted agent with current seed data
        await col.updateOne({ name }, restoreSet({ name, ...doc }));
        updated++;
      }
      // If not overriding, skip — don't re-insert a soft-deleted agent
    } else if (override) {
      await col.updateOne({ name }, { $set: { ...doc, updatedAt: new Date() } });
      updated++;
    }
  }

  // Ensure indexes for agent_conversations collection
  const convCol = db.collection('agent_conversations');
  await convCol.createIndex({ chatSessionId: 1 }).catch(() => {});
  await convCol.createIndex({ fromAgent: 1, toAgent: 1 }).catch(() => {});

  console.log(`Seeded ${created} new, updated ${updated} default agents (${Object.keys(agents).length} checked)`);
}

/**
 * Seed the database with default workflows from the engine's workflows/ directory.
 */
/**
 * Walk a parsed workflow's nodes and rewrite each node's `agentOverrides`
 * through `normalizeNodeOverridesForProvider`. Mutates the input. When all
 * fields in an override get stripped, drop the empty object entirely so the
 * DB row stays clean.
 *
 * The YAML source on disk is untouched — only the `parsed` representation
 * that gets stored in the workflow document and used at execution time is
 * normalized for the active provider.
 */
/**
 * Locate the engine's workflows YAML directory. Same lookup
 * `seedDefaultWorkflows` uses — kept as a single source of truth so
 * downstream consumers (e.g. cleanup keep-lists) read the same files.
 */
function findWorkflowDir(): string | null {
  const possiblePaths = [
    join(__dirname, '..', '..', 'engine', 'workflows'),
    join(__dirname, '..', '..', '..', 'engine', 'workflows'),
  ];
  for (const p of possiblePaths) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Read all YAML workflow files in the engine's workflows/ directory and
 * return each workflow's `name` field. Used by org-cleanup to build a
 * keep-list automatically so any YAML on disk is protected from deletion
 * without anyone having to maintain a hardcoded mirror list.
 *
 * Returns [] when the directory can't be found (uncommon — dev + prod
 * layouts are both covered) or when YAMLs fail to parse. Treating failure
 * as "empty keep list" would cause data loss, so call sites should pair
 * this with the cleanup's `keepWorkflows` parameter knowing that a return
 * of [] still triggers deletion. If that's a concern, gate cleanup on
 * a non-empty result.
 */
export function listDefaultWorkflowNames(): string[] {
  const dir = findWorkflowDir();
  if (!dir) return [];
  const files = readdirSync(dir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
  const names: string[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), 'utf-8');
      const parsed = yaml.load(content) as { name?: unknown } | null;
      if (parsed && typeof parsed.name === 'string' && parsed.name.length > 0) {
        names.push(parsed.name);
      }
    } catch {
      // Skip unparseable files — they'll surface as a separate error
      // during seedDefaultWorkflows. We don't want to corrupt the
      // keep-list on a single bad YAML.
    }
  }
  return names;
}

async function normalizeWorkflowNodeOverrides(parsed: WorkflowDef, db: Db): Promise<void> {
  const nodes = (parsed.nodes ?? {}) as Record<string, Record<string, unknown>>;
  for (const node of Object.values(nodes)) {
    if (node.agentOverrides === undefined || node.agentOverrides === null) continue;
    const normalized = await normalizeNodeOverridesForProvider(node.agentOverrides as Record<string, unknown>, db);
    if (!normalized || Object.keys(normalized).length === 0) {
      delete node.agentOverrides;
    } else {
      node.agentOverrides = normalized;
    }
  }
}

export async function seedDefaultWorkflows(db: Db): Promise<void> {
  const col = db.collection('workflows');
  const yamlAgents = loadAgents();
  const builtInNames = Object.keys(getBuiltIns());

  // Merge DB agents (source of truth) with YAML agents for validation
  const dbAgents = await db.collection('agents').find(notDeletedFilter, { projection: { name: 1, system: 1 } }).toArray();
  const agents: Record<string, any> = { ...yamlAgents };
  for (const a of dbAgents) {
    agents[a.name as string] = { system: (a.system as string) ?? '' };
  }

  // Locate the engine's workflows directory
  const possiblePaths = [
    join(__dirname, '..', '..', 'engine', 'workflows'),
    join(__dirname, '..', '..', '..', 'engine', 'workflows'),
  ];

  let workflowDir: string | null = null;
  for (const p of possiblePaths) {
    if (existsSync(p)) {
      workflowDir = p;
      break;
    }
  }

  if (!workflowDir) {
    console.log('No default workflows directory found — skipping seed');
    return;
  }

  let seeded = 0;
  let updated = 0;
  const override = isSeedOverrideEnabled();
  const files = readdirSync(workflowDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));

  for (const file of files) {
    const content = readFileSync(join(workflowDir, file), 'utf-8');
    const parsed = yaml.load(content) as WorkflowDef;

    // Strip claude-only fields when the setup picked codex (and vice versa)
    // so workflow YAMLs authored for one provider degrade gracefully on the
    // other. Preserve mode (no env) leaves overrides untouched.
    await normalizeWorkflowNodeOverrides(parsed, db);

    const existing = await col.findOne({ name: parsed.name });
    const validation = validateWorkflow(parsed, agents, builtInNames);

    if (!existing) {
      await col.insertOne({
        name: parsed.name,
        description: parsed.description ?? '',
        version: 1,
        yaml: content,
        parsed,
        reactFlowData: null,
        validation,
        tags: ['default'],
        createdBy: 'system',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      seeded++;
      continue;
    }

    if (existing.isDeleted) {
      if (override) {
        // Restore soft-deleted workflow with current YAML content
        const restoredDoc = {
          name: parsed.name,
          description: parsed.description ?? '',
          version: 1,
          yaml: content,
          parsed,
          reactFlowData: null,
          validation,
          tags: ['default'],
          createdBy: 'system',
        };
        await col.updateOne({ name: parsed.name }, restoreSet(restoredDoc));
        updated++;
        console.log(`[seed] Restored soft-deleted workflow: ${parsed.name}`);
      }
      continue;
    }

    // Auto-update existing workflows only when explicitly requested.
    // Also refresh under SEED_OVERRIDE when the env-driven override
    // normalization produced a different `parsed.nodes` shape than what's
    // stored — that lets an operator re-run setup with a different provider
    // and pick up the refreshed agentOverrides by setting SEED_OVERRIDE=true,
    // without having to edit the YAML on disk.
    const yamlChanged = existing.yaml !== content;
    const normalizationChanged =
      JSON.stringify(existing.parsed?.nodes ?? {}) !== JSON.stringify(parsed.nodes ?? {});
    const validationChanged =
      JSON.stringify(existing.validation ?? null) !== JSON.stringify(validation);
    if (override && (yamlChanged || normalizationChanged)) {
      await col.updateOne(
        { _id: existing._id },
        {
          $set: {
            description: parsed.description ?? '',
            yaml: content,
            parsed,
            validation,
            updatedAt: new Date(),
          },
        },
      );
      updated++;
      console.log(`[seed] Updated built-in workflow: ${parsed.name}`);
    } else if (validationChanged) {
      await col.updateOne(
        { _id: existing._id },
        {
          $set: {
            validation,
            updatedAt: new Date(),
          },
        },
      );
      updated++;
      console.log(`[seed] Refreshed workflow validation: ${parsed.name}`);
    }
  }

  console.log(`Seeded ${seeded} new, updated ${updated} default workflows (${files.length} checked)`);
}

const SKILL_CLARIFY_CONFIRM_SECTION = `## Clarify and confirm
If the user's intent, target repo/resource, scope, or desired outcome is unclear, ask a concise clarifying question before choosing a route. Do not guess or assume missing intent.

Before starting execution that changes state or consumes a specialist/workflow run, present the selected route, short plan, required inputs, expected outputs, and any risks or unknowns, then ask the user to confirm. Read-only answers and read-only data queries may proceed without confirmation after evidence is checked.`;

const SKILL_CAPABILITY_DISCOVERY_SECTION = `## Capability discovery
Before choosing an execution route, inspect the available Allen workflows, specialized team leads/agents, and relevant external MCP tools that could do the job. Prefer the most specific workflow or specialized lead/agent that owns the end-to-end task. Use raw external MCP tools directly only for simple tool-native queries/actions or as evidence for the selected route. Keep skill selection internal; do not mention skill names or skill IDs in user-facing responses unless the user explicitly asks.`;

const SKILL_ASSIGN_TO_AGENTS_SECTION = `## Assign to agents
Allen's org chart, agent library, and workflow catalog are dynamic — teams, agents, skills, and workflows are added, renamed, retired, and re-scoped over time. Do not assume any specific agent, team, or workflow name exists. Always discover the right target at runtime from the user's intent and the current state of the system.

When the user's request matches a task that an existing workflow, team lead, or specialist owns, route through it. The top-level assistant must not perform the owner's job directly:

- State-changing meta operations (create/edit teams, agents, workflows, skills) → spawn the meta builder whose description matches the operation. Never call create_team / create_agent / create_workflow / create_skill from the top-level assistant.
- Code changes (file edits, commits, pushes, PRs) → spawn the team lead whose team owns the relevant domain, or spawn the specialist whose description matches the change. The top-level assistant must not touch files, branches, or PRs directly.
- Test/build/lint authoring or fixes → route through the team or specialist whose mission covers quality and testing.
- Domain-specific work (data, ops, search, vendor onboarding, product strategy, etc.) → use the team lead or specialist whose mission/description matches the domain rather than acting via raw MCP tools.
- Multi-step repeatable processes → prefer a registered workflow over hand-orchestrating specialists, when the workflow's description and required inputs match.

Discovery procedure (run before choosing a target):
1. Classify the user's intent into a primary domain (org/meta, code, test, data, ops, product, search, etc.) and the type of action (create, edit, investigate, explain, run).
2. Read this skill's relatedAgents / relatedWorkflows as soft hints — they may be stale; verify each still exists via list_agents / list_workflows before relying on them.
3. Run list_teams, list_agents, and/or list_workflows scoped to the inferred domain. Read descriptions, missions, categories, and (for agents) team membership.
4. Pick the most specific match by description/mission. Prefer a team lead when coordination across specialties is needed; prefer a single specialist for narrow one-shot work; prefer a workflow when the steps are well-defined and inputs are satisfiable.
5. If no match exists, ask the user how to proceed — register a new agent/workflow via the matching meta-builder, or proceed via raw tools only with explicit user confirmation.

If wait_for_execution returns "waiting", keep waiting with wait_for_execution until status is "completed", "failed", "cancelled", or "waiting_for_input". For a follow-up, call spawn_agent again with the prior session_id when available.

Top-level direct tool calls are reserved for: read-only data queries, normal conversation, explanation/brainstorming, and forwarding answers to a spawned execution that is waiting for input.`;

function withSkillOperatingRules(body: string): string {
  let next = body.trim();
  const lower = next.toLowerCase();
  if (!lower.includes('## clarify and confirm')) {
    next = `${next}\n\n${SKILL_CLARIFY_CONFIRM_SECTION}`;
  }
  if (!lower.includes('## capability discovery')) {
    next = `${next}\n\n${SKILL_CAPABILITY_DISCOVERY_SECTION}`;
  }
  if (!lower.includes('## assign to agents')) {
    next = `${next}\n\n${SKILL_ASSIGN_TO_AGENTS_SECTION}`;
  }
  return next;
}

const DEFAULT_SKILLS: SkillInput[] = [
  {
    name: 'capability-routing',
    displayName: 'Capability Routing',
    category: 'routing',
    description: 'General routing fallback for Allen-supported work: discover matching workflows, specialized leads/agents, and external MCP tools before choosing a route.',
    triggers: ['route', 'which agent', 'what will use', 'who should handle', 'handle this', 'do this', 'run this', 'assign this', 'execute this'],
    excludes: ['hi', 'hello'],
    priority: 92,
    allowedRoutes: ['direct_answer', 'data_query', 'spawn_agent', 'run_workflow'],
    body: `# Capability Routing

## When to use
Use for any non-trivial Allen-supported request when a more specific skill is not clearly better, especially domain work where an existing workflow, lead, specialist agent, or external MCP tool may already own the task.

## When not to use
Do not use for simple greetings, casual conversation, or purely general questions that do not require live Allen capability discovery.

## Evidence
Inspect available Allen workflows, teams, agents, and relevant external MCP tools before selecting a route. For plausible candidates, load details instead of relying only on names. Check specialist descriptions and lead/team ownership before using raw MCP tools.

## Routing
- If a workflow owns the end-to-end task and required inputs are available or can be clarified, propose that workflow.
- If a team lead or specialist agent owns the task, propose spawning that lead or specialist.
- If an external MCP tool is the best direct fit for a simple query/action, use or propose that tool.
- If none fit, explain the gap and ask whether to create/update a workflow, agent, or skill.

## Output
Return only the selected route, short plan, required inputs, expected output, risks/unknowns, and confirmation question when execution is needed. Do not mention skill name/id unless the user explicitly asks.`,
  },
  {
    name: 'repo-evidence',
    displayName: 'Repo Evidence',
    category: 'investigation',
    description: 'Use before answering repo/module/implementation questions so claims are grounded in code or tool evidence.',
    triggers: ['how does', 'module', 'repo', 'implementation', 'architecture', 'files involved', 'where is'],
    excludes: ['fix', 'implement', 'create workflow', 'create agent'],
    priority: 90,
    allowedRoutes: ['direct_answer', 'spawn_agent'],
    relatedAgents: ['codebase-navigator'],
    body: `# Repo Evidence

## When to use
Use when the user asks how a specific repository, module, feature, file, dependency, or architecture works.

## When not to use
Do not use as the final route when the user clearly asks to change code. Use this first for evidence, then route through bug, feature, review, or workspace/PR skills.

## Evidence
Identify the target repo first. Inspect source files, docs, tests, traces, or spawn a read-only codebase-navigator. Do not claim existing behavior without evidence. Mention the files or tool results checked.

## Routing
- If the answer can be supported by inspected evidence, answer directly.
- If the module is broad or unclear, spawn a read-only specialist.
- If investigation reveals a requested code change, hand off to the relevant routing skill.

## Output
Return evidence checked, module summary, data/control flow, important dependencies, unknowns, and suggested next step.`,
  },
  {
    name: 'execution-investigation',
    displayName: 'Execution Investigation',
    category: 'operations',
    description: 'Investigate workflow/agent/chat execution state, queueing, pauses, failures, logs, traces, and interventions.',
    triggers: ['why queued', 'why failed', 'workflow paused', 'execution', 'trace', 'logs', 'conversation', 'what happened'],
    excludes: ['build feature', 'fix bug in repo'],
    priority: 88,
    allowedRoutes: ['direct_answer', 'data_query', 'spawn_agent'],
    body: `# Execution Investigation

## When to use
Use when the user asks about a chat, workflow, agent execution, queueing, waiting for input, failure, trace, or log behavior.

## When not to use
Do not start an implementation workflow unless the user asks to fix the discovered issue.

## Evidence
Inspect executions, traces, logs, pending interventions, workflow definitions, chat history, and relevant database rows. Use the exact execution id, chat id, PR URL, or workflow name when provided.

## Routing
- Read execution state directly when enough identifiers are present.
- Search recent executions when the identifier is missing but context is clear.
- Spawn a read-only specialist only for deep trace analysis.
- If the issue requires a product/code fix, escalate to bug-fix-routing or feature-routing.

## Output
State the observed status, evidence checked, root cause or likely reason, and the next operational action.`,
  },
  {
    name: 'linear-management',
    displayName: 'Linear Management',
    category: 'external-data',
    description: 'Handle Linear issue queries, summaries, creation, updates, assignment, and dispatch decisions.',
    triggers: ['linear', 'ticket', 'issue', 'sprint', 'closed today', 'assign ticket', 'dispatch ticket'],
    excludes: ['github pr review'],
    priority: 86,
    allowedRoutes: ['direct_answer', 'data_query', 'spawn_agent', 'run_workflow'],
    body: `# Linear Management

## When to use
Use for Linear issue lookup, reporting, creation, updates, assignment, status changes, and dispatching ticket work.

## When not to use
Do not use as the final route for code changes described by a ticket. Use it to read the ticket, then route by task shape.

## Evidence
Discover available Linear or external issue tools at runtime. Query current ticket data before answering. Respect date boundaries and the user's timezone for relative dates.

## Routing
- Reporting/query requests use direct data query and answer directly.
- Ticket creation/update uses the available issue-management tool.
- Ticket asks for implementation: inspect ticket, identify repo, then use bug-fix-routing, feature-routing, review-routing, or team-assignment-routing.

## Ticket content requirements (MANDATORY for create AND update)
Whenever a Linear issue is **created OR updated**, the description MUST capture all investigation done and any artifacts produced **in this session or already known from the conversation context**. Never create or update a ticket with only a title and a one-line summary when richer data is available.

**Core rule: if the data exists, put it in the ticket.** Walk through the session before writing the description and pull in every relevant fact you already have — investigation findings, file paths, error messages, log excerpts, evidence bundle ids, PR/commit links, screenshots, repro steps, acceptance criteria. Do not summarize away detail that the reader will need; paste it in.

**Every section listed below MUST be present in the description. If — and only if — a section truly has no data, write the explicit placeholder for that section instead of omitting it.** Silent omission is forbidden because a missing section is indistinguishable from "we forgot to check." Using a placeholder when data actually exists is also forbidden — that is worse than omission, because it actively misleads the reader.

When updating an existing ticket: preserve any sections the ticket already has, merge new findings into the right section (don't duplicate), and replace any prior placeholder with the real data now that it's known.

Required sections (use these exact headings):

1. \`## Investigation\` — Every relevant finding gathered in this session: what was checked and why, file paths with \`path:line\` references, function/symbol names, error messages, log excerpts, hypotheses considered and which were ruled out.
   - Placeholder when empty: \`> No investigation has been done yet — ticket filed for triage.\`

2. \`## Root Cause\` — Current understanding of the root cause.
   - Placeholder when empty: \`> Root cause not yet identified — needs further investigation.\`

3. \`## Artifacts\` — Files created/edited, evidence bundles, screenshots, logs, diffs, query results, design docs, PR links, commit SHAs, dashboard URLs, repro scripts, allen monitoring evidence bundle ids, execution/trace ids.
   - Files: include relative/absolute paths AND paste the relevant excerpt in a fenced code block. If a file is too large or binary, link to it (PR diff URL, gist, S3 link) or note its exact location.
   - Images/screenshots: upload via Linear's attachment mechanism if available; otherwise link the source URL.
   - Commands and their output: include the command and a trimmed but representative output block.
   - PRs/commits/external dashboards: include full URLs, not bare identifiers.
   - Allen evidence bundle ids / execution ids / trace ids: list them so a reader can pull them up.
   - Placeholder when empty: \`> No artifacts produced for this ticket.\`

4. \`## Reproduction\` — Exact steps to reproduce or the conditions under which the issue surfaced.
   - Placeholder when empty: \`> No reproduction steps available yet.\`

5. \`## Acceptance Criteria / Next Actions\` — What "done" looks like and any follow-up tasks already identified.
   - Placeholder when empty: \`> Acceptance criteria not yet defined.\`

Before creating or updating the issue, confirm the assembled title + description with the user. After the create/update, report the issue identifier/URL and confirm every required section (including any placeholders used) was attached, plus list which sections were filled with real data vs. left as placeholders.

## Output
Return issue identifiers, titles, state, owner, dates, links, and any assumptions about filtering. For newly-created issues, also confirm that the Investigation and Artifacts sections were included.`,
  },
  {
    name: 'issue-investigation',
    displayName: 'Issue Investigation',
    category: 'investigation',
    description: 'Read-only investigation and root-cause analysis before deciding whether a bug fix workflow is needed.',
    triggers: ['investigate', 'debug', 'root cause', 'why failing', 'is this a bug', 'check issue'],
    excludes: ['add feature', 'create workflow'],
    priority: 84,
    allowedRoutes: ['direct_answer', 'data_query', 'spawn_agent', 'run_workflow'],
    relatedAgents: ['bug-investigator', 'codebase-navigator', 'engineering-lead'],
    relatedWorkflows: ['bug-fix-by-severity'],
    body: `# Issue Investigation

## When to use
Use when the user asks to investigate/debug/check a failure or find root cause without clearly requesting implementation.

## When not to use
If the user explicitly asks to fix the bug, use bug-fix-routing after any necessary evidence gathering.

## Evidence
Discover available tools at runtime. Choose evidence categories by issue type: repo/code, execution/log/trace, database/state, infrastructure/deployment, PR/review, ticket, or external service. Never assume a specific MCP tool exists.

## Routing
- If evidence is enough and no code change was requested, answer directly with findings.
- If code inspection is needed, spawn a read-only investigator in the correct repo/workspace.
- If user asks to proceed with a fix, classify with bug-fix-routing.
- If the issue spans teams or systems, spawn the relevant lead.

## Output
Return evidence checked, findings, confidence, unknowns, and recommended route if a fix is needed.`,
  },
  {
    name: 'bug-fix-routing',
    displayName: 'Bug Fix Routing',
    category: 'implementation',
    description: 'Route bug fixes to a direct specialist for small fixes or bug-fix-by-severity for severity-gated full pipelines.',
    triggers: ['fix bug', 'bug', 'broken', 'regression', 'production issue', 'crash', 'error'],
    excludes: ['add feature', 'new workflow'],
    priority: 82,
    allowedRoutes: ['spawn_agent', 'run_workflow'],
    relatedWorkflows: ['bug-fix-by-severity'],
    relatedAgents: ['backend-developer', 'frontend-developer', 'bug-investigator', 'engineering-lead'],
    body: `# Bug Fix Routing

## When to use
Use when the user asks to fix broken behavior, a regression, error, crash, or production issue.

## When not to use
Do not use for planned new functionality unless the feature is only restoring intended behavior.

## Evidence
Confirm repo, reproduction clues, failing behavior, affected surface, and available tools. If root cause is not clear, investigate before selecting implementation route.

## Routing
- Small, obvious, low-risk bug with narrow files: create/reuse workspace, spawn the right specialist such as backend-developer or frontend-developer, then continue to PR.
- Bug needing investigation: run bug-fix-by-severity. The investigator classifies severity as small | medium | large and the workflow auto-skips heavier gates for smaller bugs (small skips qa + implementation_validator; medium skips implementation_validator; large runs the full pipeline).
- Cross-team operational bug: spawn engineering-lead or devops-engineer.

## Output
State selected route, why direct specialist or workflow is appropriate, required inputs, workspace/PR expectation, and any missing context.`,
  },
  {
    name: 'feature-routing',
    displayName: 'Feature Routing',
    category: 'implementation',
    description: 'Route feature requests, enhancements, UI changes, and product changes by scope and risk.',
    triggers: ['build', 'add', 'implement', 'feature', 'revamp', 'redesign', 'enhance', 'pagination'],
    excludes: ['fix bug', 'resolve pr comments'],
    priority: 80,
    allowedRoutes: ['spawn_agent', 'run_workflow', 'direct_answer'],
    relatedWorkflows: ['feature-plan-and-implement'],
    relatedAgents: ['product-manager', 'engineering-lead', 'backend-developer', 'frontend-developer'],
    body: `# Feature Routing

## When to use
Use when the user asks to add, build, implement, revamp, redesign, or enhance functionality.

## When not to use
Do not use for pure explanations, read-only investigations, or bug fixes.

## Evidence
Identify repo, affected product area, expected behavior, existing implementation, available workflows, agents, and tools before starting execution.

## Routing
- Tiny low-risk tweak: direct specialist in workspace, then PR.
- Normal or large feature, cross-cutting change, uncertain design, multiple surfaces, or work needing PRD/HLA/TDD/QA/review/PR: run feature-plan-and-implement.
- Planning-only request: answer directly if no repo grounding is needed.
- Product-heavy ambiguity: spawn product-manager or engineering lead.

## Output
Return selected route, scope classification, required inputs, and whether human approval gates are expected.`,
  },
  {
    name: 'review-routing',
    displayName: 'Review Routing',
    category: 'quality',
    description: 'Route PR/code reviews and review-comment resolution.',
    triggers: ['review', 'pr comments', 'coderabbit', 'pull request', 'code quality', 'security review'],
    excludes: ['build feature from scratch'],
    priority: 78,
    allowedRoutes: ['direct_answer', 'spawn_agent', 'run_workflow'],
    relatedAgents: ['code-reviewer', 'qa-lead', 'test-planner', 'test-writer', 'pr-review-bot'],
    body: `# Review Routing

## When to use
Use for PR review, code review, review bot comments, quality/security/performance review, or resolving PR comments.

## When not to use
Do not use for unrelated new feature work unless review findings require a separate implementation route.

## Evidence
Inspect PR URL, diff, comments, existing workspace, tests, and review bot state. For repo-only review, create an isolated workspace before spawning specialists.

## Routing
- Read-only review: spawn code-reviewer or answer with checked evidence.
- Resolve review comments on a PR: spawn pr-review-bot with the PR URL and checked review context.
- Review reveals bigger bug/feature work: route through bug-fix-routing or feature-routing.

## Output
Return findings by severity, evidence checked, route chosen, and PR/workspace links when applicable.`,
  },
  {
    name: 'workspace-pr-routing',
    displayName: 'Workspace and PR Routing',
    category: 'implementation',
    description: 'Cross-cutting rules for isolated workspaces, implementation, validation, commit, push, and PR creation.',
    triggers: ['workspace', 'open pr', 'create pr', 'code change', 'commit', 'push', 'local-only'],
    excludes: ['read only', 'explain only'],
    priority: 76,
    allowedRoutes: ['spawn_agent', 'run_workflow'],
    relatedAgents: ['pr-creator', 'devops-engineer', 'backend-developer', 'frontend-developer'],
    body: `# Workspace and PR Routing

## When to use
Use whenever a route will change code, config, docs tied to code, tests, workflows, or agents.

## When not to use
Do not use for pure read-only answers.

## Evidence
Identify target repo and whether a workflow already creates its own workspace. Confirm validation expectations and whether the user explicitly requested local-only/no PR.

## Routing
- Direct specialist code work requires create_workspace first and repo_path must be the returned worktree path.
- Workflows with create_workspace nodes receive the registered repo_path and create their own worktree.
- After implementation, continue to commit, push, and PR unless the user explicitly asked no PR/local-only.
- If validation cannot run, report the limitation before PR creation.

## Output
Return workspace path/link, validation result, PR URL or reason PR was skipped.`,
  },
  {
    name: 'agent-workflow-builder',
    displayName: 'Org, Agent, and Workflow Builder',
    category: 'meta',
    description: 'Design, create, validate, update, and explain Allen orgs, teams, agents, skills, and workflows. Use whenever the user asks to extend the org chart ("build a marketing team", "add an SRE to engineering"), create/edit agents, or create/edit workflows or skills.',
    triggers: [
      // Team / org
      'create team', 'build team', 'new team', 'add team', 'set up team', 'set up a team',
      'build org', 'build an org', 'extend the org', 'extend org', 'design org',
      'marketing team', 'finance team', 'sales team', 'team for',
      // Agent
      'create agent', 'build agent', 'add agent', 'new agent', 'add a specialist', 'specialist to',
      // Workflow / skill
      'create workflow', 'build workflow', 'modify workflow', 'edit workflow',
      'add skill', 'edit skill', 'new skill',
    ],
    excludes: ['run existing workflow', 'run workflow'],
    priority: 86,
    allowedRoutes: ['spawn_agent', 'direct_answer', 'run_workflow'],
    body: `# Org, Agent, and Workflow Builder

## When to use
Use when the user asks to design, create, edit, validate, or explain an Allen **team / org structure**, **agent**, **skill**, or **workflow**. Examples include "build a marketing team", "I want a finance team", "add a tax specialist to the finance team", "I need an SRE in the engineering team", "create a workflow that …", "edit a workflow", and "add/edit a skill for …".

## When not to use
Do not use for running an existing workflow, ordinary product feature work, or bug fixes — those route through the matching domain skill (bug-fix-routing, feature-routing, workspace-pr-routing, team-assignment-routing).

## Evidence
Before proposing any change, inspect what already exists in the current system: list_teams, list_agents, list_workflows, list_skills. Avoid duplicate teams/agents/skills/workflows. Confirm the parent team and lead choice are consistent with the existing org chart.

## Pick the right builder by intent
The universal "spawn the owner, don't act yourself" rule lives in the operating rules section below. This skill only helps you decide WHICH builder to spawn — and Allen's builder roster is dynamic, so do not assume any specific agent name exists.

1. Classify the operation from the user's intent:
   - **Create a new team / org subtree.**
   - **Add or modify an agent inside an existing team.**
   - **Create or edit a workflow.**
   - **Create or edit a skill.**
   - **Design / explanation only**, no record creation requested.
2. Discover candidate builders at runtime: run list_agents (and list_teams if helpful), filter by category "meta" or by description text that names the operation (e.g. an agent whose description mentions "creating teams" or "blueprinting org structure" is the right target for new-team work; one whose description mentions "adding agents" fits the agent-add variant; one whose description mentions "workflow" or "skill" authoring fits those variants).
3. Pick the most specific match by description/mission. If multiple builders look plausible, prefer the one whose category is "meta" and whose mission text most directly names the operation. If only a generic builder exists, use it.
4. If no matching builder exists at all, ask the user how to proceed — either register a builder agent first (recursive meta-build), or perform the operation directly as a one-off with explicit user confirmation.
5. For design / explanation only, answer directly with evidence and do not spawn an agent.

## Confirmation forwarding
Builder agents may pause with waiting_for_input before creating anything. When wait_for_execution returns status: "waiting_for_input", forward the **exact** requested decision or blueprint to the user — do not summarize, reorder, or rewrite it. Pass the user's reply back via submit_execution_input and keep waiting until the builder reaches a terminal status.

## Output
Return: the builder agent you chose (as discovered at runtime), the blueprint preview verbatim from the builder when available, the created record IDs and names, and a clickable link to each new team/agent/workflow/skill when the UI route is known. Never paste raw create_* outputs without context.`,
  },
  {
    // ─────────────────────────────────────────────────────────────────────────
    // IMPLEMENTATION GUIDELINES — secondary behavioural guardrail for
    // code-writing / file-modifying agents. Purposely low priority (40) so it
    // never outbids the domain routing skills (72-92). Not in ALWAYS_RESYNC
    // because operator body edits should survive reboots. Seeded only so the
    // skill is available in the DB for knowledge-graph indexers and agents that
    // load it explicitly; it is NOT a top-level routing skill.
    // ─────────────────────────────────────────────────────────────────────────
    name: 'coding-guidelines',
    displayName: 'Coding Guidelines',
    category: 'implementation-guidelines',
    description: 'Behavioral guidelines to reduce common LLM coding mistakes: avoid overcomplication, make surgical changes, surface assumptions, and define verifiable success criteria. Use when writing, modifying, or refactoring code — not for routing, planning, or investigation.',
    triggers: ['coding guidelines', 'implementation guidelines'],
    excludes: [],
    priority: 40,
    allowedRoutes: ['direct_answer'],
    body: CODING_GUIDELINES_BODY,
  },
  {
    // ─────────────────────────────────────────────────────────────────────────
    // Authoring-guidelines knowledge skill loaded explicitly by the Planner
    // persona (Plan Mode) when writing a PRD so the document is clear and
    // implementation-ready for downstream agents — with NO technical code
    // snippets. Low priority (40) so it never outbids the domain routing skills
    // (72-92); allowedRoutes is direct_answer only. Like coding-guidelines it is
    // a knowledge skill, not a top-level router.
    // ─────────────────────────────────────────────────────────────────────────
    name: 'prd-authoring',
    displayName: 'PRD Authoring',
    category: 'authoring-guidelines',
    description: 'Playbook for writing clear, implementation-ready PRDs that a downstream agent can build without guessing: explicit user requirements, testable acceptance criteria, scope boundaries, and NO technical code snippets. Use when authoring a PRD, product spec, or requirements doc — not for routing, coding, or investigation.',
    triggers: ['prd', 'write a prd', 'product requirements', 'requirements doc', 'product spec', 'spec doc', 'write a spec'],
    excludes: [],
    priority: 40,
    allowedRoutes: ['direct_answer'],
    body: PRD_AUTHORING_BODY,
  },
  {
    name: 'team-assignment-routing',
    displayName: 'Team Assignment Routing',
    category: 'coordination',
    description: 'Choose between lead/team agent spawn, specialist spawn, direct answer, and workflow execution.',
    triggers: ['assign', 'route to', 'lead', 'team', '@agent', 'handoff'],
    excludes: [],
    priority: 72,
    allowedRoutes: ['spawn_agent', 'run_workflow', 'direct_answer'],
    relatedAgents: ['product-manager', 'engineering-lead', 'qa-lead', 'devops-engineer'],
    body: `# Team Assignment Routing

## When to use
Use when the user asks to assign, hand off, route to a team/lead/agent, or mentions an explicit agent. Treat those words as a request to spawn the selected agent.

## When not to use
Do not override an explicit valid user target unless it cannot perform the task.

## Evidence
List available teams/agents when needed. Check whether the target is a team lead/coordinator or a hands-on specialist.

## Routing
- Team lead or coordination request: spawn_agent and wait for completion.
- Technical specialist one-shot: spawn_agent, using workspace rules for code work.
- Repeatable multi-step process: run the matching workflow.
- Normal answer with no execution: answer directly.

## Output
Return target chosen, why, execution id, status, and final result after waiting.`,
  },
];

export async function seedDefaultSkills(db: Db): Promise<void> {
  const col = db.collection('skills');
  const override = isSeedOverrideEnabled();
  let seeded = 0;
  let updated = 0;

  for (const skill of DEFAULT_SKILLS) {
    const now = new Date();
    const existing = await col.findOne({ name: skill.name });
    const doc = {
      ...skill,
      body: withSkillOperatingRules(skill.body),
      enabled: skill.enabled ?? true,
      version: (existing?.version as number | undefined) ?? 1,
      createdBy: 'system',
      updatedAt: now,
    };

    if (!existing) {
      await col.insertOne({ ...doc, createdAt: now });
      seeded++;
      continue;
    }

    if (override) {
      await col.updateOne(
        { _id: existing._id },
        { $set: { ...doc, version: ((existing.version as number | undefined) ?? 1) + 1 } },
      );
      updated++;
      continue;
    }

    const existingBody = String(existing.body ?? '');
    const existingLower = existingBody.toLowerCase();
    if (
      existing.createdBy === 'system'
      && (
        !existingLower.includes('## clarify and confirm')
        || !existingLower.includes('## capability discovery')
        || !existingLower.includes('## assign to agents')
      )
    ) {
      await col.updateOne(
        { _id: existing._id },
        {
          $set: {
            body: withSkillOperatingRules(existingBody),
            updatedAt: now,
          },
          $inc: { version: 1 },
        },
      );
      updated++;
      continue;
    }

    // When SEED_OVERRIDE is active, resync agent-workflow-builder and
    // capability-routing so their routing logic stays in lockstep with the
    // source tree (they carry team/agent/workflow-builder assignment contracts).
    // When override is off, user edits to these skills are preserved.
    if (override && existing.createdBy === 'system') {
      const isResync = skill.name === 'agent-workflow-builder' || skill.name === 'capability-routing';
      if (!isResync) continue;
      // capability-routing preserves user body edits for backward compat;
      // agent-workflow-builder always overwrites body because it carries
      // the team/agent/workflow-builder assignment contract.
      const nextBody = skill.name === 'capability-routing'
        ? withSkillOperatingRules(existingBody || skill.body)
        : withSkillOperatingRules(skill.body);
      await col.updateOne(
        { _id: existing._id },
        {
          $set: {
            displayName: doc.displayName,
            description: doc.description,
            category: doc.category,
            triggers: doc.triggers,
            excludes: doc.excludes,
            priority: doc.priority,
            allowedRoutes: doc.allowedRoutes,
            relatedWorkflows: doc.relatedWorkflows,
            relatedAgents: doc.relatedAgents,
            tags: doc.tags,
            body: nextBody,
            updatedAt: now,
          },
          $inc: { version: 1 },
        },
      );
      updated++;
    }
  }

  console.log(`Seeded ${seeded} new, updated ${updated} default skills (${DEFAULT_SKILLS.length} checked)`);
}
