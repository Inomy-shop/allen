# Allen vs. 6 Competitors — Final Comparison

**Last reviewed:** 2026-04-17
**Compares:** Allen (this repo) against Factory, Letta, 8090, ProductNow, Conductor, Kiro.
**Prerequisite reading:** `00-allen.md`, `01-factory.md`, `02-letta.md`, `03-8090.md`, `04-productnow.md`, `05-conductor.md`, `06-kiro.md`.

This doc synthesizes the per-product deep dives into a head-to-head comparison along seven axes, then makes positioning recommendations.

---

## 1. Executive summary

The seven products are **not the same product**. They cluster:

| Cluster | Products | Shared trait |
|---|---|---|
| **Self-hosted multi-agent platforms** | Allen, Letta | OSS-friendly, you own the infra, agents as primitives |
| **Enterprise SDLC suites** | Factory, 8090 | Closed SaaS, full-SDLC ambition, large enterprise GTM |
| **Coding IDE / harness** | Kiro, Conductor | Developer-facing, session-based, integrated with git |
| **Upstream PM tooling** | ProductNow | Not coding; sits before engineering |

Allen's closest peers are **Letta** (on memory + OSS axis) and **Factory** (on multi-agent SDLC ambition), but it's distinct from both: Letta is a framework without SDLC opinions; Factory is a closed enterprise platform without self-host.

Allen's defensible niche: **the only self-hosted declarative multi-agent workflow engine with agents that can author agents, teams, and workflows via a built-in MCP server.**

---

## 2. Axis 1 — Orchestration model

| Product | Model | Assessment |
|---|---|---|
| **Allen** | Declarative YAML graph (5 node types) + 3-layer retry + checkpoints + parallel with merge strategies | **Most principled orchestration layer in cohort** |
| Factory | Emergent Missions driven by droid planning loop | Sophisticated inside the droid, opaque outside |
| Letta | ReAct or MemGPT agent loop + subagents + cross-agent messaging | Framework-level — you build orchestration with primitives |
| 8090 | Sequential module pipeline (Refinery → Foundry → Planner) with artifact gates | Most rigid; designed for compliance |
| ProductNow | Opaque SaaS workflow engine | Not a coding orchestration tool |
| Conductor | Many Claude Code sessions in parallel worktrees | Session-level, not workflow-level |
| Kiro | Spec files + agent hooks + preview autonomous agent (3 sub-agents) | Spec-driven with event triggers |

**Allen wins** when the user wants: diffable workflow artifacts, per-node model overrides, explicit retry semantics, checkpoint rewind, named join policies.

**Allen loses** when the user wants: autonomous trajectory exploration (Factory), emergent research-style agent loops (Letta), compliance-gated artifact hand-offs (8090).

---

## 3. Axis 2 — Planning

| Product | Planning primitive | Strength |
|---|---|---|
| **Allen** | Workflow YAML authored by a human; `coding-planner` agent inside a node | Medium — planning is declarative but no pass@k, no EARS artifacts |
| **Factory** | Multi-trajectory + self-critique + test-validated selection (pass@k) | **Strongest autonomous planner** — published SWE-bench numbers |
| Letta | Emergent ReAct/MemGPT loop with memory-aware tool calls | Framework-level; no opinion |
| 8090 | PRD → Blueprint → Work Order pipeline with Knowledge Graph linking | **Strongest enterprise-rigorous planner** |
| ProductNow | Strategic goal → roadmap → epics → tasks | PM-side planning, not code |
| Conductor | None (delegated to Claude Code) | — |
| **Kiro** | `requirements.md` (EARS) + `design.md` + `tasks.md` in `.kiro/specs/` | **Strongest in-IDE planning artifact** |

**Clear gaps for Allen:**
- No pass@k autonomous exploration (Factory's strength).
- No EARS-format requirements or 3-file spec artifact (Kiro's strength).
- No Knowledge Graph linking PRD/Blueprint/Code (8090's strength).

**The cheapest close:** add a `spec` node type that emits EARS requirements + design + tasks into state. Reuses existing template rendering + output extraction.

---

## 4. Axis 3 — Memory

| Product | Memory tier | Consolidation | Editable by agent? |
|---|---|---|---|
| **Allen** | Learnings (Mem0-style delta facts) with scope + confidence + embedding | Post-execution review (Haiku) | Explicit `__learnings[]` field only |
| Factory | Org Memory + User Memory + persistent droid VM state | Auto-recorded stable facts | Implicit (from conversation) |
| **Letta** | **Core blocks (editable) + recall (conversation) + archival (vector)** | **Memory sub-agents (continuous)** | **Yes (`memory_replace`, `memory_insert`, `memory_rethink`)** |
| 8090 | Knowledge Graph across artifacts | Artifact co-evolution | No |
| ProductNow | Shared intelligence layer (cross-tool knowledge graph) | Real-time sync | No |
| Conductor | Per-workspace CLAUDE.md + general prefs | None | No |
| Kiro | Steering files + SQLite + preview cross-session agent memory | None beyond append | Steering files: user-editable, not agent-editable |

**Letta is the memory leader by a wide margin.** Allen's Mem0-style learnings are useful but don't match Letta's tiered, pinned, agent-editable, consolidatable architecture.

**The cheapest close:** implement memory blocks per the existing `docs/plans/memory-system-gap-analysis-2026.md`. Add `memory_blocks: Record<string, Block>` to agent state, pin into `effectiveSystem`, expose `memory_replace` / `memory_insert` via the Allen MCP server.

---

## 5. Axis 4 — Agent-self-service

**The axis where Allen uniquely wins.**

| Product | Can agent: create other agents? | ...create workflows? | ...spawn peers? | ...delegate + wait? |
|---|---|---|---|---|
| **Allen** | ✅ `create_agent` MCP tool | ✅ `create_workflow` MCP tool | ✅ `spawn_agent` | ✅ `delegate_to_agent` + `wait_for_delegation` |
| Factory | ❌ droids are fixed types | ❌ missions, not workflows | ⚠️ via AGENTS.md conventions | ⚠️ implicit via mission planner |
| **Letta** | ✅ via SDK | ⚠️ no declarative workflow | ✅ subagents | ✅ cross-agent messaging |
| 8090 | ❌ closed modules | ❌ | ❌ | ⚠️ gated hand-offs |
| ProductNow | ❌ | ❌ | ❌ | ❌ |
| Conductor | ❌ | ❌ | ⚠️ handoffs preview | ⚠️ manual |
| Kiro | ❌ | ❌ | ⚠️ sub-agent triad (preview) | ⚠️ sub-agent coordination |

Allen is the **only product in the cohort where a running agent can author a new agent, commit a new workflow YAML, form a team, and delegate to it — all at runtime**. This is the genuine moat.

---

## 6. Axis 5 — Harness & model flexibility

| Product | Can BYO model keys? | Can swap model mid-session? | Is harness swappable? |
|---|---|---|---|
| **Allen** | ✅ (Claude API + Codex API, your keys) | ✅ per-node `agentOverrides` | ⚠️ tied to Claude Code SDK + Codex CLI |
| Factory | ❌ (Pro/Max) / ✅ Enterprise | ❌ router decides | ❌ closed |
| **Letta** | ✅ any provider | **✅ state portable across models** | ✅ OSS, forkable |
| 8090 | ❌ | ❌ | ❌ |
| ProductNow | ❌ | ❌ | ❌ |
| Conductor | ✅ (your Claude Code / Codex auth) | ⚠️ slash command per session | ❌ wraps Claude Code SDK |
| Kiro | ❌ (Bedrock-routed) | ⚠️ dropdown, new process | ❌ proprietary `kiro-cli` |

**Letta is the flexibility leader** (state portable across models). **Allen is second** (per-node provider override + your keys, but tied to specific CLIs). **Kiro and Factory are the least flexible** on model choice.

---

## 7. Axis 6 — Human-in-the-loop

| Product | Interrupt point | Approve / reject / request-changes | Retry-from-checkpoint |
|---|---|---|---|
| **Allen** | `human` node + auto-gate `clarify` + interventions | ✅ all three + Slack DM + channel | ✅ rewind to checkpoint |
| Factory | Mission review in web UI | ✅ approval + change requests | ⚠️ mission-level |
| Letta | API-level | ⚠️ build your own | ❌ |
| 8090 | Artifact gates between modules | ✅ artifact-level approvals | N/A (artifacts, not code) |
| ProductNow | Review flows | ⚠️ | N/A |
| Conductor | Manual PR review in-app | ⚠️ | ❌ |
| Kiro | Approval prompts + tool approval + hooks | ⚠️ file-event approvals | ❌ |

**Allen is the HITL leader** — `request_changes` with `retry_target` rewind + Slack integration + checkpoint-based semantics is unique.

---

## 8. Axis 7 — Integration surface

| Product | Chat | IDE | CLI | Web | Slack | Cron | MCP | Git worktrees |
|---|---|---|---|---|---|---|---|---|
| **Allen** | ✅ first-class | ⚠️ no IDE extension | ⚠️ engine CLI only | ✅ | ✅ DM + channel + webhook | ✅ **only one** | ✅ server + client | ✅ built-in |
| Factory | ✅ Slack/Teams | ✅ VS Code/JetBrains/Vim | ✅ Droid Exec | ✅ | ✅ | ❌ | ✅ client | ❌ uses VMs |
| Letta | ⚠️ API | ⚠️ Letta Code app | ✅ npm CLI | ✅ ADE | ❌ | ❌ | ✅ client | ❌ |
| 8090 | ⚠️ | ❌ | ❌ | ✅ | ⚠️ | ❌ | ✅ (Planner) | ❌ |
| ProductNow | ✅ (for PMs) | ❌ | ❌ | ✅ | ✅ | ❌ | ⚠️ | ❌ |
| Conductor | ✅ in-app | ⚠️ wraps Claude Code | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ core |
| Kiro | ✅ IDE chat | ✅ Code OSS fork | ✅ kiro-cli | ❌ | ⚠️ via MCP | ❌ | ✅ **native** | ❌ |

**Allen has the widest integration surface** with **cron as a unique**. Only Factory and Kiro match on IDE reach; only Letta matches on chat + API + CLI.

---

## 9. Full feature matrix

| Feature | Allen | Factory | Letta | 8090 | ProductNow | Conductor | Kiro |
|---|---|---|---|---|---|---|---|
| Declarative workflow graph | ✅ (5 node types) | ❌ | ❌ | ✅ (modules) | ❌ | ❌ | ❌ |
| Parallel with merge strategies | ✅ | ✅ | ✅ | ⚠️ | ❌ | ✅ | ✅ |
| 3-layer retry | ✅ | ⚠️ | ⚠️ | ⚠️ | ❌ | ❌ | ❌ |
| Checkpoints + rewind | ✅ | ⚠️ | ⚠️ | ⚠️ | ❌ | ❌ | ❌ |
| Auto-gate (stop/skip/clarify) | ✅ | ⚠️ | ❌ | ⚠️ | ❌ | ❌ | ❌ |
| Agent self-service (create/spawn/delegate via MCP) | ✅ | ⚠️ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Teams with blueprints + live org-chart injection | ✅ | ❌ | ⚠️ shared blocks | ❌ | ⚠️ | ❌ | ❌ |
| Structured memory blocks | ❌ | ❌ | ✅ | ⚠️ KG | ⚠️ layer | ❌ | ⚠️ steering |
| Memory consolidation | ⚠️ Haiku review | ⚠️ | ✅ sub-agents | ⚠️ | ⚠️ | ❌ | ❌ |
| Autonomous trajectory planning | ❌ | ✅ | ⚠️ | ❌ | ❌ | ❌ | ⚠️ |
| Spec-driven artifacts (PRD / requirements) | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ EARS |
| Event hooks (file/tool/task) | ❌ | ⚠️ CI | ❌ | ❌ | ❌ | ❌ | ✅ |
| Git worktree isolation | ✅ | ⚠️ VMs | ❌ | ❌ | ❌ | ✅ | ❌ |
| MCP server (exposed to agents) | ✅ 21 tools | ❌ | ⚠️ SDK | ❌ | ❌ | ❌ | ❌ |
| Auto-resolve review-bot comments (CodeRabbit etc.) | ✅ cron + manual | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Per-execution tool-call log with expandable I/O | ✅ | ⚠️ activity view | ⚠️ traces | ⚠️ | ❌ | ⚠️ | ⚠️ |
| Persistent workspace filesystem (survives reboots) | ✅ `~/.allen/` | ✅ cloud VMs | ⚠️ server | ✅ | ❌ | ✅ worktrees | ⚠️ local |
| AWS production deploy (Terraform) | ✅ EC2+ALB+Route53+ACM | ⚠️ managed only | ⚠️ BYO | ⚠️ | ⚠️ SaaS | ❌ desktop-only | ✅ Bedrock |
| MCP client (consume external servers) | ✅ + secrets | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ |
| Cron scheduling | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Claude Code ecosystem interop | ✅ imports `.claude/agents/*.md` | ⚠️ AGENTS.md | ❌ | ❌ | ❌ | ✅ native | ⚠️ compat |
| HITL with retry-target rewind | ✅ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ |
| Slack DM + channel + webhook | ✅ | ✅ | ❌ | ⚠️ | ✅ | ❌ | ⚠️ MCP |
| Cost tracking (estimated + actual) | ✅ | ⚠️ tokens | ⚠️ API | ⚠️ | ⚠️ | ❌ (BYO) | ✅ credits |
| Secrets encrypted at rest | ✅ AES-256-GCM | ✅ | ⚠️ env | ✅ | ✅ | ❌ | ✅ |
| Visual workflow builder | ✅ ReactFlow | ❌ | ⚠️ ADE | ⚠️ module UI | ✅ | ❌ | ❌ |
| Local embeddings (no API key) | ✅ MiniLM-L6-v2 | ❌ | ⚠️ configurable | ❌ | ❌ | ❌ | ❌ |
| Open source / self-host | ⚠️ self-host, closed | ❌ (Enterprise on-prem) | ✅ Apache-2.0 | ❌ | ❌ | ⚠️ local-first | ❌ |
| Published benchmark | ❌ | ✅ SWE-bench | ⚠️ Context-Bench | ❌ | ❌ | ❌ | ❌ |
| Enterprise compliance (SOC 2 / GovCloud) | ⚠️ | ✅ | ⚠️ | ⚠️ | ✅ SOC 2 | ⚠️ GHE | ✅ GovCloud |

---

## 10. Where each product is the technical leader

| Axis | Winner | Runner-up |
|---|---|---|
| Declarative orchestration | **Allen** | 8090 (artifact-gated) |
| Agent self-service | **Allen** | Letta |
| Memory architecture | **Letta** | Allen (planned blocks) |
| Autonomous planning (pass@k) | **Factory** | Kiro (autonomous agent preview) |
| Upstream spec rigor | **Kiro** (EARS) / **8090** (PRD/Blueprint/WO) | Allen (design docs) |
| Parallel-agent UX | **Conductor** | Allen (has the model, not the UI) |
| Event-driven hooks | **Kiro** | — |
| Multi-agent messaging | **Allen** ≈ **Letta** | — |
| Claude Code ecosystem interop | **Allen** | Conductor |
| Cron scheduled agent workflows | **Allen** (only) | — |
| HITL with retry-target semantics | **Allen** | Factory |
| Auto-resolve review-bot comments | **Allen** (only) | — |
| Per-tool expandable execution log | **Allen** | Factory (activity pane) |
| Enterprise compliance | **Kiro** (GovCloud) / **Factory** | 8090 |
| Open source | **Letta** | Allen (self-host, closed) |
| Persistent per-agent compute | **Factory** (droid VMs) | Conductor (worktrees) |
| PM / upstream-of-code | **ProductNow** | 8090 (Refinery) |

---

## 11. Buyer-fit matrix

| Buyer profile | Best choice | Why |
|---|---|---|
| Self-hosting startup / mid-market eng team | **Allen** or **Letta** | Allen if coding SDLC, Letta if building memory-first agent products |
| Fortune 500 SDLC modernization | **Factory** or **8090** | Factory = benchmarks + speed; 8090 = audit + compliance |
| Solo dev running many Claude Codes on Mac | **Conductor** | Zero-friction, free |
| Dev inside AWS org | **Kiro** | Bedrock-native, cross-platform, GovCloud |
| Product team (non-engineering) | **ProductNow** | Only PM play in the cohort |
| AI engineer building a memory-first consumer agent | **Letta** | Only real stateful-memory framework |
| Eng team + strong PM/audit culture | **8090** | Artifacts + Knowledge Graph across SDLC |
| Team already on Claude Code wanting to orchestrate multi-agent workflows at org scale | **Allen** | Imports `.claude/agents/*.md`; MCP server exposes self-service tools |
| Enterprise needing autonomous engineering droids with trajectory planning | **Factory** | Only product with pass@k + published benchmarks |

---

## 12. Honest weaknesses of Allen (confirmed from real comparisons)

1. **Memory is Mem0-style, not Letta-style.** Users who want blocks/archival/recall with agent-editable pinned context will pick Letta.
2. **No autonomous trajectory planning.** Factory's published SWE-bench / Terminal-Bench numbers are a marketing disadvantage we can't refute.
3. **No EARS / spec artifacts.** Kiro's `.kiro/specs/*` trio is a cleaner upstream artifact than Allen's design-doc built-in.
4. **No event hooks.** Kiro's on-save / on-tool-use triggers are genuinely absent in Allen.
5. **Parallel-agent UI less polished than Conductor.** The data model supports it; the UX doesn't showcase it.
6. **No public benchmark number.** Factory's Terminal-Bench #1 and SWE-bench numbers dominate conversations; Allen has none.
7. **Closed source** — Letta's Apache-2.0 licensing is a pull in certain OSS-first orgs.
8. **No enterprise compliance stamp** — no SOC 2 / GovCloud / SSO-SAML documented yet.

## 13. Strengths no other product in the cohort has

1. **Agents authoring agents, teams, and workflows at runtime** via 21 MCP tools (now incl. PR + workspace + sync primitives that let agents drive the CodeRabbit resolution loop end-to-end).
2. **Live org-chart injection at prompt time** — every agent sees current team structure.
3. **Mid-workflow delegation with checkpoint-rewound HITL** — `delegate_to_agent` + `wait_for_delegation` + `request_changes` retry.
4. **Cron-scheduled multi-agent workflows** — none of the six competitors ship this.
5. **All on the same engine**: chat + visual builder + CLI + Codex + Slack + cron + MCP + teams + workflows.
6. **Claude Code interop**: imports `.claude/agents/*.md`; exposes MCP Claude Code clients call.
7. **Local embeddings, no API key** (`all-MiniLM-L6-v2`).
8. **AES-256-GCM secrets + JWT-authed MCP server + Playwright E2E** — production-grade footing.

---

## 14. Prioritized roadmap implications (derived from gaps)

In order of cheapest to ship × biggest competitive close:

1. **Memory blocks** — gap-analysis doc is ready. Close Letta gap. Highest ROI.
2. **`spec` node type** (EARS + design + tasks) — close Kiro gap. Cost: ~1 prompt template + 3 built-ins.
3. **Event hooks** — close Kiro gap. Extend emitter to fire workflows on file-save / PR-opened / tool-use.
4. **Conductor-style parallel-workspace UI** — the model is there; build the UI.
5. **`trajectories` option on agent nodes** — close Factory gap. Run N samples, select best via tests. Reuses checkpoint infra.
6. **Publish a SWE-bench / Terminal-Bench number** — credibility move.
7. **Skill library** — `docs/plans/skill-library-design.md` is ready. Close Letta / Claude Code Skills gap.
8. **Enterprise compliance package** — SOC 2 Type II, SSO/SAML, audit log surfacing. Unlocks enterprise deals.

---

## 15. Bottom line

Allen competes credibly against Factory (multi-agent SDLC) and Letta (self-host + agent primitives) in a space none of the six competitors fully occupies: **self-hosted, declarative, multi-agent coordination with agents that can extend the system at runtime.**

The clearest risks are: (a) Letta closing the coding-product gap with Letta Code, (b) Kiro shipping a declarative workflow layer on top of specs, (c) Factory going down-market with a smaller droid plan.

The clearest opportunities are: (a) ship memory blocks and skill library fast, (b) be the best self-hosted Claude Code orchestrator (imports + MCP + teams + cron), (c) publish a public benchmark number.

---

## References

- `docs/competitive/00-allen.md`
- `docs/competitive/01-factory.md`
- `docs/competitive/02-letta.md`
- `docs/competitive/03-8090.md`
- `docs/competitive/04-productnow.md`
- `docs/competitive/05-conductor.md`
- `docs/competitive/06-kiro.md`
- `docs/workflow-execution.md`
- `docs/plans/memory-system-gap-analysis-2026.md`
- `docs/plans/skill-library-design.md`
- `docs/plans/multi-agent-team-system.md`
