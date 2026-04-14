# FlowForge Skill Library — Design

**Date:** 2026-04-14
**Status:** Design. Companion to `memory-system-gap-analysis-2026.md` (Phase D).
**Purpose:** Define how reusable agent procedures ("skills") are stored, retrieved, loaded, authored, and evolved — alongside the existing learnings and future memory blocks.

---

## 1. What a Skill Is (and Is Not)

A **skill** is a reusable procedure the agent follows to accomplish a discrete, nameable goal: running tests, deploying to staging, generating a commit message, executing a chunked pricing update. It is a **markdown recipe** with structured metadata — not executable code.

### 1.1 Skill vs learning vs memory block vs workflow node

| Concept | Rigidity | Length | Invocation | Storage | Purpose |
|---------|----------|--------|------------|---------|---------|
| Workflow node | Deterministic — executor runs it | code | `workflow.yml` | TS code | Hard guarantees |
| **Skill** | Recipe — agent follows it | 200–2000 tok | Agent calls `skill_load()` via MCP | `.flowforge/skills/*.md` | Repeatable procedures |
| Memory block | Synthesized truth | 100–800 tok | Prompt injection at spawn | `.flowforge/blocks/*.md` | What we know about an entity |
| Learning | Atomic fact | 30–100 tok | Prompt injection at spawn | Mongo + `.flowforge/learnings/*.md` | Delta facts from one execution |

**Explicit non-goal:** skills are not executable code. Voyager executes code; FlowForge does not. Reasons:
- Sandboxing executable skills is a full security surface.
- The agent already has `bash` and file tools — the skill's job is to tell it *what to run*, not to run it itself.
- Markdown recipes are reviewable by non-engineers.

If a procedure needs deterministic invocation (not "the agent might deviate"), it belongs in a workflow node, not a skill. Keep this boundary sharp.

---

## 2. Storage — Dual Write (Markdown + Mongo Index)

Same pattern as memory blocks and learnings: **markdown on the `flowforge/memory` orphan branch is the source of truth; Mongo is the query index.**

### 2.1 File layout

```
<WORKSPACE_BASE>/_memory/<repoId>/.flowforge/skills/
    run-tests.md
    deploy-staging.md
    pricing-update.md
    _archive/
        run-tests-v1.md              # superseded versions, still queryable via git
        run-tests-v2.md
    _global/                         # applies to any repo
        write-commit-message.md
        clarify-requirements.md
    _users/<userId>/                 # user-specific procedures
        morning-standup-summary.md
```

- Lives on the `flowforge/memory` orphan branch (see `memory-system-gap-analysis-2026.md §5` and the memory-storage discussion).
- `_global/` is mirrored across all repos at read time by the retrieval layer, not by file duplication.
- `_users/<userId>/` is scoped to a single user across all their repos.
- `_archive/` keeps superseded versions findable by name; git history provides point-in-time queries for free.

### 2.2 File format

Frontmatter captures the machine-readable metadata that Mongo indexes. The markdown body is the recipe the agent reads — it is never parsed by code, only loaded as a string.

```markdown
---
id: 01HX9F2K8P-run-tests
name: run-tests
description: Run the test suite for this repo with the correct runner and flags.
trigger:
  keywords: [test, tests, run tests, vitest, jest, pytest]
  intent: "user or agent wants to execute the test suite"
  node_patterns: ["test", "verify", "qa"]
inputs:
  type: object
  properties:
    filter:
      type: string
      description: Optional path or name filter
    watch:
      type: boolean
      default: false
  required: []
tools_required: [bash]
scope:
  level: context
  contextTags: ["repo:/Users/shree/es-data-pipeline"]
provenance:
  source: retry_delta
  first_learned_execution: 64f...
  confirmed_by: [64f..., 651..., 653...]
quality:
  confidence: 0.92
  usage_count: 47
  last_used_at: 2026-04-12T09:31:00Z
  success_rate: 0.94
lifecycle:
  status: active           # active | draft | deprecated | superseded
  version: 3
  superseded_by: null
  created_at: 2026-02-14T11:02:00Z
  updated_at: 2026-04-10T18:22:00Z
---

# run-tests

## When to use
Use this when the task involves running tests in this repo — either the full suite
or a filtered subset. Do NOT use this for type-checking (see `typecheck` skill) or
for linting (see `lint` skill).

## Steps
1. Confirm you are at the repo root: `pwd` should end in `es-data-pipeline`.
2. Run: `pnpm vitest run --reporter=dot` (NOT `npm test` — this repo uses pnpm + vitest).
3. If `{{ inputs.filter }}` is set, append ` -- {{ inputs.filter }}`.
4. If `{{ inputs.watch }}` is true, replace `run` with `watch`.
5. On failure, grep the output for `FAIL ` and report the failing file paths.

## Known gotchas
- Vitest sometimes hangs on `pricing-update.test.ts` due to a 2-min DB timeout.
  If you see it hang >2min, kill and retry with `--pool=forks`.
- Do not run with `--coverage` in CI — the server runs out of memory.

## Verification
The skill succeeded if the final line of output contains `Test Files` and there
are 0 failed tests. Report the exact count back to the caller.
```

**Design choices:**

- **Frontmatter indexed verbatim into Mongo** — fast retrieval by keywords, scope, confidence without re-parsing files.
- **Body is never parsed by code** — loaded as a raw string and dropped into the agent prompt at `skill_load` time. No brittle schema to maintain.
- **`{{ inputs.foo }}` templating** is one line of Mustache-style substitution at load time. Intentionally primitive — no real DSL, no logic, no loops.
- **Provenance + lifecycle fields** reuse the same quality-control loop as learnings: confirm/contradict, supersession, deprecation.
- **`tools_required`** lets retrieval skip skills whose tools aren't available in the current node's tool surface.

### 2.3 Mongo index schema

```ts
interface SkillIndex {
  _id: ObjectId;
  skillId: string;            // "01HX9F2K8P-run-tests" from frontmatter
  repoId: ObjectId | null;    // null for _global
  userId: ObjectId | null;    // null unless user-scoped
  name: string;               // "run-tests" — unique within (repoId, userId, status=active)
  description: string;
  trigger: {
    keywords: string[];
    intent: string;
    nodePatterns: string[];
  };
  scope: Learning['scope'];   // reuse existing scope type from learnings
  inputsSchema: object;       // JSONSchema from frontmatter
  toolsRequired: string[];
  filePath: string;           // relative to memory worktree root
  embedding?: number[];       // 384-dim MiniLM, optional — for semantic trigger match
  confidence: number;
  usageCount: number;
  successRate: number;        // confirmations / (confirmations + contradictions)
  lastUsedAt?: Date;
  status: 'active' | 'draft' | 'deprecated' | 'superseded';
  version: number;
  supersededBy?: ObjectId;
  contentHash: string;        // sha256 of the markdown body — detects file drift
  createdAt: Date;
  updatedAt: Date;
}
```

**Critical:** the body is **not** stored in Mongo — only `filePath` and `contentHash`. The markdown file is the single source of truth. Mongo is a cache that can be rebuilt from files at any time by the file watcher or a manual reindex job.

**Indexes:**
```
{ repoId: 1, status: 1, confidence: -1 }
{ 'scope.level': 1, 'scope.contextTags': 1 }
{ 'trigger.keywords': 1 }
{ contentHash: 1 }                              // dedup
{ name: 1, repoId: 1, status: 1 }               // lookup by name
// Atlas vector index on `embedding` (Phase 2)
```

---

## 3. Retrieval & Loading — Two Stage

The critical difference from learnings: **skill bodies are not injected into every prompt.** A single skill body can eat the entire learnings token budget. Instead, skills are loaded on demand.

### 3.1 Stage 1 — pre-spawn injection (menu only, ~100 tokens)

At node spawn, the engine retrieves top-K skills by scope + trigger match and injects only their `name` + `description`:

```
AVAILABLE SKILLS (call `skill_load(name)` to get full recipe):
- run-tests: Run the test suite for this repo with the correct runner and flags
- pricing-update: Execute the chunked two-phase pricing update with 2-min query timeout
- deploy-staging: Trigger the staging deploy GitHub Action and watch for completion
```

- Hard cap at **5 skills** — longer menus overwhelm the agent. Better to miss a skill than to drown the prompt.
- Fits in ~100 tokens (well under the `nodeContext` budget alongside WORKING MEMORY and LEARNINGS).
- Injected via the same `nodeContext` string the engine already builds in `engine.ts` before calling `node-executor`.

### 3.2 Stage 2 — on-demand via MCP

The agent calls `skill_load(name)` mid-task when it decides to use a skill. The server:

1. Looks up `SkillIndex` by `(repoId, name, status: active)`.
2. Reads `.flowforge/skills/<name>.md` from the memory worktree.
3. Verifies `sha256(body) === contentHash` — if mismatched, reindex the file and retry (catches manual edits that bypassed the service).
4. Strips frontmatter, substitutes `{{ inputs.* }}` from the tool-call's `inputs` arg, returns the body as a string.
5. Records a `skill_loaded` event: `{ executionId, nodeName, skillId, loadedAt }` — used later for confirm/contradict.

The agent inlines the returned body into its next reasoning step. Typical cost per node: 0 or 1 skill body. Multiple skills in one node are possible but rare.

### 3.3 Retrieval logic

```ts
async function retrieveSkillsForNode(
  repoId: ObjectId,
  userId: ObjectId | null,
  task: string,           // the task description / user prompt
  nodeName: string,
  contextTags: string[],
  availableTools: string[],
): Promise<SkillIndex[]> {
  // 1. Scope filter: repo-specific + user + global, status=active
  const candidates = await db.skills.find({
    status: 'active',
    $or: [
      { repoId, 'scope.contextTags': { $not: { $elemMatch: { $nin: contextTags } } } },
      { userId },
      { repoId: null, userId: null },
    ],
    // Exclude skills requiring tools we don't have
    toolsRequired: { $not: { $elemMatch: { $nin: availableTools } } },
  }).toArray();

  // 2. Score each candidate
  const taskLower = task.toLowerCase();
  const scored = candidates.map(s => {
    const keywordHits = s.trigger.keywords.filter(k =>
      taskLower.includes(k.toLowerCase()),
    ).length;
    const nodeMatch = s.trigger.nodePatterns.some(p => new RegExp(p).test(nodeName));
    const semantic = s.embedding ? cosine(embedOnce(task), s.embedding) : 0;

    return {
      skill: s,
      score:
        keywordHits * 0.4 +
        (nodeMatch ? 0.3 : 0) +
        semantic * 0.2 +
        s.confidence * 0.1,
    };
  });

  return scored
    .filter(s => s.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(s => s.skill);
}
```

**Scoring weights (tunable):**
- Keyword hits: 0.4 — cheapest and highest precision signal.
- Node pattern match: 0.3 — "this is a test node" is strong evidence for a test skill.
- Semantic embedding: 0.2 — catches paraphrases ("verify the suite" → `run-tests`).
- Confidence: 0.1 — tiebreaker only. We don't want high-confidence-but-irrelevant skills crowding out lower-confidence-but-relevant ones.

---

## 4. MCP Tools

All skill access goes through `flowforge-mcp-server.ts`. No raw filesystem reads by the agent.

```ts
skill_list(filter?: { scope?, keywords? }) → Array<{ name, description }>
  // Returns the same menu the agent saw in the prompt. Useful if the agent
  // wants to re-check what's available mid-task.

skill_load(name: string, inputs?: object) → {
  name: string,
  description: string,
  body: string,          // frontmatter stripped, {{ inputs.* }} substituted
  inputsSchema: object,
  version: number,
}
  // The agent's primary way to consume a skill.

skill_propose({
  name, description, trigger, inputs, body, scope
}) → { skillId, status: 'draft' }
  // Agent proposes a new skill based on what it just figured out.
  // Always lands as draft — requires human approval.

skill_report_outcome(skillId: string, outcome: 'success' | 'partial' | 'failure', note?: string)
  // Agent reports how the skill performed. Feeds confirm/contradict loop.
```

The MCP session already knows `repoId`, `userId`, and `executionId` from the engine context — these are not tool arguments.

---

## 5. Authoring — Four Paths

### 5.1 Human-authored (the most important one)

User drops `my-skill.md` into `.flowforge/skills/` directly (or edits an existing one). A file watcher on the memory worktree (reuse the `workspace-watcher.ts` pattern) sees the change, parses frontmatter, reindexes into Mongo, lands as `status: active` with `confidence: 0.9` (trusted source).

**Why this is first:** the best skills come from humans writing them once. A hand-written `run-tests.md` with the actual command, the actual gotchas, and the actual verification step beats any amount of auto-discovery. The library only becomes useful if humans can seed it.

### 5.2 Agent-explicit via MCP

Agent calls `skill_propose(...)` mid-task when it figures out something reusable. Lands as `status: draft`. Surfaced in the Learnings/Skills UI for human review before it becomes active.

### 5.3 Post-execution review (auto-discovery)

Extend the existing `triggerPostExecutionReview` Haiku pass in `learning-manager.ts`:

```
If this execution used a sequence of ≥3 tool calls that achieved a discrete,
nameable goal, and no existing skill matches (check against SkillIndex trigger
keywords), propose a new skill as JSON:
{
  "name": "...",
  "description": "...",
  "trigger": { "keywords": [...], "intent": "..." },
  "body": "markdown recipe based on what just happened"
}
```

Proposed skills land as `draft`. Never activated automatically — the drafts page is the review queue.

### 5.4 Promoted from a learning

When a `type: skill` learning reaches `confidence > 0.8` and has been confirmed ≥5 times, the consolidation cron (Phase A2 of the gap-analysis) promotes it:
1. Generates a draft `.md` file with the learning's content as the body.
2. Marks the learning `status: evolved`, `evolvedTo: <skillId>`.
3. Surfaces in the UI for human review and refinement.

---

## 6. Quality Control — Confirm / Contradict / Supersede

Reuse the learning system's lifecycle, adapted for skills.

### 6.1 Confirm/contradict feedback loop

When a node calls `skill_load`, the engine records the mapping `(executionId, nodeName) → skillId`. After the node completes:

- **Success** → `skill.usageCount++`, recompute `successRate`, bump `confidence` by `+0.05` (cap 0.95), update `lastUsedAt`.
- **Failure** → record contradiction. If `successRate < 0.5` and `usageCount >= 5`, auto-mark `status: deprecated` and surface in UI.
- **Agent called `skill_report_outcome('failure', note)`** → stronger signal than a silent node failure; deprecate immediately if note indicates the skill was wrong.

This is tracked per-`(execution, node)`, not per-execution — solving the same per-node tracking gap called out in the gap-analysis doc (Phase A1).

### 6.2 Versioning

Every edit bumps `version: N` in frontmatter and produces a new git commit on `flowforge/memory`. Full history is free.

**Semantic version bumps (major semantic change):**
- Create the new version at `.flowforge/skills/<name>.md` (same filename — Mongo `name` + `status: active` is unique).
- Move the previous active version to `.flowforge/skills/_archive/<name>-v<oldVersion>.md` with `status: superseded`, `supersededBy: <newId>`.
- Point-in-time queries are free via git: `git show flowforge/memory@{2026-03-01}:.flowforge/skills/run-tests.md`.

### 6.3 Deprecation

Deprecated skills:
- Stay in the index with `status: deprecated`.
- Are **not** injected in the Stage 1 menu.
- **Are** returned by `skill_load` if explicitly requested by name, with a warning in the response body: `> DEPRECATED: use <replacement> instead.`
- Can be un-deprecated by human action in the UI.

### 6.4 Drift detection

The `contentHash` field catches manual edits that bypassed the service. On `skill_load`:
1. Read file body.
2. Compute sha256.
3. If mismatch, reindex the file (parse frontmatter, update Mongo row, recompute hash) before returning.
4. Emit a warning log so operators notice drift.

---

## 7. Integration Points

### 7.1 `engine/src/engine.ts`

At the start of `run()`, alongside the existing `deriveContextTags()` call:
- Resolve `repoId` and `userId` into `exec.state`.
- No change to the main loop yet — skill retrieval happens in node setup.

In the node-setup path (where `nodeContext` is built), add a step after learning injection:
```
const skills = await skillManager.retrieve(repoId, userId, task, nodeName, contextTags, availableTools);
const skillMenu = buildSkillMenu(skills);       // "AVAILABLE SKILLS: ..."
nodeContext += "\n" + skillMenu;

// Track what was offered so confirm/contradict knows the candidate set
exec.state.__offeredSkills ??= {};
exec.state.__offeredSkills[nodeName] = skills.map(s => s.skillId);
```

After a node completes successfully (in the existing confirmation path):
```
const loaded = await skillManager.getLoadedSkillsForNode(executionId, nodeName);
for (const skillId of loaded) {
  await skillManager.confirm(skillId, executionId, nodeName);
}
```

After a node fails (in the existing contradiction path):
```
for (const skillId of loaded) {
  await skillManager.contradict(skillId, executionId, nodeName);
}
```

### 7.2 `server/src/services/flowforge-mcp-server.ts`

Register the four MCP tools from §4. Each resolves `repoId` / `userId` / `executionId` from the MCP session context (same mechanism memory_* tools use — see the memory storage discussion).

### 7.3 `server/src/services/skill-manager.ts` (new)

The core service:
```ts
class SkillManager {
  retrieve(repoId, userId, task, nodeName, contextTags, availableTools): Promise<SkillIndex[]>
  load(repoId, name, inputs): Promise<{ body, description, version, inputsSchema }>
  list(filter): Promise<Array<{ name, description }>>
  propose(draft): Promise<{ skillId, status }>
  confirm(skillId, executionId, nodeName): Promise<void>
  contradict(skillId, executionId, nodeName): Promise<void>
  reindex(filePath): Promise<void>       // called by file watcher
  reindexAll(repoId): Promise<void>      // full rebuild from disk
}
```

Writes go through the memory service (`memoryService.write(repoId, path, content)`) which handles the Mongo-mirror + debounced git commit, same as blocks and learnings.

### 7.4 File watcher

Extend `workspace-watcher.ts` or add a dedicated `memory-watcher.ts` that tails the memory worktree:
- On `.md` add/change under `.flowforge/skills/` → `skillManager.reindex(path)`.
- On `.md` delete → mark the Mongo row as `status: archived`.

### 7.5 UI

New page `packages/ui/src/pages/SkillsPage.tsx`:
- List view filterable by repo / user / global, status, confidence.
- Draft queue — pending skills awaiting approval, with approve/edit/reject actions.
- Detail view — frontmatter editor + markdown editor + preview of how the skill appears in the Stage 1 menu and Stage 2 load output.
- Usage analytics per skill: usage count, success rate, last used, source executions.
- Version history — via git log of the file.

---

## 8. Token Budget Accounting

| Phase | Budget | Notes |
|-------|--------|-------|
| Stage 1 menu (pre-spawn) | ~100 tok | 5 skills × ~20 tok each |
| Stage 2 body (per `skill_load` call) | 200–2000 tok | Not double-counted against `nodeContext` — it's a tool call return |
| `skill_propose` agent output | variable | Standard tool-call output, no extra budget |

The `nodeContext` budget from the gap-analysis doc becomes:
```
Total: ~900 tokens
  ├─ WORKING MEMORY (blocks):      ~400
  ├─ LEARNINGS:                    ~350
  ├─ AVAILABLE SKILLS (menu):      ~100
  └─ AUTO-GATE CONTEXT:            ~50
```

Skill bodies loaded at Stage 2 count against the node's **conversation** budget, not `nodeContext` — they arrive as tool results during the agent's turn-by-turn reasoning.

---

## 9. Minimum Viable First Cut

Before building the full design, ship this slice to prove the shape works:

| # | Item | Where |
|---|------|-------|
| 1 | `.flowforge/skills/*.md` directory on the memory branch (no `_global`, `_users`, `_archive` yet) | Memory worktree setup |
| 2 | Minimal `SkillIndex`: `name`, `description`, `trigger.keywords`, `filePath`, `contentHash`, `confidence`, `status`, `usageCount`, `successRate` | `server/database/indexes.ts` |
| 3 | `SkillManager.retrieve / load / reindex` — keyword-only scoring, no embeddings yet | `server/services/skill-manager.ts` |
| 4 | File watcher that reindexes `.md` files on change | extend `workspace-watcher.ts` |
| 5 | `skill_load` + `skill_list` MCP tools (no `propose`, no `report_outcome` yet) | `flowforge-mcp-server.ts` |
| 6 | Stage-1 injection in `engine.ts` — top 5 skills by keyword match, appended to `nodeContext` | `engine.ts` |
| 7 | Confirm/contradict hooks on node success/failure, tracking `__loadedSkills` per-node | `engine.ts` |
| 8 | 10 hand-written skills for one test repo — the bar that proves the system works end to end | manual |

**Not in MVP:** agent proposals, post-exec auto-discovery, semantic embeddings, global/user scopes, archive/supersession, learning→skill promotion, UI page.

Each excluded item is a follow-up PR. Don't build any of them until MVP is landing value on real executions.

---

## 10. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Agent ignores the skill menu and reinvents the procedure | Measure via replay harness (Phase F). If skills don't change behavior, the menu text isn't persuasive enough — rewrite descriptions, not retrieval. |
| Skills become stale when the repo changes (e.g. moves from pnpm to bun) | Confirm/contradict auto-deprecates on `successRate < 0.5`. Consolidation cron flags skills that haven't been used in 60d. |
| Library gets polluted with one-shot garbage from agent proposals | Drafts require human approval. Never auto-activate. |
| Drift between markdown files and Mongo index | `contentHash` check on every load + file watcher reindex + startup full-rebuild job. |
| Conflicts between skill names across scopes (repo vs global) | Retrieval prefers most-specific scope. If a repo defines `run-tests` and global also has `run-tests`, the repo one wins. Document this. |
| Agent loads 5 skills in one node and blows the context | Hard cap of 5 in the menu, hard cap of 2 in the load count per node (error on the 3rd `skill_load` with "this node has already loaded 2 skills — finish one before loading another"). |
| Skills drift from reality silently | Replay harness (Phase F) re-runs golden executions against current skill versions; regressions surface in CI. |

---

## 11. Open Questions

1. **Should agent-proposed skills auto-activate at some confidence threshold?** Current answer: no, always require human review. Revisit after MVP if the draft queue backs up.
2. **Global skills storage — mirror at read time or materialize in every repo?** Read-time mirroring keeps the memory branch smaller but couples retrieval to two directories. Start with read-time mirroring, revisit if latency shows up.
3. **Do skills need structured inputs at all, or is free-text invocation enough?** JSONSchema inputs add complexity but give the agent a way to validate before calling. Keep schema as optional frontmatter; MVP can ignore it and pass the whole task description.
4. **Skill execution sandbox** (Voyager-style)? Explicit non-goal for now. Revisit only if the replay suite shows a meaningful gap vs recipe-only.
5. **Per-workflow vs per-repo scoping.** A `deploy-staging` skill is clearly repo-scoped. A `clarify-requirements` skill is workflow-scoped. The schema supports both via `scope.level`; naming collisions across scopes need a convention — probably `<workflow>:<name>` as the display name when ambiguous.
6. **How do skills interact with memory blocks?** A skill's body might want to reference "whatever we know about this repo" — could it pull in the `repo` block by reference? Keep simple for MVP: skills are self-contained strings, no transclusion.

---

## 12. Related Docs

- `docs/plans/memory-system-gap-analysis-2026.md` — parent plan, Phase D is this document.
- `docs/plans/learning-system-design.md` — learning system this extends.
- `docs/plans/learning-system-research.md` — Voyager, GBrain, Letta references.
