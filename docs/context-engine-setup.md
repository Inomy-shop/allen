# Context Engine Setup

Allen's context engine is Cognee-backed by default. It uses curated repo context as the source material for semantic recall and graph building, then uses Allen-owned mandatory mappings, reranking, injection, diagnostics, and usage tracking at runtime.

For manual Python/database setup details, see [Context engine installation](context-engine-installation.md). For field-level context concepts, see [Curated and mandatory context](context-engine-curated-and-mandatory-context.md).

## 1. Install The Context Engine

Run the setup script from the repo root:

```bash
npm run setup:context
```

This runs `scripts/setup-context-engine.sh`, which idempotently:

- creates `~/.allen/python/context-eval`;
- installs Cognee with the local embedding stack;
- installs `fastembed` and the default BGE embedding model;
- installs `sentence-transformers` and the default BGE reranker;
- warms `BAAI/bge-small-en-v1.5` and `BAAI/bge-reranker-base`;
- creates `.env` from `.env.example` when needed;
- adds missing context defaults without overwriting existing `.env` values.

The default provider written by the script is:

```bash
ALLEN_CONTEXT_PROVIDER=cognee
```

Optional setup modes:

```bash
# Install Postgres/pgvector and Neo4j extras, then print DB setup reminders.
npm run setup:context -- --external-db

# Skip semantic reranker setup and use deterministic ranking only.
npm run setup:context -- --without-reranker

# Use a specific Python executable.
npm run setup:context -- --python /path/to/python3

# Install packages but skip model downloads during setup.
npm run setup:context -- --skip-warmup
```

## 2. Start Allen

Ensure Codex is authenticated, then start Allen normally:

```bash
codex
npm start
```

Verify the runtime config:

```bash
curl http://localhost:4000/api/system/runtime-config
```

Expected context state:

```json
{"contextEngine":{"enabled":true,"provider":"cognee","cogneeEnabled":true}}
```

## 3. Prepare A Repo

Register or open the repo in Allen. The context engine does not ingest raw repo Markdown directly. First generate Allen-curated context and mandatory mappings for the repo.

Run these agents against the registered repo path:

1. `repo-context-curator`
2. `repo-mandatory-context-mapper`

`repo-context-curator` creates or updates active curation entries in `repo_context_curation_entries`. It is idempotent: unchanged files are reused, and new/changed/retry files are curated.

`repo-mandatory-context-mapper` creates role-specific always-load mappings in `repo_mandatory_context_mappings`. These mappings are separate from curated entries and are injected directly for matching Allen agents.

## 4. Build Context From The UI

Open the repo card and go to **Context Management**.

In the **Context Graph** section:

- click **Refresh Context** to ingest active curated entries and update Cognee;
- click **Clean Build Context** when you want a clean rebuild of the Cognee dataset for that repo.

The build reads active entries from `repo_context_curation_entries`, sends their retrieval text/chunks to Cognee, runs Cognee ingestion/cognification, and creates chunk-source mappings so Cognee search results can resolve back to the curated entry.

While the build runs, the UI should show collection, database diff, ingestion, cognification, chunk mapping, and completion status. After completion, the Context Graph and Playground can be used to inspect what Cognee recalls and what Allen injects.

## 5. Runtime Behavior

At workflow or spawned-agent runtime:

- mandatory context mappings are loaded first for the exact Allen agent role;
- Cognee recalls optional task-specific context from active curated entries;
- Allen filters, reranks, and packs selected refs;
- resolved curated context is injected when policy and score thresholds allow it;
- usage traces record what was injected, loaded, applied, or skipped.

Relevant thresholds:

```bash
ALLEN_COGNEE_MIN_SELECTION_SCORE=0.45
ALLEN_CONTEXT_MIN_RERANK_SCORE=0.45
ALLEN_COGNEE_MIN_INJECTION_SCORE=0.60
```

Tune these only after checking Context Management diagnostics. Mandatory context is not filtered by optional Cognee relevance thresholds.

## References

- Cognee installation: <https://docs.cognee.ai/getting-started/installation>
- Cognee relational databases: <https://docs.cognee.ai/setup-configuration/relational-databases>
- Cognee vector stores: <https://docs.cognee.ai/setup-configuration/vector-stores>
- Cognee graph stores: <https://docs.cognee.ai/setup-configuration/graph-stores>
