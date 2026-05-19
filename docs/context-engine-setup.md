# Context Engine Setup

Allen context flows are disabled unless `ALLEN_CONTEXT_PROVIDER` is set. This single variable controls context generation, retrieval, reranking, Cognee ingestion, and context UI actions.

Use one of these values:

| Value | Behavior |
|---|---|
| `allen` | Uses Allen's built-in repository context provider. This is the default production-safe option when you do not want Cognee. |
| `cognee` or `cognee_memory` | Uses Cognee for repo memory ingestion, cognification, and recall. |
| unset, `none`, `off`, `disabled` | Disables all context-engine flows. |

`graph` is accepted as a legacy alias for `allen`, but new environments should use `allen`.

## Python Interpreter

Allen runs Python sidecars through `ALLEN_PYTHON`. Use a dedicated virtual environment so Cognee, model caches, and reranker packages do not depend on the system Python.

```bash
python3 -m venv "$HOME/.allen/python/context-eval"
"$HOME/.allen/python/context-eval/bin/python" -m pip install --upgrade pip setuptools wheel
```

Set the interpreter in `.env`:

```bash
ALLEN_PYTHON=$HOME/.allen/python/context-eval/bin/python
```

Cognee currently supports Python 3.10 through 3.14. If model or database packages fail to install, first confirm the interpreter:

```bash
"$ALLEN_PYTHON" --version
```

## Allen Provider

Use this when you want Allen's built-in repository context provider without Cognee storage:

```bash
ALLEN_CONTEXT_PROVIDER=allen
```

No Cognee database is required. Python is only needed if you enable a semantic reranker:

```bash
ALLEN_CONTEXT_RERANKER=bge
ALLEN_CONTEXT_RERANKER_MODEL=BAAI/bge-reranker-base
```

Install and warm the default reranker model:

```bash
"$HOME/.allen/python/context-eval/bin/python" -m pip install sentence-transformers
"$HOME/.allen/python/context-eval/bin/python" -c "from sentence_transformers import CrossEncoder; m=CrossEncoder('BAAI/bge-reranker-base'); print(m.predict([('query','document')]))"
```

Leave `ALLEN_CONTEXT_RERANKER` unset to use deterministic ranking only.

## Cognee Provider

Use Cognee when repo Markdown should be ingested into Cognee memory and recalled through semantic or graph-backed search:

```bash
ALLEN_CONTEXT_PROVIDER=cognee
ALLEN_PYTHON=$HOME/.allen/python/context-eval/bin/python
ALLEN_COGNEE_DATA_DIR=$HOME/.allen/cognee
ALLEN_COGNEE_EMBEDDING_PROVIDER=local
ALLEN_COGNEE_EMBEDDING_MODEL=BAAI/bge-small-en-v1.5
ALLEN_COGNEE_LLM_PROVIDER=allen_codex
ALLEN_COGNEE_LLM_MODEL=gpt-5.5
```

Install Cognee and the local embedding stack:

```bash
"$HOME/.allen/python/context-eval/bin/python" -m pip install "cognee[fastembed]" fastembed
```

Warm the default embedding model:

```bash
"$HOME/.allen/python/context-eval/bin/python" -c "from fastembed import TextEmbedding; list(TextEmbedding(model_name='BAAI/bge-small-en-v1.5').embed(['warmup'])); print('ok')"
```

With local defaults, Cognee stores relational metadata, vector data, and graph data under `ALLEN_COGNEE_DATA_DIR`. This is suitable for local development and single-user testing.

## Cognee With Postgres, pgvector, And Neo4j

For production or shared environments, point Cognee at external stores. These variables are consumed by Cognee inside the Allen Python sidecar:

```bash
ALLEN_CONTEXT_PROVIDER=cognee
ALLEN_PYTHON=$HOME/.allen/python/context-eval/bin/python
ALLEN_COGNEE_DATA_DIR=$HOME/.allen/cognee

DB_PROVIDER=postgres
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=allen_cognee
DB_USERNAME=allen_cognee_user
DB_PASSWORD=<set-in-local-env>

VECTOR_DB_PROVIDER=pgvector

GRAPH_DATABASE_PROVIDER=neo4j
GRAPH_DATABASE_URL=bolt://127.0.0.1:7687
GRAPH_DATABASE_NAME=neo4j
GRAPH_DATABASE_USERNAME=neo4j
GRAPH_DATABASE_PASSWORD=<set-in-local-env>

ENABLE_BACKEND_ACCESS_CONTROL=false
REQUIRE_AUTHENTICATION=false
```

Install the database extras:

```bash
"$HOME/.allen/python/context-eval/bin/python" -m pip install "cognee[postgres-binary,neo4j,fastembed]" fastembed
```

Cognee's pgvector provider uses the same Postgres connection as `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USERNAME`, and `DB_PASSWORD`. The same database and user can be used for relational metadata and vector tables if the user has normal table privileges and the `vector` extension already exists in that database.

For RDS or other managed Postgres, create the extension once in the exact target database as an admin or `rds_superuser`:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

This is database-scoped. In DBeaver, connect to `DB_NAME` before running it; running the statement in a different database does not enable pgvector for `allen_cognee`.

## What Cognee Ingestion Stores

Allen sends git-tracked Markdown files to Cognee with stable metadata:

| Field | Purpose |
|---|---|
| `label` | Repo-relative path used as the portable document identifier. |
| `external_metadata.path` | Repo-relative path used by Allen to map results back to the repository. |
| `external_metadata.fileHash` | Content hash used to skip unchanged files on rebuild. |
| Raw/original file locations | Cognee-managed storage paths. They may be absolute and should not be used by Allen for production portability. |

During rebuild, Allen asks the sidecar to compare the current Markdown list with Cognee's own metadata. Unchanged `path + fileHash` records are skipped, changed records are re-added, deleted records are forgotten when Cognee supports it, and cognify retries include changed or previously uncognified records.

## Inspecting Cognee Data

For Postgres relational metadata, start with:

```sql
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY table_schema, table_name;
```

To find vector columns after pgvector tables exist:

```sql
SELECT table_schema, table_name, column_name, udt_name
FROM information_schema.columns
WHERE udt_name = 'vector'
ORDER BY table_schema, table_name;
```

If this returns no rows, confirm that:

- You are connected to the same `DB_NAME` used by Cognee.
- The sidecar reached the embedding/vector table creation step.
- `CREATE EXTENSION IF NOT EXISTS vector;` succeeded in that database.
- You are inspecting the schema where Cognee created tables.

In Neo4j, inspect nodes and relationships with:

```cypher
MATCH (n) RETURN labels(n), count(*) ORDER BY count(*) DESC;
MATCH ()-[r]->() RETURN type(r), count(*) ORDER BY count(*) DESC;
```

## Verification

After starting Allen, verify runtime config:

```bash
curl http://localhost:4000/api/system/runtime-config
```

Expected examples:

```json
{"contextEngine":{"enabled":true,"provider":"allen","cogneeEnabled":false}}
```

```json
{"contextEngine":{"enabled":true,"provider":"cognee","cogneeEnabled":true}}
```

For Cognee builds, the repo UI and diagnostics should show collection, database diff, ingestion, and cognification progress. The database diff runs before `cognee.add()` calls so unchanged files can be skipped.

## References

- Cognee installation: <https://docs.cognee.ai/getting-started/installation>
- Cognee relational databases: <https://docs.cognee.ai/setup-configuration/relational-databases>
- Cognee vector stores: <https://docs.cognee.ai/setup-configuration/vector-stores>
- Cognee graph stores: <https://docs.cognee.ai/setup-configuration/graph-stores>
