# Context Engine Installation

This document covers manual installation and database configuration for Allen's Cognee-backed context engine. For the normal setup flow, start with [Context engine setup](context-engine-setup.md).

## Python Environment

Allen runs context sidecars through `ALLEN_PYTHON`. Use a dedicated virtual environment so Cognee, model caches, and reranker packages do not depend on the system Python.

```bash
python3 -m venv "$HOME/.allen/python/context-eval"
"$HOME/.allen/python/context-eval/bin/python" -m pip install --upgrade pip setuptools wheel
```

Set the interpreter in `.env`:

```bash
ALLEN_PYTHON=$HOME/.allen/python/context-eval/bin/python
```

Cognee supports modern Python 3 releases. If model or database packages fail to install, first confirm the interpreter:

```bash
"$ALLEN_PYTHON" --version
```

## Local Cognee Defaults

The one-command setup writes these defaults when they are missing:

```bash
ALLEN_CONTEXT_PROVIDER=cognee
ALLEN_PYTHON=$HOME/.allen/python/context-eval/bin/python
ALLEN_COGNEE_DATA_DIR=$HOME/.allen/cognee
ALLEN_COGNEE_EMBEDDING_PROVIDER=local
ALLEN_COGNEE_EMBEDDING_MODEL=BAAI/bge-small-en-v1.5
ALLEN_CONTEXT_RERANKER=bge
ALLEN_CONTEXT_RERANKER_MODEL=BAAI/bge-reranker-base
ALLEN_CONTEXT_LLM_PROVIDER=codex
ALLEN_CONTEXT_LLM_MODEL=gpt-5.5
```

Manual package install:

```bash
"$HOME/.allen/python/context-eval/bin/python" -m pip install "cognee[fastembed]" fastembed
"$HOME/.allen/python/context-eval/bin/python" -m pip install sentence-transformers
```

Manual model warmup:

```bash
"$HOME/.allen/python/context-eval/bin/python" -c "from fastembed import TextEmbedding; list(TextEmbedding(model_name='BAAI/bge-small-en-v1.5').embed(['warmup'])); print('ok')"
"$HOME/.allen/python/context-eval/bin/python" -c "from sentence_transformers import CrossEncoder; m=CrossEncoder('BAAI/bge-reranker-base'); print(m.predict([('query','document')]))"
```

With local defaults, Cognee stores relational metadata, vector data, and graph data under `ALLEN_COGNEE_DATA_DIR`. This is suitable for local development and single-user testing.

## External Postgres, pgvector, And Neo4j

Use this mode for shared or production-like environments:

```bash
npm run setup:context -- --external-db
```

The setup script installs Cognee with Postgres, Neo4j, and fastembed extras. Configure these variables in `.env` or deployment environment:

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

Cognee's pgvector provider uses the same Postgres connection as `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USERNAME`, and `DB_PASSWORD`. The same database and user can be used for relational metadata and vector tables if the user has normal table privileges and the `vector` extension already exists.

For RDS or other managed Postgres, create the extension once in the exact target database as an admin or `rds_superuser`:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

This is database-scoped. In DBeaver, connect to `DB_NAME` before running it; running the statement in another database does not enable pgvector for `allen_cognee`.

## Inspecting Cognee Data

For Postgres relational metadata:

```sql
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY table_schema, table_name;
```

To find vector columns:

```sql
SELECT table_schema, table_name, column_name, udt_name
FROM information_schema.columns
WHERE udt_name = 'vector'
ORDER BY table_schema, table_name;
```

If no vector rows appear, confirm:

- you are connected to the same `DB_NAME` used by Cognee;
- the context build reached the embedding/vector table creation step;
- `CREATE EXTENSION IF NOT EXISTS vector;` succeeded in that database;
- you are inspecting the schema where Cognee created tables.

In Neo4j:

```cypher
MATCH (n) RETURN labels(n), count(*) ORDER BY count(*) DESC;
MATCH ()-[r]->() RETURN type(r), count(*) ORDER BY count(*) DESC;
```

## Troubleshooting

- If setup fails during package install, rerun with `--python /path/to/python3` using a clean Python 3 interpreter.
- If the first context build is slow, check whether model warmup was skipped and whether Cognee is downloading models at build time.
- If UI progress stalls during cognification, use **Stop** in Context Management and rerun **Refresh Context** after the server is stable.
- If search results cannot resolve to curated entries, rebuild context so Cognee chunk-source mappings are recreated after cognification.
