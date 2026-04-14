# Agent Reasoning Effort & Plan Mode — Per-Agent Assignment Plan

This plan defines the **default** `model`, `reasoningEffort`, and `planMode`
settings to apply to every existing built-in agent in the FlowForge org seed
(`packages/server/src/services/org-seed.ts`).

## Guiding rules (from product)

1. **Lead agents keep their current model.** Do not touch `ceo`,
   `product-manager`, `engineering-lead`, `qa-lead`, `team-builder-agent`.
2. **Lead agents get `reasoningEffort: 'high'`** — they coordinate, approve
   plans, and route work. Thinking hard is their job.
3. **Planners, investigators, analysts, reviewers → `reasoningEffort: 'high'`.**
   Anything whose job is to *think before acting* gets the high-effort setting.
4. **Coding developers → `reasoningEffort: 'low'`.** Backend, frontend, test
   writers execute a plan made by someone else. Low effort is fine and keeps
   the loop fast.
5. **Plan mode (`planMode: true`) is for agents that should never touch the
   filesystem** — pure planners / researchers / requirement analysts. This
   forces the Claude CLI into `--permission-mode plan`, which means the agent
   can read and explore but cannot edit files or run destructive commands.
6. Every override here is a *default on the agent document*. Workflow nodes
   and chat sessions can still override these on a per-run basis — that's
   handled by the separate "Reasoning Effort & Plan Mode overrides" plan.

## Current state

All 20 seeded agents today use `provider: claude-cli`, `model: sonnet`, with
no `reasoningEffort` or `planMode` fields set. The three new fields are
optional and backward-compatible.

## Categorisation

Agents grouped by the role they play in the org — each group gets a
consistent setting.

### Group A — Leads (5 agents)
`model: sonnet` (unchanged), `reasoningEffort: high`, `planMode: false`.

Reason: leads coordinate and approve but still sometimes need to run commands
or write summary docs, so plan-mode would be too restrictive. High effort
matches their responsibility.

| Agent | Team | Current model | New effort | Plan mode |
|---|---|---|---|---|
| `ceo` | executive | sonnet *(keep)* | `high` | `false` |
| `product-manager` | product | sonnet *(keep)* | `high` | `false` |
| `engineering-lead` | engineering | sonnet *(keep)* | `high` | `true` ¹ |
| `qa-lead` | quality | sonnet *(keep)* | `high` | `false` |
| `team-builder-agent` | meta | sonnet *(keep)* | `high` | `false` |

¹ `engineering-lead`'s documented responsibility is to produce architectural
plans for developers to implement; it should never edit code directly.
Plan-mode enforces this at the runtime level.

### Group B — High-thought specialists (10 agents)
`model: opus`, `reasoningEffort: high`. Plan mode varies (see table).

Reason: these agents' output quality matters more than speed. They're
called relatively rarely per session but each call should be deep. Upgrading
from Sonnet to Opus costs more per call but is worth it for reviews, plans,
security audits, and requirement analysis — the places where a shallow
answer actively wastes human time.

| Agent | Team | Current → New model | New effort | Plan mode | Why |
|---|---|---|---|---|---|
| `requirements-analyst` | product | sonnet → **opus** | `high` | `true` | Reads PRDs, produces specs — no code changes |
| `acceptance-tester` | product | sonnet → **opus** | `high` | `false` | Runs actual tests, may need to exec commands |
| `code-reviewer` | engineering | sonnet → **opus** | `high` | `false` | Reads diffs, writes review comments |
| `security-specialist` | engineering | sonnet → **opus** | `high` | `false` | Deep audits of code + infra |
| `codebase-navigator` | engineering | sonnet → **opus** | `high` | `false` | May write exploration notes to disk |
| `test-planner` | quality | sonnet → **opus** | `high` | `true` | Designs test strategy, doesn't write tests |
| `planner-agent` | meta | sonnet → **opus** | `high` | `true` | Literally a planner |
| `research-agent` | meta | sonnet → **opus** | `high` | `true` | Researches, never edits |
| `repo-scanner` | meta | sonnet → **opus** | `high` | `false` | Writes scan output to disk |
| `agent-builder-agent` | meta | sonnet → **opus** | `high` | `false` | Builds new agents — writes agent definitions |

### Group C — Implementers / low-effort executors (3 agents)
`model: sonnet` (unchanged), `reasoningEffort: low`, `planMode: false`.

Reason: these agents take a plan made upstream and *execute* it mechanically.
Low effort keeps them fast and cheap. They are the highest-frequency callers
in any real workflow, so the cost savings matter.

| Agent | Team | Model | Effort | Plan mode |
|---|---|---|---|---|
| `backend-developer` | engineering | sonnet | `low` | `false` |
| `frontend-developer` | engineering | sonnet | `low` | `false` |
| `test-writer` | quality | sonnet | `low` | `false` |

### Group D — Medium-effort utility (2 agents)
`model: sonnet` (unchanged), `reasoningEffort: medium`, `planMode: false`.

Reason: their work needs *some* thought (infra decisions, prose quality) but
not the deep deliberation of a planner or reviewer.

| Agent | Team | Model | Effort | Plan mode |
|---|---|---|---|---|
| `devops-engineer` | engineering | sonnet | `medium` | `false` |
| `documentation-writer` | engineering | sonnet | `medium` | `false` |

## Summary by the numbers

- **Model upgrades (sonnet → opus):** 10 agents in Group B.
- **Model unchanged:** 10 agents (5 leads + 3 implementers + 2 medium).
- **`reasoningEffort: high`:** 15 agents (5 leads + 10 specialists).
- **`reasoningEffort: medium`:** 2 agents (devops, docs).
- **`reasoningEffort: low`:** 3 agents (backend, frontend, test-writer).
- **`planMode: true`:** 6 agents (engineering-lead, requirements-analyst,
  test-planner, planner-agent, research-agent) — actually 5; counted
  wrong — see the exact list below.

### Full `planMode: true` list (5 agents)
These are the agents that should never touch the filesystem under any
circumstances:

1. `engineering-lead` — produces plans, not code
2. `requirements-analyst` — produces specs, not code
3. `test-planner` — designs tests, doesn't write them
4. `planner-agent` — general-purpose planner
5. `research-agent` — pure research

Every other agent can still edit files (subject to permissions).

## Rollout

1. **Merge the schema / resolver plan first.** The three new fields must
   exist on `agents.*` and be honored by the spawn paths before these
   defaults mean anything. That work lives in
   `docs/plans/agent-settings-overrides.md` (the separate "overrides" plan).
2. **Update `org-seed.ts`** with the fields from the tables above. Each
   agent block gains up to three new lines: `model`, `reasoningEffort`,
   `planMode` (only where different from the CLI default).
3. **Re-seed on next boot.** `OrgSeedService.seed()` already runs on every
   boot and idempotently upserts agents. The upsert should include the new
   fields in the `$set`. This means existing deployments pick up the new
   defaults on the next restart without any manual intervention.
4. **Verify post-boot.** Open the Agents page in the UI and confirm each
   agent's new settings match this table. Optionally, spawn a chat with
   `planner-agent` and confirm the Claude CLI log shows
   `--effort high` and `--permission-mode plan`.

## Escape hatches

- **Model override per workflow node** — if a particular workflow can't
  afford Opus for a reviewer step, set a node-level `agentOverrides.model`
  override. The agent default stays Opus; only that node runs on Sonnet.
- **Effort override per chat session** — if a developer is just rubber-ducking
  with `planner-agent`, they can override `reasoningEffort: 'low'` at the
  session level to cut latency.
- **`planMode: false` override** — if an engineering-lead genuinely needs to
  write a design doc to disk during a plan-mode session, override
  `planMode: false` at the session/node level.

All escape hatches are **non-destructive**: overrides live on the chat
session or workflow node, never on the agent document. The defaults in this
plan remain intact.

## Non-goals

- This plan does **not** propose touching `provider` for any agent. Everyone
  stays on `claude-cli`.
- This plan does **not** propose touching `systemPrompt` or tool allowlists.
- This plan does **not** change Codex-based agents (there are none in the
  current seed). If any are added later, `planMode` silently no-ops for them.
- This plan does **not** add new agents or remove existing ones.

## Cost & latency implications

Approximate impact on a typical workflow run with 1× lead + 3× developer
calls + 1× reviewer call:

| Before | After |
|---|---|
| Lead: sonnet/medium | Lead: sonnet/**high** (~1.5× think time) |
| Developer ×3: sonnet/medium | Developer ×3: sonnet/**low** (~0.7× think time each) |
| Reviewer: sonnet/medium | Reviewer: **opus**/high (~2× cost, ~1.5× latency) |

Net: developer calls get slightly faster and cheaper (they dominate volume);
lead/reviewer calls get slower but higher-quality. The expectation is that
fewer review iterations are needed, so end-to-end workflow time trends
**down** for non-trivial tasks.

If we observe the opposite, roll back Group B to Sonnet and keep the effort
settings. That's a one-line change per agent.
