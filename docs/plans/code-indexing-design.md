# Code Indexing + Code Graph — Design

**Status:** design, not implemented
**Goal:** give agents semantic code search + structural code navigation so they spend ~5-10× fewer tokens per "understand this codebase" task.
**Date:** 2026-04-20

---

## 1. The problem

Today, when a workflow agent needs to understand code, it uses the `filesystem` MCP: `Read` a whole file (often 1500–4000 lines), `Grep` for a keyword, `Glob` for filenames. This burns tokens two ways:

- **Bulk reads**: a 3000-line file is ~9000 tokens just to find the 20 relevant lines.
- **No structural awareness**: to understand "who calls `validateUser`", the agent has to Grep, then Read each hit, then Read the caller's context. Easily 30-50k tokens for a simple reference walk.

Existing mitigations:
- `repo-context-scanner` produces one markdown context blob per repo and injects it in every agent prompt. Useful for high-level orientation, but it's static — a 15KB markdown doc that can't answer "show me the functions that touch `pull_requests.workspaceId`".

We need two new capabilities that compose:

1. **Semantic code index** — embed every code chunk (function / class / block) and support vector search.
2. **Code graph** — symbols, definitions, references, imports, and call relationships.

Agents access both through MCP tools.

---

## 2. Stack — chosen components

| Concern | Choice | Why |
|---|---|---|
| **Parser** | **tree-sitter** (Node bindings) | Universal, battle-tested, 100+ language grammars, incremental reparse, returns concrete syntax trees. Allen is Node-only — tree-sitter's Node bindings are stable. |
| **Chunker** | Tree-sitter query-based + sliding-window fallback | AST-aware chunks (function / class / top-level block). For unsupported langs or oversized nodes, slide 300-line windows. |
| **Embedder** | `Xenova/jina-embeddings-v2-base-code` via transformers.js | Local, no API key, trained on code. 768-dim. Swappable via existing `EmbeddingProvider` interface. Falls back to current MiniLM if model load fails. |
| **Vector store** | MongoDB `$vectorSearch` (DocumentDB 5.0+ supports it natively) | Zero new infra — reuses the DocDB cluster Allen already runs. Atlas-compatible so local dev works too. |
| **Symbol / graph store** | MongoDB (new collections: `code_symbols`, `code_references`, `code_chunks`) | Same reason. Graph queries via `$graphLookup`. |
| **Language-aware graph (Phase 4)** | SCIP indexers per language (`scip-typescript`, `scip-python`, `scip-go`) | Opt-in. Produces type-aware cross-file symbol resolution. Stored as `code_symbols` with an extra `scip_symbol` field. Not required for the first 3 phases. |

### Considered and rejected

- **pgvector + Postgres** — would mean adding a Postgres service alongside DocDB. Not worth the operational overhead when DocDB 5.0 has `$vectorSearch`.
- **Qdrant / LanceDB** — nice products, but adding a vector DB for a single feature doubles operational surface.
- **OpenAI embeddings (`text-embedding-3-small`)** — would introduce per-token cost on every reindex. Local code-aware models are now good enough (Jina, BGE-small-code) and free.
- **LSP servers per language** — heavyweight, stateful, per-language processes. SCIP gives the same graph data as a static batch job.
- **Semgrep / ast-grep** — good for pattern search, not a full graph.

---

## 3. Architecture overview

```
┌────────────────────────────────────────────────────────────┐
│  Ingest pipeline (new system action: repo-index-if-changed)│
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 1. git diff vs. last_indexed_sha → changed files     │  │
│  │ 2. tree-sitter parse each changed file               │  │
│  │ 3. chunk (function / class / block boundaries)       │  │
│  │ 4. embed each chunk (batched)                        │  │
│  │ 5. extract symbols + references via ts queries       │  │
│  │ 6. upsert to code_chunks, code_symbols, code_refs    │  │
│  │ 7. update repo.lastIndexedSha                        │  │
│  └──────────────────────────────────────────────────────┘  │
└───────────────────────┬────────────────────────────────────┘
                        │
         ┌──────────────┴───────────────┐
         │    MongoDB (existing DocDB)  │
         │  ┌─────────────────────────┐ │
         │  │ code_chunks              │ │   ← vector-indexed
         │  │ code_symbols             │ │   ← B-tree + text indexes
         │  │ code_references          │ │   ← compound (from_symbol, to_symbol)
         │  │ code_index_meta          │ │   ← last_indexed_sha per repo
         │  └─────────────────────────┘ │
         └──────────────┬───────────────┘
                        │
                        ▼
┌────────────────────────────────────────────────────────────┐
│  Allen MCP server — 8 new tools                            │
│  search_code_semantic • search_code_keyword                │
│  get_file_outline  •  find_definition  •  find_references  │
│  get_call_graph   •  get_imports   •  get_module_graph     │
└───────────────────────┬────────────────────────────────────┘
                        │
                        ▼
                 Any Allen agent
```

---

## 4. Data model

### `code_chunks`
One row per AST-derived code chunk (function, class, or fallback sliding window).

```ts
{
  _id: ObjectId,
  repoId: string,
  file: string,            // relative path from repo root
  lang: string,            // 'typescript' | 'python' | 'go' | 'unknown'
  kind: string,            // 'function' | 'class' | 'method' | 'block' | 'window'
  symbol?: string,         // primary symbol name (e.g. "validateUser")
  signature?: string,      // first-line signature (first ~200 chars)
  code: string,            // the chunk text (capped at 8KB)
  startLine: number,
  endLine: number,
  tokens: number,          // rough count for budgeting
  parentSymbol?: string,   // containing class/module
  imports?: string[],      // module names this chunk depends on
  embedding?: number[],    // 768-dim jina code vector
  headSha: string,         // commit the chunk was indexed at
  updatedAt: Date,
}
```

**Indexes:**
- `{ repoId: 1, file: 1 }`
- `{ repoId: 1, symbol: 1 }`
- `{ embedding: 'vector' }` — DocDB `$vectorSearch` index with `numDimensions: 768, similarity: 'cosine'`

### `code_symbols`
One row per top-level declaration. Used for `find_definition` and outline queries.

```ts
{
  _id: ObjectId,
  repoId: string,
  file: string,
  symbol: string,          // "validateUser" or "MyClass.method"
  kind: string,            // 'function' | 'class' | 'method' | 'const' | 'interface' | 'type'
  startLine: number,
  endLine: number,
  chunkId: ObjectId,       // back-ref into code_chunks
  exported: boolean,
  scipSymbol?: string,     // filled by Phase 4 SCIP indexers
  headSha: string,
}
```

**Indexes:**
- `{ repoId: 1, symbol: 1 }`
- `{ repoId: 1, file: 1, startLine: 1 }`
- `{ scipSymbol: 1 }` (sparse)

### `code_references`
One row per reference / call site. Enables call-graph traversal.

```ts
{
  _id: ObjectId,
  repoId: string,
  file: string,
  fromSymbol: string,      // "MyService.createWorkspace"
  toSymbol: string,        // "db.collection"
  line: number,
  kind: string,            // 'call' | 'import' | 'type-ref' | 'inherit'
  scipSymbol?: string,
  headSha: string,
}
```

**Indexes:**
- `{ repoId: 1, toSymbol: 1 }` — "who calls X" — the hot path
- `{ repoId: 1, fromSymbol: 1 }` — "what does X call"
- `{ repoId: 1, file: 1 }`

### `code_index_meta`
Per-repo state for incremental reindexing.

```ts
{
  _id: ObjectId,
  repoId: string,
  lastIndexedSha: string,
  lastIndexedAt: Date,
  stats: { files: number, chunks: number, symbols: number, refs: number, durationMs: number },
  languageCoverage: Record<string, { files: number, chunks: number }>,
  scipIndexers: string[],   // languages that have SCIP data, Phase 4
}
```

---

## 5. MCP tools exposed to agents

All added to `packages/server/src/services/allen-mcp-server.ts` and routed through new HTTP endpoints.

### 5a. `search_code_semantic`
**Signature:** `{ query: string, repo_id?: string, k?: number, language?: string, file_glob?: string }`
**Returns:** array of `{ file, startLine, endLine, symbol, signature, score, chunk_id }`.
**Implementation:** embed `query` → DocDB `$vectorSearch` against `code_chunks.embedding` → return top-k.
**Agent use case:** *"find the code that validates user email addresses"* → 3 chunks × ~200 tokens = 600 tokens vs. reading 5 files for 15000+ tokens.

### 5b. `search_code_keyword`
**Signature:** `{ pattern: string, repo_id?: string, file_glob?: string, max_matches?: number }`
**Returns:** array of `{ file, line, match, chunk_id }`.
**Implementation:** MongoDB `$text` search on `code_chunks.code` OR server-side ripgrep in `repo.path`. The ripgrep path is faster for exact regex; $text for fuzzy word match.

### 5c. `get_file_outline`
**Signature:** `{ file_path: string }`
**Returns:** tree of symbols with kind + line numbers.
```
[
  { symbol: "createWorkspace", kind: "method", startLine: 183, endLine: 222, parent: "WorkspaceManager" },
  ...
]
```
**Implementation:** query `code_symbols` where `file = file_path`, sort by startLine, nest by parentSymbol.
**Agent use case:** replaces the common `Read entire file just to see what's in it` pattern.

### 5d. `find_definition`
**Signature:** `{ symbol: string, scope?: string, repo_id?: string }`
**Returns:** `{ file, startLine, endLine, signature, chunk_id } | null`
**Implementation:** query `code_symbols` where `symbol = ? AND repoId = ?`. If multiple matches, return the exported one first, then prefer the one in the scope's directory.

### 5e. `find_references`
**Signature:** `{ symbol: string, repo_id?: string, max?: number }`
**Returns:** array of `{ file, line, fromSymbol, kind, chunk_id }`
**Implementation:** query `code_references` where `toSymbol = ?`.
**Agent use case:** "before I rename `validateUser`, show me every caller" — 1 query vs. grep + 20 reads.

### 5f. `get_call_graph`
**Signature:** `{ symbol: string, depth?: number, direction?: 'callers' | 'callees' | 'both' }`
**Returns:** nested `{ symbol, kind, file, edges: [...] }` graph up to `depth`.
**Implementation:** MongoDB `$graphLookup` on `code_references`.

### 5g. `get_imports`
**Signature:** `{ file_path: string }`
**Returns:** `{ imports: [{ from: "…", symbols: ["…"], isLocal: bool }] }`.
**Implementation:** Pre-extracted `imports[]` field on `code_chunks`; union the imports of all chunks in the file.

### 5h. `get_module_graph`
**Signature:** `{ repo_id: string, depth?: number, root_dir?: string }`
**Returns:** directory-level dependency graph — "which folder imports which folder".
**Implementation:** aggregate `code_references` with `kind = 'import'` → group `from_file_dir → to_file_dir`. Good for onboarding + arch overviews.

### Token-budget example

Task: *"Refactor `validateUser` to return a Result type instead of throwing."*

| Step | Without index | With index |
|---|---|---|
| Find the function | `Glob **/user.ts` + `Read` (3 files) ≈ 8000 tok | `find_definition("validateUser")` → 1 chunk, 200 tok |
| Find all callers | `Grep validateUser` + Read each caller file ≈ 12000 tok | `find_references("validateUser")` → list of 18 sites, 400 tok |
| Understand context | Read whole service module ≈ 6000 tok | `get_file_outline` + `get_chunk(parent)` ≈ 500 tok |
| **Total input tokens** | **~26000** | **~1100** |

Roughly **20×** reduction on this kind of task. Real workflows vary — editing still needs full file context for the edit step, so end-to-end savings are more like **5–8×**.

---

## 6. Ingest pipeline

New service: `packages/server/src/services/code-indexer.service.ts`

New system action: **`repo-index-if-changed`** (companion to the existing `repo-scan-if-changed` cron).

```
For each repo where repo.status = 'active':
  1. head_sha = git rev-parse HEAD in repo.path
  2. if head_sha == meta.lastIndexedSha: skip
  3. changed_files = git diff --name-only <lastIndexedSha>..<head_sha>
     (if no prior index: everything)
  4. for each changed_file:
     a. detect language
     b. skip if unsupported or binary or > 1MB
     c. tree-sitter parse → chunks[]
     d. extract symbols + references via ts queries
     e. embed chunk.code batched (batch size 32)
     f. upsert chunks, symbols, references (by _id or compound key)
  5. delete rows whose file no longer exists
  6. update code_index_meta.lastIndexedSha + stats
```

**Triggered by:**
- Cron: every 30 min (seeded via `cron-seed.service.ts`, pairs with `repo-pull-30min`)
- Manual: `POST /api/repos/:id/reindex` (new endpoint)
- Implicit: after `POST /api/repos/clone` completes — fire-and-forget first-time index

**Incremental:** only changed files are re-parsed/re-embedded. A 1000-file repo with 3 changed files = 3 file-worth of work, not 1000.

**Graceful degradation:**
- Tree-sitter fails → fall back to sliding-window chunks with `kind = 'window'`
- Unsupported language → index with sliding window, no symbols / refs (search still works)
- Model load fails → skip embeddings this cycle, log, retry next cycle

---

## 7. Tree-sitter query library

Allen maintains a small set of queries per supported language, stored in `packages/engine/src/code-index/queries/`.

- `typescript.scm` — functions, classes, methods, imports, call expressions, type references
- `python.scm` — def, class, import, call
- `go.scm` — func, type, import, call
- `javascript.scm` — shares TS queries
- `java.scm` — Phase 3 stretch
- `rust.scm` — Phase 3 stretch

Each query file is small (~50 lines). Example from `typescript.scm` (illustrative):

```scheme
(function_declaration
  name: (identifier) @symbol.function
  body: (_) @body) @chunk

(class_declaration
  name: (type_identifier) @symbol.class) @chunk

(call_expression
  function: (identifier) @ref.call)
```

---

## 8. Phased delivery

| Phase | Scope | Duration | Value delivered |
|---|---|---|---|
| **1** | Parser + chunker + embed + `search_code_semantic` + `get_file_outline` | 1.5 wk | Semantic code search; token savings start here. |
| **2** | Symbol table + `find_definition` + `find_references` (same-file scope only) | 1 wk | Definition lookup + basic callers list. |
| **3** | Import graph + `get_imports` + `get_module_graph` + `get_call_graph` (depth 2) | 1 wk | Structural navigation; onboarding view. |
| **4** | SCIP indexers per language (opt-in); cross-file type-aware symbols; scoped references | 1.5 wk | Precise cross-file resolution for TS/Python/Go. |
| **5** | Incremental reindex on git pull webhook + UI inspector page | 1 wk | Operator visibility; fresh index without manual trigger. |

**Total:** ~6 weeks of focused work. Phases 1–3 alone (3.5 weeks) give agents most of the win.

---

## 9. UI surface (Phase 5)

New page `/repos/:id/index` with three tabs:

1. **Overview** — total chunks / symbols / refs / languages + last-indexed SHA + "Reindex now" button
2. **Semantic search** — input box → calls `search_code_semantic` → results with file:line click-through to the file viewer
3. **Graph** — ReactFlow diagram: module-level dependency graph (`get_module_graph` output), clickable nodes open the file

UI is a debugging aid, not the main value prop. Agents are the primary consumer.

---

## 10. Risks + open questions

1. **Tree-sitter Node bindings on ARM Macs + Linux servers.** Mitigation: use `web-tree-sitter` (WASM) — slower (~2-3x) but works everywhere without native deps. Benchmark in Phase 1 before committing.

2. **DocDB `$vectorSearch` limits.** AWS DocDB 5.0 supports it, but with shard size + dimension caps (1536 max, we're using 768 → fine). Fallback: use a separate Qdrant instance if perf is insufficient.

3. **Embedding drift.** Swapping the embedding model invalidates all stored vectors. Mitigation: version the model name on `code_chunks.embedding_model`; re-embed lazily as new queries hit old rows.

4. **Supply-chain risk of tree-sitter grammars.** Each `tree-sitter-<lang>` is a community package. Pin versions, audit licenses. Stick with the ~5 common grammars.

5. **Large monorepos.** A 10k-file repo is ~30k chunks ≈ 30MB of vectors in Mongo. Fine. A 500k-file monorepo is a different conversation — add a per-repo max-file cap (skip if > N, log warning).

6. **Privacy in SaaS mode.** Today Allen is self-host; code stays on your infra. If there's ever a hosted tier, the embedding + storage happens in the operator's infra too — need isolation per tenant.

---

## 11. Interactions with other systems

- **Learnings** — a new learning source: `code_index`. When an agent discovers "this pattern is used in N places", that becomes a learning with `contextTags: ['repo:<name>']`.
- **Memory blocks** (planned) — a `repo` memory block can be pre-populated from the index stats (summary of architecture) and kept in sync via the reindex cron.
- **Skill library** (planned) — skills that want to "find the right file to edit" call `search_code_semantic` as their first step.
- **CodeRabbit resolution workflow** — the resolver agent currently re-reads files. With the index, it can call `find_definition` on the symbol CodeRabbit flagged and jump straight to the right chunk.

---

## 12. Concrete next steps

1. Prototype the chunker in an isolated script: `scripts/code-index-prototype.ts` — parse `packages/server/src/services/*.ts`, emit chunks, embed, run a search. Target: 1 day.
2. Measure: chunks per file, embed speed on CPU, query latency for 1000-chunk corpus. Accept if p95 < 200ms per query.
3. If metrics are green, commit the data model + Phase 1 service. Ship behind a feature flag (`ALLEN_CODE_INDEX_ENABLED=1`) for internal dogfooding first.
4. Once Phase 1 is running on real repos, promote to default-on.

**Decision point after Phase 1:** if agents adopt the new MCP tools and token use drops measurably, continue to Phase 2. If not, stop and dig into why.

---

## 13. Appendix — what Allen already has that composes with this

- `repo-context-scanner` — stays. Runs the high-level markdown context generation. The new index complements it: the scanner answers "what kind of repo is this", the index answers "show me the function that does X".
- `EmbeddingProvider` abstraction in `packages/engine/src/embedding.ts` — swap MiniLM for Jina code inside this one file; no caller changes.
- `cosineSimilarity` helper — reused for learnings already; same shape works for code.
- Cron + system-action pattern — `repo-pull-30min`, `coderabbit-sweep-15min` already exist. The new `repo-index-if-changed-30min` follows the same shape in `cron-seed.service.ts`.
- MCP tool registration pattern — already have 21 tools in `allen-mcp-server.ts`. Adding 8 more is mechanical.

Net new infrastructure: **zero.** This is a new service + new collections + new MCP tools on top of infrastructure that already runs.
