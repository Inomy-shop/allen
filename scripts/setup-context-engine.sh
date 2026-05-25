#!/usr/bin/env bash
# Allen context engine setup script.
#
# Idempotently prepares the Python sidecar environment for Allen context flows.
# Cognee is the default provider. Existing .env values are preserved.

set -euo pipefail

REPO_ROOT="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )/.." &> /dev/null && pwd )"
cd "$REPO_ROOT"

if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
  C_RESET=""; C_BOLD=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""
fi

step()  { printf "\n${C_BOLD}${C_BLUE}==>${C_RESET} ${C_BOLD}%s${C_RESET}\n" "$1"; }
ok()    { printf "  ${C_GREEN}✓${C_RESET} %s\n" "$1"; }
warn()  { printf "  ${C_YELLOW}!${C_RESET} %s\n" "$1"; }
err()   { printf "  ${C_RED}✗${C_RESET} %s\n" "$1"; }

usage() {
  cat <<EOF
Usage: bash scripts/setup-context-engine.sh [options]

Options:
  --external-db      Install Cognee Postgres/Neo4j extras and print DB setup reminders.
  --without-reranker Skip sentence-transformers, BGE reranker warmup, and reranker .env defaults.
  --with-reranker    Kept for compatibility; reranker setup is enabled by default.
  --llm-provider PROVIDER
                    Context LLM provider to write when no context LLM provider is configured.
  --llm-model MODEL Context LLM model to write when no context LLM model is configured.
  --python PATH      Python executable to use for creating the context venv.
  --skip-warmup      Install packages but skip model warmup downloads.
  -h, --help         Show this help.
EOF
}

have() { command -v "$1" >/dev/null 2>&1; }

EXTERNAL_DB=0
WITH_RERANKER=1
SKIP_WARMUP=0
PYTHON_BIN="${PYTHON_BIN:-python3}"
VENV_DIR="${ALLEN_CONTEXT_VENV_DIR:-$HOME/.allen/python/context-eval}"
COGNEE_DATA_DIR_DEFAULT="$HOME/.allen/cognee"
EMBEDDING_MODEL_DEFAULT="BAAI/bge-small-en-v1.5"
RERANKER_MODEL_DEFAULT="BAAI/bge-reranker-base"
LLM_PROVIDER_ARG=""
LLM_MODEL_ARG=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --external-db)
      EXTERNAL_DB=1
      shift
      ;;
    --with-reranker)
      WITH_RERANKER=1
      shift
      ;;
    --llm-provider)
      if [ "$#" -lt 2 ]; then
        err "--llm-provider requires a provider"
        exit 1
      fi
      LLM_PROVIDER_ARG="$2"
      shift 2
      ;;
    --llm-model)
      if [ "$#" -lt 2 ]; then
        err "--llm-model requires a model"
        exit 1
      fi
      LLM_MODEL_ARG="$2"
      shift 2
      ;;
    --without-reranker|--skip-reranker)
      WITH_RERANKER=0
      shift
      ;;
    --python)
      if [ "$#" -lt 2 ]; then
        err "--python requires a path"
        exit 1
      fi
      PYTHON_BIN="$2"
      shift 2
      ;;
    --skip-warmup)
      SKIP_WARMUP=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      err "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

step "Checking Python"
if ! have "$PYTHON_BIN"; then
  err "Python executable not found: $PYTHON_BIN"
  warn "Install Python 3.10+ or pass --python /path/to/python3."
  exit 1
fi

PYTHON_VERSION="$("$PYTHON_BIN" - <<'PY'
import sys
print(f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")
PY
)"
PYTHON_MAJOR="$("$PYTHON_BIN" - <<'PY'
import sys
print(sys.version_info.major)
PY
)"
PYTHON_MINOR="$("$PYTHON_BIN" - <<'PY'
import sys
print(sys.version_info.minor)
PY
)"
if [ "$PYTHON_MAJOR" -ne 3 ] || [ "$PYTHON_MINOR" -lt 10 ]; then
  err "Python $PYTHON_VERSION found; Cognee setup needs Python 3.10+."
  exit 1
fi
ok "Python $PYTHON_VERSION"

step "Preparing Python virtual environment"
mkdir -p "$(dirname "$VENV_DIR")"
if [ ! -x "$VENV_DIR/bin/python" ]; then
  "$PYTHON_BIN" -m venv "$VENV_DIR"
  ok "Created venv at $VENV_DIR"
else
  ok "Venv already exists at $VENV_DIR"
fi

ALLEN_PYTHON_PATH="$VENV_DIR/bin/python"
"$ALLEN_PYTHON_PATH" -m pip install --upgrade pip setuptools wheel
ok "Updated pip, setuptools, and wheel"

step "Installing context engine Python packages"
if [ "$EXTERNAL_DB" -eq 1 ]; then
  "$ALLEN_PYTHON_PATH" -m pip install "cognee[postgres-binary,neo4j,fastembed]" fastembed
  ok "Installed Cognee with Postgres, Neo4j, and fastembed extras"
else
  "$ALLEN_PYTHON_PATH" -m pip install "cognee[fastembed]" fastembed
  ok "Installed Cognee with fastembed extras"
fi

if [ "$WITH_RERANKER" -eq 1 ]; then
  "$ALLEN_PYTHON_PATH" -m pip install sentence-transformers
  ok "Installed sentence-transformers"
fi

step "Verifying Python imports"
"$ALLEN_PYTHON_PATH" - <<'PY'
import cognee  # noqa: F401
from fastembed import TextEmbedding  # noqa: F401
print("ok")
PY
ok "cognee and fastembed import successfully"

if [ "$SKIP_WARMUP" -eq 1 ]; then
  warn "Skipping model warmup because --skip-warmup was set"
else
  step "Warming default embedding model"
  "$ALLEN_PYTHON_PATH" - <<PY
from fastembed import TextEmbedding
list(TextEmbedding(model_name="${EMBEDDING_MODEL_DEFAULT}").embed(["warmup"]))
print("ok")
PY
  ok "Warmed embedding model $EMBEDDING_MODEL_DEFAULT"

  if [ "$WITH_RERANKER" -eq 1 ]; then
    step "Warming default reranker model"
    "$ALLEN_PYTHON_PATH" - <<PY
from sentence_transformers import CrossEncoder
model = CrossEncoder("${RERANKER_MODEL_DEFAULT}")
print(model.predict([("query", "document")]))
PY
    ok "Warmed reranker model $RERANKER_MODEL_DEFAULT"
  fi
fi

step "Preparing .env"
if [ ! -f .env ]; then
  touch .env
  ok "Created .env"
else
  ok ".env already exists"
fi

ensure_context_env_section() {
  if grep -qF "# Context engine defaults" .env; then
    return 0
  fi
  if [ -s .env ]; then
    printf "\n# Context engine defaults (managed by scripts/setup-context-engine.sh)\n" >> .env
  else
    printf "# Context engine defaults (managed by scripts/setup-context-engine.sh)\n" >> .env
  fi
}

set_env_default() {
  local key="$1"
  local value="$2"
  if grep -qE "^${key}=.+" .env; then
    ok "$key already set"
  elif grep -qE "^${key}=$" .env; then
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k{$0=k"="v} {print}' .env > .env.tmp && mv .env.tmp .env
    ok "Set empty $key"
  else
    ensure_context_env_section
    printf "%s=%s\n" "$key" "$value" >> .env
    ok "Added $key"
  fi
}

env_value() {
  local key="$1"
  if [ ! -f .env ]; then
    return 0
  fi
  awk -v k="$key" '
    BEGIN { FS = "=" }
    $0 !~ /^#/ && $1 == k {
      sub("^[^=]*=", "", $0)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $0)
      print $0
      exit
    }
  ' .env
}

valid_provider() {
  case "$1" in
    codex|claude-cli) return 0 ;;
    *) return 1 ;;
  esac
}

default_model_for_provider() {
  case "$1" in
    claude-cli) printf "%s" "sonnet" ;;
    codex|*) printf "%s" "gpt-5.5" ;;
  esac
}

valid_model_for_provider() {
  local provider="$1"
  local model="$2"
  case "$provider:$model" in
    claude-cli:sonnet|claude-cli:opus|claude-cli:haiku) return 0 ;;
    codex:gpt-5.5|codex:gpt-5.4|codex:o3|codex:o4-mini|codex:codex-mini) return 0 ;;
    *) return 1 ;;
  esac
}

resolve_context_llm_defaults() {
  local provider=""
  local model=""

  provider="$(env_value ALLEN_CONTEXT_LLM_PROVIDER)"
  model="$(env_value ALLEN_CONTEXT_LLM_MODEL)"

  if ! valid_provider "$provider"; then
    if valid_provider "$LLM_PROVIDER_ARG"; then
      provider="$LLM_PROVIDER_ARG"
    else
      provider="$(env_value ALLEN_DEFAULT_CHAT_PROVIDER)"
      if ! valid_provider "$provider"; then
        provider="$(env_value ALLEN_DEFAULT_AGENT_PROVIDER)"
      fi
      if ! valid_provider "$provider"; then
        provider="codex"
      fi
    fi
  fi

  if ! valid_model_for_provider "$provider" "$model"; then
    if valid_model_for_provider "$provider" "$LLM_MODEL_ARG"; then
      model="$LLM_MODEL_ARG"
    else
      model="$(env_value ALLEN_DEFAULT_AGENT_MODEL)"
      if ! valid_model_for_provider "$provider" "$model"; then
        model="$(default_model_for_provider "$provider")"
      fi
    fi
  fi

  CONTEXT_LLM_PROVIDER_DEFAULT="$provider"
  CONTEXT_LLM_MODEL_DEFAULT="$model"
}

resolve_context_llm_defaults

set_env_default "ALLEN_CONTEXT_PROVIDER" "cognee"
set_env_default "ALLEN_PYTHON" "$ALLEN_PYTHON_PATH"
set_env_default "ALLEN_COGNEE_DATA_DIR" "$COGNEE_DATA_DIR_DEFAULT"
set_env_default "ALLEN_COGNEE_EMBEDDING_PROVIDER" "local"
set_env_default "ALLEN_COGNEE_EMBEDDING_MODEL" "$EMBEDDING_MODEL_DEFAULT"
set_env_default "ALLEN_CONTEXT_LLM_PROVIDER" "$CONTEXT_LLM_PROVIDER_DEFAULT"
set_env_default "ALLEN_CONTEXT_LLM_MODEL" "$CONTEXT_LLM_MODEL_DEFAULT"

if [ "$WITH_RERANKER" -eq 1 ]; then
  set_env_default "ALLEN_CONTEXT_RERANKER" "bge"
  set_env_default "ALLEN_CONTEXT_RERANKER_MODEL" "$RERANKER_MODEL_DEFAULT"
  set_env_default "ALLEN_CONTEXT_RERANKER_IDLE_TIMEOUT_MS" "1800000"
  set_env_default "ALLEN_CONTEXT_RERANKER_QUEUE_LIMIT" "100"
fi

if [ "$EXTERNAL_DB" -eq 1 ]; then
  step "External database reminders"
  cat <<EOF
  Set these in .env or your deployment environment before rebuilding context:

    DB_PROVIDER=postgres
    DB_HOST=<postgres-host>
    DB_PORT=5432
    DB_NAME=<database-name>
    DB_USERNAME=<database-user>
    DB_PASSWORD=<database-password>
    VECTOR_DB_PROVIDER=pgvector
    GRAPH_DATABASE_PROVIDER=neo4j
    GRAPH_DATABASE_URL=bolt://<neo4j-host>:7687
    GRAPH_DATABASE_NAME=neo4j
    GRAPH_DATABASE_USERNAME=<neo4j-user>
    GRAPH_DATABASE_PASSWORD=<neo4j-password>
    ENABLE_BACKEND_ACCESS_CONTROL=false
    REQUIRE_AUTHENTICATION=false

  pgvector must be enabled in the exact target Postgres database:

    CREATE EXTENSION IF NOT EXISTS vector;

EOF
fi

step "Context engine setup complete"
cat <<EOF
  Provider:              cognee
  Python:                $ALLEN_PYTHON_PATH
  Cognee data dir:       $COGNEE_DATA_DIR_DEFAULT
  Embedding model:       $EMBEDDING_MODEL_DEFAULT
  Reranker:              $([ "$WITH_RERANKER" -eq 1 ] && printf "%s" "$RERANKER_MODEL_DEFAULT" || printf "%s" "disabled")
  Context LLM:           $CONTEXT_LLM_PROVIDER_DEFAULT / $CONTEXT_LLM_MODEL_DEFAULT

  Next:
    1. Ensure the selected LLM CLI is authenticated.
    2. Start Allen:                    ${C_BOLD}npm start${C_RESET}
    3. Rebuild context from the repo UI.

EOF
