# FlowForge Memory/Learnings: 2026 Gap Analysis & Improvement Plan

**Date:** 2026-04-14
**Purpose:** Audit FlowForge's current learning system against the April 2026 state-of-the-art (Letta Memory Blocks, Mem0 v1, Zep, GBrain, Ramp Inspect, the "Agent Memory Race of 2026" cohort), identify concrete gaps, and lay out a phased plan to close them.
**Scope:** Design doc. No code in this pass — this is the blueprint that feeds follow-up implementation plans.

---

## 1. TL;DR

FlowForge already ships a production-shape learning system: domain-agnostic scoping, Mem0-style ADD/UPDATE/DELETE/NOOP classification, token-budgeted injection, retry/auto-gate/clarify/explicit/post-exec extraction, and a confirmation/contradiction feedback loop. Phases 1–5 of `learning-system-design.md` are ~90% done; Phase 6 is ~25%.

The 2026 frontier (Letta, Mem0, GBrain, Zep) has moved past "atomic learning records" toward:

1. **Structured self-editable memory blocks** (Letta) — discrete, labelled, size-bounded context units the agent actively rewrites, not just appends to.
2. **Procedural memory / skill library** (Voyager, GBrain `skills/`) — reusable executable recipes, not just text facts.
3. **Background "dream cycles"** (GBrain) — scheduled consolidation, entity enrichment, citation repair, staleness decay.
4. **Knowledge graph / entity enrichment** (Zep Graphiti, GBrain) — entities and relationships are first-class, not just tags.
5. **Tiered memory with agent-managed promotion** (MemGPT/Letta core ↔ archival) — the agent decides what to page in.
6. **LOCOMO-style evaluation** — memory systems are benchmarked on accuracy, token cost, and latency jointly.

FlowForge's biggest concrete gaps are: **no consolidation cron**, **no skill library**, **no memory blocks abstraction**, **no graph/entity layer**, **no evaluation harness**, and **per-execution (not per-node) injection tracking** that blunts the confirmation loop.

---

## 2. Current State — What We Have

Source: audit of `packages/engine/src/learning-manager.ts`, `packages/server/src/services/learning.service.ts`, `packages/server/src/routes/learning.routes.ts`, `packages/ui/src/pages/LearningsPage.tsx`, `packages/engine/src/embedding.ts`, `packages/engine/src/engine.ts`.

### 2.1 Schema

`Learning` record in Mongo with:
- `content`, `type` (fact | pattern | mistake | preference | skill | optimization), `target` (agent | system), `tags`
- `scope`: `{ level: global | workflow | context | agent | node_pattern, workflowName?, contextTags?, agentName?, nodePattern? }`
- `source`: `{ executionId, nodeName, workflowName, sourceType, timestamp }`
- Quality: `confidence`, `confirmations`, `contradictions`, `usageCount`, `lastUsedAt`, `lastConfirmedAt`
- Temporal: `validFrom`, `supersededBy`, `supersededAt`
- Budgeting: `tokenCount`
- Lifecycle: `status` (active | archived | superseded | evolved)
- Optional: `embedding` (384-dim MiniLM-L6-v2)

### 2.2 Extraction (fire-and-forget, non-blocking)

| Source | Where | Trigger | Extra LLM? |
|--------|-------|---------|------------|
| `retry_delta` | `learning-manager.ts:289` | after a failed→succeeded retry | no |
| `auto_gate` | `learning-manager.ts:349` | on `__action: "stop"` | no |
| `human_correction` | `learning-manager.ts:403` | on 2nd+ clarify Q/A | no |
| `agent_explicit` | `learning-manager.ts:444` | agent returns `__learnings[]` | no |
| `post_execution_review` | `learning-manager.ts:487` | after exec with retries/failures/gate events, >30s, Haiku | yes, ~$0.005 |

### 2.3 Classification — Mem0 ADD/UPDATE/DELETE/NOOP

- Jaccard keyword similarity as primary, optional embedding cosine boost in ranking
- Regex-based `contradicts()` — negation pairs, conflicting numbers, same-verb-different-object
- Per-scope growth limits with weakest-learning eviction

### 2.4 Retrieval & Injection

- Two-phase: Mongo scope filter → in-memory ranking
- Ranking factors: scope specificity (0.2–0.3), confidence (0.2–0.3), recency (0.15–0.2), novelty (0.15–0.2), optional semantic boost (0.3)
- 550-token budget, greedy fit
- Format: `LEARNINGS FROM PREVIOUS EXECUTIONS: [type, scope] content (confidence: X)`

### 2.5 Feedback Loop

- On node success → `confirm()` all injected IDs (`+0.1` confidence, cap 0.95)
- On node failure → `contradict()` (archive if `contradictions > confirmations`)
- Tracked per-execution, NOT per-node

### 2.6 UI / API

- `LearningsPage.tsx` — list/filter/approve/reject/edit, evolution view
- Full CRUD routes + `/stats`
- Execution detail wiring is partial: API returns `injected: []` because per-node tracking doesn't exist

---

## 3. The 2026 Frontier — What Others Are Doing Better

### 3.1 Letta / MemGPT — Memory Blocks as First-Class Context Units

Letta v1 (March 2026) moved from atomic message history to **memory blocks**: labelled, size-bounded, agent-editable strings that live in the context window. Key ideas:

- Each block has `label`, `value`, `size_limit`, `description`, and `read_only` flag
- Blocks are persisted individually with unique IDs — the agent uses tools (`memory_append`, `rethink_memory`, `archival_insert`) to edit them directly
- Three tiers: **Core** (in-context, always loaded) → **Archival** (vector store) → **Recall** (message history)
- Agents decide what to page between tiers
- "Context Repositories" (2026) — memory blocks are versioned in git, enabling branching/review/rollback of agent context

**Why this beats flat learning records:** Memory blocks give the agent a durable, *structured* working memory per entity (user, project, repo, workflow). A "repo:es-data-pipeline" block is one coherent document the agent rewrites as it learns, vs. 50 separate learning rows that need re-ranking at every query.

### 3.2 Mem0 (State of Agent Memory 2026)

- Standard scoping hierarchy: `user_id / agent_id / run_id / org_id`
- **Procedural memory** added as a first-class type in v1.0.0 alongside episodic + semantic
- **LOCOMO benchmark** — multi-axis eval: BLEU + F1 + LLM-judge + token consumption + latency. Selective memory beats full-context at 66–68% accuracy with 90% fewer tokens and 91% lower latency
- Extraction via separate LLM pass on conversation turns is now considered more reliable than agent self-report
- Unsolved problems called out: application-specific eval, consent/governance, cross-device identity, memory staleness detection

### 3.3 Zep / Graphiti

- **Temporal knowledge graph** — entities (nodes) + relationships (edges) with `valid_from` / `valid_to`
- Contradictions are resolved by adding a new edge and invalidating the old one, not by regex
- Queries can ask "what did the agent believe on March 15?" — true temporal versioning, not just soft-delete

### 3.4 GBrain (Garry Tan, April 2026)

Personal agent brain, MIT, 5.4k stars in 24h. Architectural ideas worth stealing:

- **Markdown + git as system of record**, Postgres + pgvector as retrieval layer — humans can always hand-edit
- **Compiled Truth + Timeline page structure**: top half is the current synthesized fact, bottom half is append-only event log with timestamps — prevents stale summaries while preserving history
- **Dream cycles** — nightly cron that does: entity sweep, citation repair, deduplication, stale-page detection, consolidation. "What makes the brain compound"
- **7-step enrichment pipeline** on every message: detect entities → query brain → fetch external → embed → update/backlink → cross-reference → sync to git
- **Skills/** folder — modular instruction sets for ingest/query/maintenance/enrichment/briefing that agents adopt permanently. Essentially procedural memory in markdown

### 3.5 Ramp Inspect (30% of merged PRs, Jan 2026)

- Not primarily a memory system, but demonstrates the **verification loop** that memory should feed: agent runs tests, queries monitoring (Sentry/Datadog), checks feature flags, participates in code review
- State lives in Cloudflare Durable Objects — one durable state object per session, not a passive memory store
- Lesson: memory without a verification/grounding loop regresses. The signal quality of confirmations matters more than the volume.

### 3.6 Agent Memory Race 2026 (OSS Insight)

The five breakout repos showcase four competing bets:
- **MemPalace**: "don't summarize, don't extract" — store conversations verbatim, trust retrieval
- **OpenViking** (ByteDance): filesystem metaphor, L0/L1/L2 tiered loading, unifies memories+resources+skills
- **code-review-graph**: tree-sitter + GraphRAG, 49× token reduction for coding tasks
- **engram**: radically simple — one Go binary, SQLite+FTS5, MCP server

All five fail on the same point: **no one has proven longitudinal memory improves agent performance over time on a shared benchmark**. This is the unsolved problem.

---

## 4. Gap Analysis — FlowForge vs. 2026 Frontier

| Area | FlowForge today | Frontier | Gap severity |
|------|-----------------|----------|:-:|
| Atomic facts vs memory blocks | Flat `Learning` rows, ranked at query time | Letta memory blocks — structured, agent-editable, per-entity | **High** |
| Procedural memory / skills | `type: skill` exists but is just text; no execution, no skill library | Voyager / GBrain `skills/` — reusable recipes agents "adopt permanently" | **High** |
| Consolidation | None. Plan'd daily cron never shipped | GBrain dream cycles; Mem0 periodic merge | **High** |
| Entity/graph layer | `contextTags: string[]` only | Zep temporal KG; GBrain entity pages with backlinks | **Medium** |
| Tiered memory | Single Mongo collection | MemGPT core/archival/recall with agent-managed promotion | **Medium** |
| Temporal queries | `validFrom` / `supersededAt` stored but never queried | Zep point-in-time queries | **Medium** |
| Contradiction detection | Regex (negation, numbers, verb/object) | LLM-judge + KG edge invalidation | **Medium** |
| Extraction | Primary: agent self-report. Secondary: Haiku post-exec review (opt-in) | Primary: separate LLM pass on turns (Mem0, Zep, Bedrock) | **Medium** |
| Injection tracking | Per-execution list — can't attribute per-node | Per-call tracking, enabling per-node confirmation | **High** |
| Embeddings | Optional, best-effort boost on top of Jaccard | Primary retrieval channel | **Medium** |
| Storage format | Mongo only | GBrain: markdown + git + pgvector hybrid (human-editable) | **Low–Medium** |
| Scoping IDs | `global/workflow/context/agent/node_pattern` | Mem0 `user_id/agent_id/run_id/org_id` — user scope missing! | **High** |
| Evaluation | None | LOCOMO multi-axis benchmark | **High** |
| "Dream cycles" / background enrichment | None | GBrain nightly enrichment, citation repair, entity sweep | **Medium** |
| Human editability | UI form over Mongo | GBrain: direct markdown edits committed to git | **Low** |
| Context Repositories / versioning | None | Letta git-backed branching of agent context | **Low** |

---

## 5. Improvement Plan

Phased so each phase ships standalone value. Earlier phases unlock later ones.

### Phase A — Close the Phase 1–5 Debt (highest ROI, no new concepts)

Goal: fix the plumbing gaps that weaken the system we already have, before adding new machinery.

| # | Item | Where | Why |
|---|------|-------|-----|
| A1 | **Per-node injection tracking** | `engine.ts` node loop + new `learning_injections` collection | Unblocks accurate confirm/contradict per node; unblocks execution-detail UI that currently returns `injected: []`. |
| A2 | **Consolidation cron** (daily) | new `packages/server/src/jobs/consolidate-learnings.ts` | Merge high-similarity pairs, archive <0.3 confidence, decay unused >60d, clean supersession chains, re-enforce growth limits. Listed in `learning-system-design.md §6.2` but never built. |
| A3 | **User scope level** (`user_id`) | extend `Learning.scope.level`, add `userId` to `exec.state.__contextTags` | Aligns with Mem0 standard; needed for per-user preferences that today get mis-scoped as `global`. |
| A4 | **Temporal-aware queries** | `learning.service.ts` list + query | Add `asOf?: Date` param; filter `validFrom <= asOf AND (supersededAt IS NULL OR supersededAt > asOf)`. Data already present. |
| A5 | **Make embeddings primary** | `embedding.ts`, `learning-manager.ts:findSimilar` | Promote cosine similarity to primary channel, keep Jaccard as fallback. Pre-embed on write (already started), backfill job for existing rows. |
| A6 | **LLM-judge contradiction fallback** | `learning-manager.ts:contradicts` | Keep regex as cheap first pass; on borderline similarity (0.6–0.8), delegate to Haiku judge. |

Exit criteria: execution-detail page shows correct injected/confirmed/contradicted per node; nightly consolidation runs and reports merge/archive counts; per-user preferences are respected across workflows.

### Phase B — Memory Blocks (Letta pattern)

Introduce structured memory blocks alongside the existing atomic learnings. Blocks complement, not replace, learnings.

| # | Item | Description |
|---|------|-------------|
| B1 | `MemoryBlock` schema | `{ _id, label, value, sizeLimit, description, readOnly, scope, ownerEntity, tokenCount, version, updatedAt, updatedByExecutionId }` |
| B2 | **Block labels** shipped by default | `persona`, `user-profile`, `repo:<path>`, `workflow:<name>`, `project-brief`, `conventions` |
| B3 | **Agent self-edit tools** | Wire `memory_append`, `rethink_block`, `archive_block` into the MCP server (`flowforge-mcp-server.ts`) and into the agent tool surface in `node-executor.ts`. Agents can explicitly rewrite their working memory. |
| B4 | **Block injection** | At node start, load the N most relevant blocks by scope into prompt under `WORKING MEMORY:` header, separate from `LEARNINGS`. Share the 800-token budget: 400 blocks + 400 learnings. |
| B5 | **Block vs Learning boundary** | Blocks = synthesized truth per entity, rewritten in place (e.g. "what we know about repo X"). Learnings = append-only delta facts from a single execution. Blocks are built *from* learnings by the consolidation cron. |
| B6 | **Human edit UI** | `MemoryBlocksPage.tsx` — textarea with size meter and history. Critical for trust. |

### Phase C — Entity & Knowledge Graph (Zep + GBrain)

Promote `contextTags` from strings to entities with relationships.

| # | Item | Description |
|---|------|-------------|
| C1 | `Entity` collection | `{ _id, kind: repo/person/workflow/module/client/..., name, aliases[], metadata, firstSeenAt }` |
| C2 | `Relationship` edges | `{ from, to, kind, validFrom, validTo, confidence, sourceExecutionId }` |
| C3 | **Entity extraction** | Run on every execution start against the task description (cheap Haiku pass, ~$0.002). Enrich `contextTags` automatically with resolved entity IDs. |
| C4 | **Entity pages** | Each entity gets a MemoryBlock automatically (`label: repo:<path>`). Dream cycle keeps it synthesized. |
| C5 | **Graph-backed retrieval** | When querying learnings for repo X, also traverse to related entities (parent org, teammates, sibling modules) and include learnings from one hop out, downweighted. |
| C6 | **Point-in-time queries** | Use `validFrom/validTo` on edges to answer "what was the stack on 2026-01-01?". |

### Phase D — Skill Library (Voyager + GBrain `skills/`)

Promote `type: skill` learnings into executable, reusable procedures.

| # | Item | Description |
|---|------|-------------|
| D1 | `Skill` schema | `{ _id, name, description, trigger: string/pattern, body: markdown, inputs: JSONSchema, tool_requirements[], scope, confidence, usageCount, lastUsedAt }` |
| D2 | **Skill extraction** | When a successful execution matches no existing skill but used ≥3 tool calls in a coherent pattern, post-exec review proposes a skill draft. |
| D3 | **Skill injection** | Pre-node retrieval picks top-K skills matching the task description (semantic + trigger pattern), injects as `AVAILABLE SKILLS: <name>: <description>` with the body fetched on demand via a `load_skill` tool. Keeps prompt small. |
| D4 | **Skill library UI** | Browse, edit, approve, version, fork. Stored as markdown in a `skills/` directory under the workspace, mirrored to Mongo for query. |
| D5 | **Human-authored skills** | Users can drop a markdown file into `skills/` and it's indexed automatically. Matches GBrain DX. |

### Phase E — Dream Cycles (GBrain pattern)

Background maintenance that makes the brain "compound." Builds on Phase A2's consolidation cron.

| # | Item | Description |
|---|------|-------------|
| E1 | **Nightly entity sweep** | Scan last 24h of executions, extract entities, reconcile aliases, update entity pages |
| E2 | **Staleness detection** | Mark learnings/blocks whose last confirmation is >30d old and whose entities were active in that window — these are suspect, surface in UI |
| E3 | **Citation repair** | Verify `source.executionId` still exists, fix dead links, re-link superseded chains |
| E4 | **Memory-block recompaction** | Rewrite each memory block by summarizing its owning entity's top learnings (cheap LLM call, only if block has >N dirty learnings since last compaction) |
| E5 | **Health report** | Daily digest surfaced in LearningsPage: merged, archived, decayed, new entities, stale blocks |

### Phase F — Evaluation (LOCOMO-style)

You cannot improve what you don't measure. The "Agent Memory Race" article's unsolved problem is exactly this.

| # | Item | Description |
|---|------|-------------|
| F1 | **Replay harness** | Record a set of "golden" executions with known expected outcomes. Re-run them with memory on/off/alternative configs. |
| F2 | **Metrics** | Per benchmark run: success rate, retry count, token spend on injection, p50/p95 latency added by retrieval, % injected learnings actually used in the final answer (LLM-judge). |
| F3 | **Ablations** | memory off / learnings only / blocks only / skills only / full. Establish a baseline before Phases B–D land so gains are provable. |
| F4 | **Regression gate** | CI job that fails PRs that regress the replay suite by >5% on success or token cost. |

### Phase G — Nice-to-Haves (revisit after A–F)

- **Markdown + git storage layer** (GBrain) — mirror blocks and skills to a git repo per workspace; humans can hand-edit and diff. Mongo stays as the query store.
- **Context Repositories / versioning** — branching and rollback of an agent's memory state; useful for "try this memory state on that task."
- **LLM-pass extraction** — promote post-exec review from optional to default for coding workflows, run it on every execution with retries. Compare against agent self-report extraction on the replay suite (F3).
- **Cross-device identity** / user linking — once `user_id` scope ships in A3.
- **Procedural episodic distinction** — formally split `episodic` (what happened) from `semantic` (what's true) in the schema, per Mem0 v1.

---

## 6. Ordering & Dependencies

```
A (plumbing debt) ──┬──> B (memory blocks) ──┬──> E (dream cycles)
                    │                         │
                    ├──> C (entity/graph) ────┤
                    │                         │
                    └──> D (skill library) ───┘
                                              │
                                              v
                                              F (evaluation, in parallel from A onward)
                                              │
                                              v
                                              G (nice-to-haves)
```

- **A is prerequisite for everything** — without per-node tracking and consolidation, new memory types just amplify existing noise.
- **F should start in parallel with A.** Build the replay harness now against the current system so later phases have a baseline.
- **B, C, D are independent** and can ship in any order once A is done. Recommendation: B first (biggest single UX improvement), then D (unlocks "agents that actually learn skills"), then C (unlocks cross-entity inference).
- **E depends on B + C** (dream cycles maintain blocks and entity pages).
- **G is opportunistic.**

---

## 7. What Not To Build

Keeping these out of scope to avoid complexity without proven value:

- **Verbatim conversation storage** (MemPalace). We already trade off recall for token budget; storing raw turns duplicates what `executions` collection already holds.
- **Separate vector DB** (Pinecone/Qdrant). Our scale doesn't need it; Mongo Atlas vector search or continuing with in-memory cosine on 384-dim MiniLM is sufficient through at least 100k learnings.
- **Graph database** (Neo4j/Kuzu). A two-table `entities` + `relationships` in Mongo covers Phase C for 1–2 years. Re-evaluate if traversal queries dominate retrieval latency.
- **Full OS/filesystem metaphor** (OpenViking). Letta memory blocks give us 80% of the benefit at 20% of the complexity.
- **Model-specific harness coupling.** The existing learning system is already provider-agnostic (Claude + Codex share learnings). Don't regress this.

---

## 8. Open Questions

1. **Should memory blocks replace learnings, or coexist?** Current plan says coexist (blocks = synthesized, learnings = raw deltas). Letta is moving toward blocks-only for Letta Code. Worth a spike after Phase A to see if atomic learnings still pull weight once blocks exist.
2. **Where does the markdown/git storage layer live?** In the workspace directory (where it's human-editable next to code) or in a central `~/.flowforge/brain/` (where it survives workspace resets)? GBrain picked the latter; Letta Context Repositories picked the former.
3. **User scope (A3) — per-human-user or per-API-key?** Likely per-human-user, but depends on how auth context flows into the engine today. Confirm in `org-context.ts` before implementing.
4. **Extraction primacy.** Mem0 and Zep say separate-LLM-pass wins. We chose agent-self-report + optional post-exec. Phase F should settle this empirically before we invest more in either.
5. **Skill execution sandbox.** Phase D1 stores skills as markdown with a JSONSchema input. Do we actually *execute* them (like Voyager) or only reference them as prompt recipes? Start with prompt recipes; add execution only if the replay suite shows a meaningful gap.

---

## 9. Sources

- Letta — [Memory Blocks: The Key to Agentic Context Management](https://www.letta.com/blog/memory-blocks)
- Letta — [Letta Code: A Memory-First Coding Agent](https://www.letta.com/blog/letta-code)
- Letta — [Rearchitecting Letta's Agent Loop](https://www.letta.com/blog/letta-v1-agent)
- Mem0 — [State of AI Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- OSS Insight — [The Agent Memory Race of 2026](https://ossinsight.io/blog/agent-memory-race-2026)
- InfoQ — [Ramp Builds Internal Coding Agent That Powers 30% of Engineering PRs](https://www.infoq.com/news/2026/01/ramp-coding-agent-platform/)
- GitHub — [garrytan/gbrain](https://github.com/garrytan/gbrain)
- Internal — `docs/plans/learning-system-design.md`
- Internal — `docs/plans/learning-system-research.md`
