# Allen Learning System — Design Plan

## 1. Overview

Allen learns from every workflow execution — failures, retries, human corrections, auto-gate signals — and injects relevant learnings into future executions. Works across all domains: coding, marketing, sales, data analysis, or any workflow.

No configuration needed. Learnings are automatically extracted, scoped, quality-controlled, and injected.

---

## 2. Learning Schema

```typescript
interface Learning {
  _id: ObjectId;

  // What was learned
  content: string;              // "This repo uses vitest, not jest"
  type: LearningType;
  tags: string[];               // Generic context tags for scoping

  // Scope — when to inject
  scope: {
    level: 'global' | 'workflow' | 'context' | 'role' | 'node_pattern';
    workflowName?: string;      // for workflow scope
    contextTags?: string[];     // for context scope — matches execution tags
    roleName?: string;          // for role scope
    nodePattern?: string;       // for node_pattern scope (regex or name)
  };

  // Origin — where it came from
  source: {
    executionId: string;
    nodeName: string;
    workflowName: string;
    sourceType: 'retry_delta' | 'auto_gate' | 'human_correction' | 'agent_explicit' | 'post_execution_review' | 'manual';
    timestamp: Date;
  };

  // Quality
  confidence: number;           // 0-1
  confirmations: number;        // executions that confirmed this
  contradictions: number;       // executions that contradicted this

  // Usage tracking
  usageCount: number;           // how many times injected into a prompt
  lastUsedAt?: Date;
  lastConfirmedAt?: Date;

  // Temporal metadata
  validFrom: Date;              // when this learning became true
  supersededBy?: ObjectId;      // learning that replaced this one
  supersededAt?: Date;

  // Token management
  tokenCount: number;           // estimated tokens for injection budgeting

  // Lifecycle
  status: 'active' | 'archived' | 'superseded';
  createdAt: Date;
  updatedAt: Date;
}

type LearningType =
  | 'fact'          // "PostgreSQL runs on port 5433"
  | 'pattern'       // "For this repo, always run vitest"
  | 'mistake'       // "Don't use npm test — this repo uses vitest"
  | 'preference'    // "Always include source URLs in answers"
  | 'skill'         // "To run pricing update: npm run pricing -- --mode daily"
  | 'optimization'; // "Use batch inserts, not individual INSERTs"
```

### Context Tags (Generic Scoping)

Instead of hardcoded `repoPath`, learnings use `contextTags` — flexible key-value pairs that work across any domain:

| Domain | Example Tags |
|--------|-------------|
| Coding | `repo:/Users/shree/es-data-pipeline`, `module:src/pricing-update`, `language:typescript` |
| Marketing | `platform:linkedin`, `content-type:blog`, `brand:allen` |
| Sales | `client:acme-corp`, `deal-stage:proposal`, `industry:healthcare` |
| Product | `product:allen`, `feature:auto-gate`, `audience:developers` |
| General | `team:engineering`, `priority:high`, `region:us` |

When an execution starts, its context tags are derived from:
- Repo metadata (from repo management): `repo:path`, `language:X`, `framework:Y`
- Workflow metadata: `workflow:sdlc`
- Input fields: extracted from task description
- User-provided tags

Learnings match when their `scope.contextTags` are a **subset** of the execution's context tags.

---

## 3. Extraction: How Learnings Are Created

### 3.1 Implicit Extraction (Automatic — No Extra LLM Call)

**From retry deltas:**
```
Node "implement" failed (attempt 1): "Connection refused on port 5432"
Node "implement" succeeded (attempt 2): used port 5433

→ Learning extracted:
  content: "PostgreSQL runs on port 5433 locally, not 5432"
  type: mistake
  scope: { level: context, contextTags: ["repo:/Users/shree/es-data-pipeline"] }
  source: { sourceType: retry_delta }
```

**From auto-gate stops:**
```
Node "plan" returned __action: "stop", __reason: "Health route already exists at GET /api/health"

→ Learning extracted:
  content: "Health route already exists at GET /api/health"
  type: fact
  scope: { level: context, contextTags: ["repo:/Users/shree/es-data-pipeline"] }
  source: { sourceType: auto_gate }
```

**From human corrections (clarify):**
```
Node "draft" asked: "Who is the recipient?"
Human answered: { recipient: "John", purpose: "budget approval", tone: "formal" }

→ Learning extracted:
  content: "When asked to 'draft an email' with no context, always ask for: recipient, purpose, key points, tone"
  type: pattern
  scope: { level: workflow, workflowName: "email-drafter" }
  source: { sourceType: human_correction }
```

**Cost: Zero extra LLM calls.** All extracted from data already available in the execution.

### 3.2 Explicit Extraction (Agent Returns Learnings)

Agents can include `__learnings` in their JSON output:

```json
{
  "answer": "...",
  "__learnings": [
    {
      "content": "This repo uses pnpm, not npm. Lock file is pnpm-lock.yaml.",
      "type": "fact",
      "tags": ["repo:/Users/shree/project"]
    }
  ]
}
```

**Cost: Zero extra LLM calls.** Extracted from the existing response.

`__learnings` is added to `GATE_FIELDS` in the output extractor so it's preserved during extraction.

### 3.3 Post-Execution Review (Optional — 1 Extra LLM Call)

After a workflow completes, optionally run a cheap LLM call to review the full execution trace and extract learnings that implicit extraction missed.

**When it runs:**
- Only on executions with retries, failures, or auto-gate events (not on clean runs)
- Uses cheapest available model (Haiku for Claude, gpt-5.1-codex-mini for Codex)
- Estimated cost: ~$0.005 per review

**Prompt:**
```
Review this workflow execution trace and extract learnings:

Workflow: sdlc
Task: "Fix pricing timeout"
Nodes: plan (completed 12s), implement (failed, retried, completed 45s), test (completed 8s)
Retry reason: "Used wrong database port"

Extract learnings as JSON array. Each learning has: content, type (fact/pattern/mistake/preference/skill/optimization), suggested scope (global/workflow/context), tags.
```

**When it does NOT run:**
- Clean executions (no retries, no failures, no auto-gate events)
- Executions under 30 seconds (too trivial)
- User disables it in settings

---

## 4. Storage: Mem0-Style Classification Before Write

Before storing a new learning, classify it against existing learnings using the Mem0 ADD/UPDATE/DELETE/NOOP pattern.

**Learning extraction is fire-and-forget.** Extraction errors are logged but NEVER block execution. If classification fails, the learning is stored as ADD (safe fallback).

### 4.1 `findSimilar()` — Similarity Detection

Phase 1-3 uses keyword-based similarity (no embeddings). Phase 6 upgrades to vector embeddings.

```typescript
interface SimilarResult {
  item: Learning;
  score: number; // 0-1
}

// Phase 1-3: Keyword Jaccard similarity
function findSimilar(content: string, scope: Learning['scope']): Promise<SimilarResult[]> {
  // Step 1: Query same scope from MongoDB
  const candidates = await db.learnings.find({
    status: 'active',
    'scope.level': scope.level,
    // Match scope-specific fields (workflowName, contextTags, roleName)
  }).limit(100).toArray();

  // Step 2: Compute Jaccard similarity on keyword sets
  const newKeywords = extractKeywords(content); // lowercase, remove stopwords, split on spaces/punctuation
  
  return candidates
    .map(item => {
      const existingKeywords = extractKeywords(item.content);
      const intersection = newKeywords.filter(k => existingKeywords.includes(k));
      const union = new Set([...newKeywords, ...existingKeywords]);
      const score = union.size > 0 ? intersection.length / union.size : 0;
      return { item, score };
    })
    .filter(r => r.score > 0.3) // minimum relevance threshold
    .sort((a, b) => b.score - a.score);
}

function extractKeywords(text: string): string[] {
  const stopwords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'it', 'this', 'that']);
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopwords.has(w));
}

// Phase 6 upgrade: replace Jaccard with cosine similarity on embeddings
```

### 4.2 `contradicts()` — Contradiction Detection

Detects when a new learning says the opposite of an existing one:

```typescript
function contradicts(newLearning: Learning, existing: Learning): boolean {
  const newContent = newLearning.content.toLowerCase();
  const existingContent = existing.content.toLowerCase();

  // Pattern 1: Explicit negation — "don't use X" vs "use X"
  const negationPairs = [
    [/don'?t use (.+)/, /use \1/],
    [/not (.+)/, /\1/],
    [/never (.+)/, /always \1/],
    [/is not (.+)/, /is \1/],
  ];
  for (const [negPattern, posPattern] of negationPairs) {
    if (negPattern.test(newContent) && posPattern.test(existingContent)) return true;
    if (posPattern.test(newContent) && negPattern.test(existingContent)) return true;
  }

  // Pattern 2: Conflicting values — "port 5432" vs "port 5433"
  const newNumbers = newContent.match(/\b\d+\b/g) ?? [];
  const existingNumbers = existingContent.match(/\b\d+\b/g) ?? [];
  // If they share most keywords but have different numbers, likely a contradiction
  const newKw = extractKeywords(newContent);
  const existingKw = extractKeywords(existingContent);
  const overlap = newKw.filter(k => existingKw.includes(k));
  if (overlap.length > 3 && newNumbers.length > 0 && existingNumbers.length > 0) {
    const numbersMatch = newNumbers.some(n => existingNumbers.includes(n));
    if (!numbersMatch) return true; // same topic, different values
  }

  // Pattern 3: Same subject but different assertion
  // "uses vitest" vs "uses jest" — same verb, different object
  const usesPattern = /\b(uses?|runs?|requires?|needs?)\s+(\w+)/;
  const newMatch = newContent.match(usesPattern);
  const existingMatch = existingContent.match(usesPattern);
  if (newMatch && existingMatch && newMatch[1] === existingMatch[1] && newMatch[2] !== existingMatch[2]) {
    // Check if they're about the same subject
    if (overlap.length >= 2) return true;
  }

  return false;
}
```

**Limitations:** Keyword-based contradiction detection is imprecise. False positives are acceptable (Mem0 UPDATE is the fallback). False negatives mean both learnings coexist until consolidation merges them. Phase 6 can upgrade to LLM-based contradiction detection.

### 4.3 `classifyAndStore()` — Full Classification

```typescript
async function classifyAndStore(newLearning: Learning): Promise<void> {
  try {
    const existing = await findSimilar(newLearning.content, newLearning.scope);
    
    if (existing.length === 0) {
      // ADD — genuinely new
      await enforceGrowthLimits(newLearning.scope);
      await db.learnings.insertOne(newLearning);
      return;
    }

    const { item: mostSimilar, score: similarity } = existing[0];

    if (similarity > 0.95) {
      // NOOP — duplicate, already known
      await confirm(mostSimilar._id, newLearning.source.executionId);
      return;
    }

    if (similarity > 0.7 && !contradicts(newLearning, mostSimilar)) {
      // UPDATE — refines/enhances existing learning
      await db.learnings.updateOne(
        { _id: mostSimilar._id },
        { 
          $set: { content: newLearning.content, updatedAt: new Date() },
          $inc: { confirmations: 1 },
        }
      );
      return;
    }

    if (contradicts(newLearning, mostSimilar)) {
      // DELETE old + ADD new — supersede
      await db.learnings.updateOne(
        { _id: mostSimilar._id },
        { $set: { status: 'superseded', supersededBy: newLearning._id, supersededAt: new Date() } }
      );
      await db.learnings.insertOne(newLearning);
      return;
    }

    // Different enough — ADD as new learning
    await enforceGrowthLimits(newLearning.scope);
    await db.learnings.insertOne(newLearning);
  } catch (err) {
    // Fire-and-forget: log error, never block execution
    console.error('Learning storage failed (non-blocking):', err);
  }
}
```

### 4.4 Growth Limits

Prevent unbounded learning accumulation:

```typescript
const GROWTH_LIMITS = {
  global: 200,
  workflow: 100,     // per workflow
  context: 500,      // per unique context tag set
  role: 50,          // per role
  node_pattern: 50,  // per pattern
};

async function enforceGrowthLimits(scope: Learning['scope']): Promise<void> {
  const limit = GROWTH_LIMITS[scope.level] ?? 500;
  const count = await db.learnings.countDocuments({
    'scope.level': scope.level,
    status: 'active',
    // ... match scope-specific fields
  });

  if (count >= limit) {
    // Archive lowest-confidence learning to make room
    const weakest = await db.learnings.findOne(
      { 'scope.level': scope.level, status: 'active' },
      { sort: { confidence: 1, lastUsedAt: 1 } }
    );
    if (weakest) {
      await db.learnings.updateOne(
        { _id: weakest._id },
        { $set: { status: 'archived' } }
      );
    }
  }
}
```

This prevents:
- Duplicate learnings piling up (NOOP/UPDATE catch them)
- Contradictory learnings coexisting (DELETE supersedes)
- Unbounded growth (limits per scope, weakest archived)
- Stale learnings persisting after conditions change (supersede + consolidation)

---

## 5. Injection: How Learnings Are Used

### 5.1 Two-Phase Retrieval

```
Phase 1: Scope filter (fast, MongoDB query)
  → Match: global + workflow name + context tags subset + role name + node pattern
  → Filter: status = 'active', confidence >= 0.3
  → Result: ~10-50 candidates

Phase 2: Relevance ranking (in-memory sort)
  → Score = scope_specificity × 0.3
           + confidence × 0.3
           + recency_factor(lastConfirmedAt OR createdAt) × 0.2
           + novelty_factor(usageCount) × 0.2
  → Filter by token budget (550 tokens max)
  → Result: top-K learnings within budget
```

**Ranking factors explained:**

| Factor | Weight | Calculation | Why |
|--------|--------|-------------|-----|
| Scope specificity | 0.3 | context=1.0, workflow=0.8, role=0.6, node_pattern=0.7, global=0.4 | Specific learnings more relevant than generic |
| Confidence | 0.3 | Raw confidence value (0-1) | Higher confidence = more trustworthy |
| Recency | 0.2 | `1 / (1 + daysSince(lastConfirmedAt OR createdAt) / 30)` — decays over 30 days | Recent learnings more likely still valid |
| Novelty | 0.2 | `1 - min(usageCount / 20, 1)` — decreases with usage | Under-used learnings get a boost (agent may not know them yet) |

### 5.2 Token Budget

Total prompt injection budget is shared between auto-gate context and learnings:

```
Total budget: ~800 tokens
  ├─ Auto-gate context (buildNodeContext): ~250 tokens (fixed)
  ├─ Learnings: ~550 tokens (variable)
  │   ├─ Each learning: ~30-80 tokens (tracked in tokenCount)
  │   └─ Fit as many as budget allows, sorted by relevance
  └─ Buffer: ~50 tokens for headers
```

If a learning is too long (>100 tokens), truncate it. Each learning has `tokenCount` pre-computed on storage.

### 5.3 Injection Format

```
LEARNINGS FROM PREVIOUS EXECUTIONS:
- [fact, repo] PostgreSQL runs on port 5433 locally, not 5432. (confidence: 0.9)
- [mistake, workflow] Don't write placeholder emails when info is missing — use __action: "clarify" instead. (confidence: 0.8)
- [preference, global] Always include source URLs when citing data. (confidence: 0.7)
```

### 5.4 Confirmation After Execution

After a node completes successfully:
- Check which learnings were injected into this node
- If the execution succeeded and the learning was relevant → `confirm(learningId)`
- If the execution failed despite the learning → `contradict(learningId)`

---

## 6. Quality Control

### 6.1 Confidence Lifecycle

```
Created:                    confidence = 0.5
Confirmed by execution:     confidence += 0.1 (cap 0.95)
Contradicted by execution:  contradictions++
                            if contradictions > confirmations → archive
Human approves:             confidence = 0.95
Human rejects:              status = archived immediately
Not confirmed in 30 days:   confidence *= 0.9 (decay)
Below 0.2:                  auto-archived
```

### 6.2 Consolidation Cron (Periodic Cleanup)

Runs daily or weekly. Uses the same similarity method as the current phase (keyword Jaccard in Phase 1-3, embeddings in Phase 6).

```
1. Find learnings with similar content (same findSimilar() used in classifyAndStore)
   → score > 0.85: Merge into single learning, sum confirmations, keep the more recent content

2. Find learnings with confidence < 0.3
   → Archive

3. Find learnings not used in 60 days (lastUsedAt)
   → Reduce confidence by 0.1
   → If already below 0.3 → archive

4. Find superseded chains (A superseded by B superseded by C)
   → Clean up: archive A and B, only keep C as active

5. Enforce growth limits (check all scopes against GROWTH_LIMITS)

6. Stats: total active, archived this cycle, merged this cycle, total per scope
   → Log for monitoring, expose via /api/learnings/stats
```

### 6.3 Temporal Validity

Learnings track `validFrom` (when created). When a learning is superseded:
- Old learning gets `supersededAt` and `supersededBy`
- New learning's `validFrom` is set to now
- For debugging: "What did the agent know on March 15?" → query `validFrom <= March 15 AND (supersededAt IS NULL OR supersededAt > March 15)`

---

## 7. Context Tag Derivation and Flow

### 7.1 Where Tags Are Derived

Tags are derived once at execution start in `engine.ts` → `run()`:

```typescript
// In engine.ts, at the beginning of run():
const contextTags = deriveContextTags(input, workflow, repo);
exec.state.__contextTags = contextTags; // stored in execution state for all nodes to access
```

### 7.2 Derivation Logic

```typescript
function deriveContextTags(input: Record<string, unknown>, workflow: WorkflowDef, repo?: Repo): string[] {
  const tags: string[] = [];

  // From repo metadata (if registered in repo management)
  if (repo) {
    tags.push(`repo:${repo.path}`);
    for (const lang of repo.detected.language) tags.push(`language:${lang}`);
    for (const fw of repo.detected.framework) tags.push(`framework:${fw}`);
    for (const t of repo.tags) tags.push(t); // user-defined repo tags
  }

  // From workflow
  tags.push(`workflow:${workflow.name}`);
  if (workflow.context?.requires?.includes('repo')) tags.push('type:coding');

  // From input — scan known keys
  if (input.repo_path) tags.push(`repo:${input.repo_path}`);
  if (input.platform) tags.push(`platform:${input.platform}`);
  if (input.client) tags.push(`client:${input.client}`);
  if (input.industry) tags.push(`industry:${input.industry}`);

  return [...new Set(tags)]; // deduplicate
}
```

### 7.3 How Tags Flow Through Execution

```
engine.run(workflow, input)
  → deriveContextTags() → stored in exec.state.__contextTags
  │
  ├─ executeSingleNode("plan")
  │   ├─ BEFORE: learningManager.query(exec.state.__contextTags, ...) → inject learnings
  │   └─ AFTER:  learningManager.extract(result, exec.state.__contextTags) → scope new learnings
  │
  ├─ executeSingleNode("implement")
  │   ├─ BEFORE: same query with same tags
  │   └─ AFTER:  same extraction with same tags
  │
  └─ execution completes
      └─ Tags stored in execution record for audit/debugging
```

### 7.4 `__learnings` and `__action` Interaction

When an agent returns BOTH `__action` (e.g., "stop") AND `__learnings`, the learnings are extracted FIRST, then the gate action is processed. The learning about WHY the workflow stopped is valuable.

```
Agent returns: { plan: null, __action: "stop", __reason: "Health route exists", 
                 __learnings: [{ content: "Health route at GET /api/health", type: "fact" }] }

→ Step 1: Extract __learnings → store "Health route at GET /api/health" as fact
→ Step 2: Process __action: "stop" → stop workflow
```

Both happen. Learnings are never lost due to gate actions.

---

## 8. Implementation Phases

### Phase 1: Infrastructure + Extraction (No Extra LLM Calls)

| Task | Where | Description |
|------|-------|-------------|
| MongoDB collection | `server/database/indexes.ts` | `learnings` collection with indexes on scope, tags, status, confidence |
| Learning schema + types | `engine/src/types.ts` | `Learning`, `LearningType` interfaces |
| Learning manager | `engine/src/learning-manager.ts` | Core service: `extract()`, `store()`, `query()`, `confirm()`, `contradict()` |
| Mem0 classification | `engine/src/learning-manager.ts` | ADD/UPDATE/DELETE/NOOP before storage |
| Retry delta extraction | `engine/src/engine.ts` | After retry success, extract delta between failed and succeeded attempts |
| Auto-gate extraction | `engine/src/engine.ts` | Store stop/clarify reasons as learnings |
| Human correction extraction | `engine/src/engine.ts` | Store clarify Q+A pairs as learnings |
| Context tag derivation | `engine/src/learning-manager.ts` | Derive tags from repo, workflow, input |

### Phase 2: Quality Control

| Task | Where | Description |
|------|-------|-------------|
| Similarity detection | `engine/src/learning-manager.ts` | Text similarity for Mem0 classification (start with simple Jaccard/cosine on keywords, upgrade to embeddings later) |
| Confirmation logic | `engine/src/engine.ts` | After successful node execution, confirm injected learnings |
| Contradiction detection | `engine/src/engine.ts` | After failed execution, contradict injected learnings |
| Token counting | `engine/src/learning-manager.ts` | Estimate tokens per learning on storage |
| Deduplication | `engine/src/learning-manager.ts` | Part of Mem0 classification |

### Phase 3: Injection

| Task | Where | Description |
|------|-------|-------------|
| Pre-node query | `engine/src/engine.ts` | Before each agent node, query matching learnings |
| Token-budgeted injection | `engine/src/node-executor.ts` | Append learnings within 550-token budget |
| Relevance ranking | `engine/src/learning-manager.ts` | Score = confidence × recency × usage_frequency |
| Injection tracking | `engine/src/learning-manager.ts` | Record which learnings were injected (for confirmation) |

### Phase 4: Explicit + Post-Execution Extraction

| Task | Where | Description |
|------|-------|-------------|
| `__learnings` in output | `engine/src/output-extractor.ts` | Add to GATE_FIELDS, extract from agent responses |
| Post-execution review | `engine/src/engine.ts` | Optional cheap LLM call on executions with retries/failures. Haiku/mini model. |
| Review trigger logic | `engine/src/engine.ts` | Only on executions with retries/failures/gate-events, duration > 30s |

### Phase 5: API + UI

| Task | Where | Description |
|------|-------|-------------|
| CRUD API | `server/routes/learning.routes.ts` | GET (list + filter), POST (manual add), PUT (edit), DELETE (archive) |
| Query API | `server/routes/learning.routes.ts` | GET `/api/learnings?scope=repo&tags=repo:/path&type=fact&status=active` |
| Execution link API | `server/routes/learning.routes.ts` | GET `/api/executions/:id/learnings` — injected + extracted |
| Learnings UI page | `ui/src/pages/LearningsPage.tsx` | List, filter by scope/type/tags, approve/reject, edit, view source execution |
| Execution detail link | `ui/src/pages/ExecutionDetailPage.tsx` | Show which learnings were injected into each node, which were extracted |
| Consolidation cron | `server/` or `engine/` | Daily job: merge duplicates, decay stale, archive low-confidence |

### Phase 6: Advanced (Future)

| Task | Description |
|------|-------------|
| Embedding-based retrieval | MongoDB Atlas vector search or in-memory HNSW for semantic matching |
| Skill library (Voyager pattern) | Store reusable code/command patterns as executable skills |
| Cross-context transfer | Learnings from one TypeScript repo may apply to another |
| Learning analytics | Dashboard: which learnings save most time/money, most used, most contradicted |
| Auto-consolidation LLM | Periodically summarize verbose learnings into concise ones |

---

## 9. Architecture Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                      Execution Flow                           │
│                                                              │
│  Execution starts                                             │
│    └─ Derive context tags from repo + workflow + input        │
│                                                              │
│  For each agent node:                                         │
│    ┌─ BEFORE execution ──────────────────────────────┐       │
│    │  Query learnings (scope filter + relevance rank) │       │
│    │  Budget: fit within 550 tokens                   │       │
│    │  Inject into prompt as "LEARNINGS FROM..."       │       │
│    │  Track which learnings were injected              │       │
│    └──────────────────────────────────────────────────┘       │
│    │                                                          │
│    │  Execute agent (Claude or Codex)                         │
│    │                                                          │
│    ┌─ AFTER execution ───────────────────────────────┐       │
│    │  Extract __learnings from output (explicit)      │       │
│    │  If retry: extract delta (implicit)              │       │
│    │  If auto-gate: extract reason (implicit)         │       │
│    │  If human clarify: extract Q+A (implicit)        │       │
│    │  Classify via Mem0: ADD/UPDATE/DELETE/NOOP       │       │
│    │  Store new learnings                             │       │
│    │  Confirm/contradict injected learnings            │       │
│    └──────────────────────────────────────────────────┘       │
│                                                              │
│  Execution completes                                          │
│    └─ Optional: post-execution review (cheap LLM)             │
│       Only if: retries > 0 OR failures > 0 OR gate events    │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                    Learning Manager                            │
│                                                              │
│  extract(node, result, executionContext) → Learning[]          │
│  classifyAndStore(learning) → ADD/UPDATE/DELETE/NOOP          │
│  query(scope, contextTags, tokenBudget) → Learning[]          │
│  confirm(learningId, executionId)                             │
│  contradict(learningId, executionId, reason)                  │
│  consolidate() — cron: merge, decay, archive                  │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                      MongoDB                                   │
│                                                              │
│  learnings {                                                  │
│    content, type, tags,                                       │
│    scope: { level, contextTags, workflowName, roleName },     │
│    confidence, confirmations, contradictions,                  │
│    usageCount, lastUsedAt, tokenCount,                        │
│    validFrom, supersededBy, supersededAt,                      │
│    source: { executionId, nodeName, sourceType },             │
│    status, createdAt, updatedAt                               │
│  }                                                            │
│                                                              │
│  Indexes:                                                     │
│    { 'scope.level': 1, status: 1, confidence: -1 }           │
│    { 'scope.contextTags': 1 }                                │
│    { 'scope.workflowName': 1 }                               │
│    { 'scope.roleName': 1 }                                   │
│    { tags: 1 }                                                │
│    { status: 1, lastUsedAt: 1 }  — for consolidation         │
│    { 'source.executionId': 1 }   — for execution links       │
└──────────────────────────────────────────────────────────────┘
```

---

## 10. What Makes Allen's Approach Unique

| Feature | Industry Standard | Allen |
|---------|------------------|-----------|
| **Scope granularity** | 1-2 levels (global, task) | 5 levels with generic context tags — works for coding, marketing, sales, any domain |
| **Mem0 classification** | Most just append | ADD/UPDATE/DELETE/NOOP before storage — prevents duplicates and contradictions |
| **Auto-gate as learning source** | No one does this | Stop/clarify signals auto-captured as learnings |
| **Retry delta extraction** | Reflexion does text reflection | Structured: what failed, what fixed it, which scope |
| **Multi-provider learning** | Single-model systems | Learnings from Claude help Codex and vice versa |
| **Human correction capture** | Most don't track | Clarify Q+A pairs become learnings automatically |
| **Token-budgeted injection** | Most use count limits | Fits within 550-token budget, not arbitrary "top 10" |
| **Temporal metadata** | Only Zep has this | validFrom/supersededAt enables "what did it know when?" debugging |
| **Zero extra LLM calls** (Phase 1-3) | Many require embedding calls | Implicit extraction + keyword similarity for Phase 1-3. Embeddings optional in Phase 6 |
| **Domain agnostic** | Most are coding-only | Context tags work for any domain — repos, clients, platforms, products |

---

## 11. Examples Across Domains

### Coding
```
Execution: Fix pricing bug in es-data-pipeline
Context tags: [repo:/Users/shree/es-data-pipeline, language:typescript, framework:express, module:src/pricing-update]

Extracted: "pricing-update uses chunked-two-phase architecture with 2-min query timeout" (fact, context)
Injected next time: When any task mentions pricing-update in this repo
```

### Marketing
```
Execution: Write LinkedIn post about AI agents
Context tags: [platform:linkedin, content-type:post, topic:ai-agents]

Extracted: "LinkedIn posts perform best at 500-800 words with a question at the end" (pattern, context)
Injected next time: When any LinkedIn post workflow runs
```

### Sales
```
Execution: Draft proposal for Acme Corp
Context tags: [client:acme-corp, deal-stage:proposal, industry:manufacturing]

Extracted: "Acme Corp requires ISO 9001 compliance mention in all proposals" (fact, context)
Injected next time: When any workflow runs with client:acme-corp tag
```

### Cross-Domain (Global)
```
Extracted: "When using clarify, return __clarify_fields with structured form instead of free text question" (optimization, global)
Injected: Every execution, every workflow, every domain
```
