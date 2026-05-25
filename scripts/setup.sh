#!/usr/bin/env bash
# Allen setup script.
#
# Idempotent. Run as many times as needed. Verifies and (where safe) installs
# Allen's runtime dependencies, then prepares .env for first launch.
#
# Usage:
#   ./scripts/setup.sh
#   npm run setup

set -u
set -o pipefail

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

OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="macos" ;;
  Linux)  PLATFORM="linux" ;;
  *)      PLATFORM="other" ;;
esac

have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# Node.js 22+
#
# If Node is missing or older than 22, install Node 22 via nvm (per-user, no
# sudo, does not touch any system Node). nvm itself is bootstrapped if absent.
# ---------------------------------------------------------------------------
NVM_DIR_DEFAULT="${NVM_DIR:-$HOME/.nvm}"

load_nvm() {
  export NVM_DIR="$NVM_DIR_DEFAULT"
  # shellcheck disable=SC1090
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  command -v nvm >/dev/null 2>&1
}

install_node_22_via_nvm() {
  if ! load_nvm; then
    warn "nvm not found — installing nvm (per-user, no sudo)..."
    if have curl; then
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash >/dev/null 2>&1 || true
    elif have wget; then
      wget -qO- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash >/dev/null 2>&1 || true
    else
      err "Neither curl nor wget is available to bootstrap nvm."
      warn "Install Node 22+ manually (https://nodejs.org/ or nvm/fnm), then re-run."
      exit 1
    fi
    if ! load_nvm; then
      err "nvm bootstrap failed."
      warn "Install Node 22+ manually (https://nodejs.org/ or nvm/fnm), then re-run."
      exit 1
    fi
    ok "Installed nvm into $NVM_DIR"
  fi
  warn "Installing Node 22 via nvm..."
  if nvm install 22 >/dev/null 2>&1 && nvm use 22 >/dev/null 2>&1 && nvm alias default 22 >/dev/null 2>&1; then
    ok "Node $(node -v) (via nvm)"
    warn "nvm sets Node per-shell. If a later step can't find Node, open a new shell (or run: nvm use 22) and re-run this script."
  else
    err "nvm failed to install Node 22."
    warn "Install Node 22+ manually (https://nodejs.org/ or nvm/fnm), then re-run."
    exit 1
  fi
}

step "Checking Node.js (need 22+)"
if have node; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$NODE_MAJOR" -ge 22 ]; then
    ok "Node $(node -v)"
  else
    warn "Node $(node -v) found; Allen needs 22+. Installing Node 22 via nvm..."
    install_node_22_via_nvm
  fi
else
  warn "Node.js not found. Installing Node 22 via nvm..."
  install_node_22_via_nvm
fi

# ---------------------------------------------------------------------------
# npm 10+
# ---------------------------------------------------------------------------
step "Checking npm (need 10+)"
if have npm; then
  NPM_MAJOR="$(npm -v | cut -d. -f1)"
  if [ "$NPM_MAJOR" -ge 10 ]; then
    ok "npm $(npm -v)"
  else
    warn "npm $(npm -v) found; Allen prefers 10+."
    warn "Upgrade with: npm install -g npm@10"
  fi
else
  err "npm not found (should ship with Node). Re-install Node and re-run."
  exit 1
fi

# ---------------------------------------------------------------------------
# Git
# ---------------------------------------------------------------------------
step "Checking Git"
if have git; then
  ok "git $(git --version 2>/dev/null | awk '{print $3}')"
else
  err "git not found."
  if [ "$PLATFORM" = "macos" ]; then
    warn "Install with: xcode-select --install   (or: brew install git), then re-run."
  elif [ "$PLATFORM" = "linux" ]; then
    warn "Install via your package manager (e.g. sudo apt install git, sudo dnf install git), then re-run."
  else
    warn "Install Git from https://git-scm.com/downloads, then re-run."
  fi
  exit 1
fi

# ---------------------------------------------------------------------------
# MongoDB 7
# ---------------------------------------------------------------------------
step "Checking MongoDB 7"
MONGO_OK=0
if have mongod; then
  MONGO_VER="$(mongod --version 2>/dev/null | head -n1 | sed -E 's/.*v([0-9]+\.[0-9]+\.[0-9]+).*/\1/')"
  ok "mongod ${MONGO_VER:-installed}"
  MONGO_OK=1
elif have mongosh; then
  ok "mongosh present (server may run elsewhere)"
  MONGO_OK=1
else
  err "MongoDB not found."
  if [ "$PLATFORM" = "macos" ] && have brew; then
    warn "Installing MongoDB 7 via Homebrew..."
    brew tap mongodb/brew 2>/dev/null || true
    if brew install mongodb-community@7.0; then
      ok "Installed mongodb-community@7.0"
      MONGO_OK=1
    else
      err "brew install failed. Install manually from https://www.mongodb.com/try/download/community"
      exit 1
    fi
  elif [ "$PLATFORM" = "linux" ]; then
    warn "Install MongoDB 7 from https://www.mongodb.com/docs/manual/administration/install-on-linux/, then re-run."
    exit 1
  else
    warn "Install MongoDB 7 from https://www.mongodb.com/try/download/community, then re-run."
    exit 1
  fi
fi

# Try to start MongoDB if it's not already reachable on localhost:27017.
step "Ensuring MongoDB is running on localhost:27017"
mongo_reachable() {
  if have mongosh; then
    mongosh --quiet --eval "db.runCommand({ping:1}).ok" "mongodb://localhost:27017/admin" 2>/dev/null \
      | tr -d '[:space:]' | grep -q '^1$'
  else
    # Fall back to a TCP probe.
    (echo > /dev/tcp/localhost/27017) >/dev/null 2>&1
  fi
}

if mongo_reachable; then
  ok "MongoDB is reachable"
else
  if [ "$PLATFORM" = "macos" ] && have brew; then
    warn "Starting mongodb-community@7.0 via brew services..."
    brew services start mongodb-community@7.0 >/dev/null 2>&1 || true
    sleep 2
  elif [ "$PLATFORM" = "linux" ] && have systemctl; then
    warn "Starting mongod via systemctl (may prompt for sudo)..."
    sudo systemctl start mongod || true
    sleep 2
  fi
  if mongo_reachable; then
    ok "MongoDB is reachable"
  else
    err "MongoDB still not reachable on localhost:27017."
    if [ "$PLATFORM" = "macos" ]; then
      warn "Try: brew services start mongodb-community@7.0   (then re-run this script)"
    elif [ "$PLATFORM" = "linux" ]; then
      warn "Try: sudo systemctl start mongod   (then re-run this script)"
    else
      warn "Start MongoDB so it listens on localhost:27017, then re-run this script."
    fi
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Claude Code CLI
#
# IMPORTANT: do not `npm install -g @anthropic-ai/claude-code`. That npm
# package is the Claude Agent SDK; its bundled `cli.js` lacks the
# `--agent <name>` flag that Allen's engine requires (see
# packages/engine/src/cli-runner.ts). Use the official standalone installer.
# ---------------------------------------------------------------------------
claude_has_agent_flag() {
  command -v "$1" >/dev/null 2>&1 && "$1" --help 2>/dev/null | grep -q -- '--agent <agent>'
}

step "Checking Claude Code CLI"
NEED_CLAUDE_INSTALL=0
if have claude; then
  if claude_has_agent_flag claude; then
    ok "claude $(claude --version 2>/dev/null | head -n1 || echo 'installed') (has --agent support)"
  else
    warn "\`claude\` is on PATH but lacks --agent support (likely the npm SDK shim)."
    warn "Allen's engine requires the standalone Claude Code CLI."
    NEED_CLAUDE_INSTALL=1
  fi
else
  warn "claude CLI not found."
  NEED_CLAUDE_INSTALL=1
fi

if [ "$NEED_CLAUDE_INSTALL" -eq 1 ]; then
  if have curl; then
    warn "Installing the standalone Claude Code CLI via the official installer..."
    if curl -fsSL https://claude.ai/install.sh | bash; then
      ok "Installed Claude Code CLI (typically to ~/.local/bin/claude)"
      warn "If \`claude\` is not on your PATH after this, add \`~/.local/bin\` to PATH and restart your shell."
      warn "Authenticate it once with: ${C_BOLD}claude${C_RESET}"
    else
      err "Official Claude Code installer failed."
      warn "Install manually from https://docs.claude.com/en/docs/claude-code/quickstart, then re-run this script."
      exit 1
    fi
  else
    err "Cannot install Claude Code: \`curl\` is not available."
    warn "Install curl, OR install Claude Code manually from https://docs.claude.com/en/docs/claude-code/quickstart, then re-run."
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Codex CLI (default chat provider)
# ---------------------------------------------------------------------------
step "Checking Codex CLI"
if have codex; then
  ok "codex $(codex --version 2>/dev/null | head -n1 || echo 'installed')"
else
  warn "codex CLI not found. Installing globally via npm..."
  if npm install -g @openai/codex; then
    ok "Installed Codex CLI"
    warn "Authenticate it once with: codex  (then complete the login prompt)"
  else
    err "Could not install Codex CLI. Install manually: npm install -g @openai/codex"
  fi
fi

# ---------------------------------------------------------------------------
# Project dependencies
# ---------------------------------------------------------------------------
step "Installing project dependencies (npm install)"
npm install
ok "Dependencies installed"

# ---------------------------------------------------------------------------
# .env
# ---------------------------------------------------------------------------
step "Preparing .env"
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    ok "Created .env from .env.example"
  else
    err ".env.example missing — cannot create .env."
    exit 1
  fi
else
  ok ".env already exists (leaving it as-is)"
fi

gen_secret() {
  if have openssl; then
    openssl rand -hex 32
  else
    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  fi
}

replace_placeholder() {
  local key="$1"
  if grep -qE "^${key}=replace-me-with-openssl-rand-hex-32" .env; then
    local val
    val="$(gen_secret)"
    # Cross-platform sed in-place: write to a temp and move.
    awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k{$0=k"="v} {print}' .env > .env.tmp && mv .env.tmp .env
    ok "Generated $key"
  else
    ok "$key already set"
  fi
}

replace_placeholder JWT_ACCESS_SECRET
replace_placeholder JWT_REFRESH_SECRET

# Set (or leave) an .env key idempotently. If the key is already present and
# non-empty, leave it alone (user customization wins). If a commented
# placeholder exists, uncomment it with the value; otherwise append.
set_env_key() {
  local key="$1"
  local val="$2"
  if grep -qE "^${key}=." .env; then
    ok "${key} already set in .env (leaving as-is)"
    return 0
  fi
  if grep -qE "^# *${key}=" .env; then
    awk -v k="$key" -v v="$val" '
      BEGIN { pat = "^# *" k "=" }
      $0 ~ pat { print k "=" v; next }
      { print }
    ' .env > .env.tmp && mv .env.tmp .env
  else
    printf "%s=%s\n" "$key" "$val" >> .env
  fi
  ok "Set ${key}=${val}"
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

valid_llm_provider() {
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

  provider="$(env_value ALLEN_DEFAULT_CHAT_PROVIDER)"
  if ! valid_llm_provider "$provider"; then
    provider="$(env_value ALLEN_DEFAULT_AGENT_PROVIDER)"
  fi
  if ! valid_llm_provider "$provider"; then
    provider="codex"
  fi

  model="$(env_value ALLEN_DEFAULT_AGENT_MODEL)"
  if ! valid_model_for_provider "$provider" "$model"; then
    model="$(default_model_for_provider "$provider")"
  fi

  CONTEXT_LLM_PROVIDER_DEFAULT="$provider"
  CONTEXT_LLM_MODEL_DEFAULT="$model"
}

# ---------------------------------------------------------------------------
# CLAUDE_BIN auto-detection
#
# Allen's CLI executor refuses any `claude` binary under node_modules/.bin/
# AND any binary that lacks `--agent <name>` support (the npm SDK shim does
# not implement it). Walk every `claude` on PATH, skip node_modules/.bin
# entries, and pin the first one whose --help advertises `--agent <agent>`.
# ---------------------------------------------------------------------------
step "Resolving CLAUDE_BIN"
if grep -qE "^CLAUDE_BIN=." .env; then
  ok "CLAUDE_BIN already set in .env (leaving as-is)"
else
  CLAUDE_BIN_PATH=""
  while IFS= read -r candidate; do
    [ -x "$candidate" ] || continue
    if "$candidate" --help 2>/dev/null | grep -q -- '--agent <agent>'; then
      CLAUDE_BIN_PATH="$candidate"
      break
    fi
  done < <(command which -a claude 2>/dev/null | grep -v '/node_modules/.bin/')

  if [ -n "${CLAUDE_BIN_PATH:-}" ]; then
    # Uncomment an existing `# CLAUDE_BIN=` placeholder if present, otherwise append.
    if grep -qE "^# *CLAUDE_BIN=" .env; then
      awk -v v="$CLAUDE_BIN_PATH" 'BEGIN{FS=OFS="="} /^# *CLAUDE_BIN=/{print "CLAUDE_BIN=" v; next} {print}' .env > .env.tmp && mv .env.tmp .env
    else
      printf "\nCLAUDE_BIN=%s\n" "$CLAUDE_BIN_PATH" >> .env
    fi
    ok "Pinned CLAUDE_BIN=$CLAUDE_BIN_PATH (verified --agent support)"
  else
    warn "Could not find any \`claude\` binary with --agent support on PATH."
    warn "Allen's engine will reject the npm SDK CLI (node_modules/.bin/claude or @anthropic-ai/claude-code global)."
    warn "Install the standalone Claude Code CLI from https://docs.claude.com/en/docs/claude-code/quickstart"
    warn "then re-run this script (or set CLAUDE_BIN=<absolute-path> in .env)."
  fi
fi

# ---------------------------------------------------------------------------
# Default LLM provider
#
# Pick the provider Allen will use by default for chat, newly seeded built-in
# agents, agents created via the API, and the agent each workflow node spawns.
# Per-agent overrides in the Agents page (and per-node overrides in the
# workflow editor) still win at runtime — these are creation-time defaults.
#
# Decision:
#   - both CLIs available  → interactive prompt (claude/opus vs codex/gpt-5.5)
#   - only claude          → claude-cli + opus
#   - only codex           → codex + gpt-5.5
#   - neither              → skip (warn; user wires it later)
# ---------------------------------------------------------------------------
step "Choosing default LLM provider"

CLAUDE_AVAILABLE=0
CODEX_AVAILABLE=0
if have claude && claude_has_agent_flag claude; then
  CLAUDE_AVAILABLE=1
fi
if have codex; then
  CODEX_AVAILABLE=1
fi

CHOICE_PROVIDER=""
CHOICE_MODEL=""
CHOICE_LABEL=""

# CHOICE_MODE distinguishes the three outcomes:
#   "flatten" → write all three ALLEN_DEFAULT_* keys to .env
#   "preserve" → write none of them, so the seed's per-agent provider+model
#                is honored verbatim by resolveAgentProviderModel()
#   ""        → no CLI usable; skip silently with a warn
CHOICE_MODE=""

if [ "$CLAUDE_AVAILABLE" -eq 1 ] && [ "$CODEX_AVAILABLE" -eq 1 ]; then
  if [ -t 0 ]; then
    printf "\n  Both Claude Code and Codex CLIs are available.\n"
    printf "  Pick the default for chat, new agents, and workflow nodes:\n"
    printf "    ${C_BOLD}1)${C_RESET} Claude Code     (everything on claude-cli / opus)\n"
    printf "    ${C_BOLD}2)${C_RESET} Codex           (everything on codex / gpt-5.5)\n"
    printf "    ${C_BOLD}3)${C_RESET} Both (preserve) (keep each seeded agent's own provider+model —\n"
    printf "                       some on claude, some on codex, as defined in the seed)\n"
    printf "  Choice [1/2/3, default 1]: "
    read -r picker_choice
    case "$picker_choice" in
      2|codex)
        CHOICE_MODE="flatten"
        CHOICE_PROVIDER="codex"
        CHOICE_MODEL="gpt-5.5"
        CHOICE_LABEL="Codex (gpt-5.5) — flattened"
        ;;
      3|both|preserve)
        CHOICE_MODE="preserve"
        CHOICE_LABEL="Both (preserve seed: per-agent provider+model)"
        ;;
      *)
        CHOICE_MODE="flatten"
        CHOICE_PROVIDER="claude-cli"
        CHOICE_MODEL="opus"
        CHOICE_LABEL="Claude Code (opus) — flattened"
        ;;
    esac
  else
    warn "Non-interactive shell — defaulting to claude-cli/opus."
    warn "Edit ALLEN_DEFAULT_CHAT_PROVIDER / ALLEN_DEFAULT_AGENT_PROVIDER / ALLEN_DEFAULT_AGENT_MODEL in .env to override."
    CHOICE_MODE="flatten"
    CHOICE_PROVIDER="claude-cli"
    CHOICE_MODEL="opus"
    CHOICE_LABEL="Claude Code (opus) — flattened"
  fi
elif [ "$CLAUDE_AVAILABLE" -eq 1 ]; then
  ok "Only Claude Code CLI is available — defaulting to claude-cli / opus."
  CHOICE_MODE="flatten"
  CHOICE_PROVIDER="claude-cli"
  CHOICE_MODEL="opus"
  CHOICE_LABEL="Claude Code (opus)"
elif [ "$CODEX_AVAILABLE" -eq 1 ]; then
  ok "Only Codex CLI is available — defaulting to codex / gpt-5.5."
  CHOICE_MODE="flatten"
  CHOICE_PROVIDER="codex"
  CHOICE_MODEL="gpt-5.5"
  CHOICE_LABEL="Codex (gpt-5.5)"
else
  warn "Neither Claude Code nor Codex CLI is usable — skipping default LLM provider config."
  warn "Once a CLI is installed, set these in .env:"
  warn "  ALLEN_DEFAULT_CHAT_PROVIDER, ALLEN_DEFAULT_AGENT_PROVIDER, ALLEN_DEFAULT_AGENT_MODEL"
fi

if [ "$CHOICE_MODE" = "flatten" ]; then
  set_env_key ALLEN_DEFAULT_CHAT_PROVIDER  "$CHOICE_PROVIDER"
  set_env_key ALLEN_DEFAULT_AGENT_PROVIDER "$CHOICE_PROVIDER"
  set_env_key ALLEN_DEFAULT_AGENT_MODEL    "$CHOICE_MODEL"
elif [ "$CHOICE_MODE" = "preserve" ]; then
  ok "Preserve mode — leaving ALLEN_DEFAULT_AGENT_* unset so seed values are honored verbatim."
  ok "Chat will use Allen's built-in default (codex). Override per-session in the chat picker."
fi

# ---------------------------------------------------------------------------
# Optional context engine
#
# Context engine setup installs a Python venv plus Cognee, embeddings, and
# reranker packages. Keep the base setup fast by asking before doing that work.
# ---------------------------------------------------------------------------
step "Optional context engine setup"
resolve_context_llm_defaults
CONTEXT_ENGINE_SETUP="skipped"

if [ -t 0 ]; then
  printf "\n  Install the Cognee-backed context engine now? This creates a Python venv,\n"
  printf "  installs context packages, and warms local embedding/reranker models.\n"
  printf "  Context LLM default: ${C_BOLD}%s / %s${C_RESET}\n" "$CONTEXT_LLM_PROVIDER_DEFAULT" "$CONTEXT_LLM_MODEL_DEFAULT"
  printf "  Install context engine? [y/N]: "
  read -r context_choice
  case "$context_choice" in
    y|Y|yes|YES)
      bash scripts/setup-context-engine.sh \
        --llm-provider "$CONTEXT_LLM_PROVIDER_DEFAULT" \
        --llm-model "$CONTEXT_LLM_MODEL_DEFAULT"
      CONTEXT_ENGINE_SETUP="installed"
      ;;
    *)
      ok "Skipped context engine setup. Run npm run setup:context later to install it."
      ;;
  esac
else
  warn "Non-interactive shell — skipping context engine setup."
  warn "Run npm run setup:context later to install it."
fi

# ---------------------------------------------------------------------------
# Health check
#
# Run the full health check so the user sees PASS/FAIL on each runtime
# dependency before they ever try `npm start`. Auth checks ("Claude Code
# authenticated") will FAIL on first setup until the user runs `claude`
# interactively — that is expected and surfaced as a guided next step.
# ---------------------------------------------------------------------------
step "Running health check"
if npm run --silent health; then
  ok "Health check passed"
  HEALTH_OK=1
else
  warn "Health check reported issues (most likely: Claude Code / Codex not authenticated yet)."
  HEALTH_OK=0
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
step "Setup complete"
if [ "$HEALTH_OK" -eq 1 ]; then
  cat <<EOF

  All runtime deps look good. Next:
    1. Build all packages:                           ${C_BOLD}npm run build${C_RESET}
    2. Start Allen:                                  ${C_BOLD}npm start${C_RESET}
    3. Open ${C_BOLD}http://localhost:5173${C_RESET} and complete the onboarding screens
       (account → health → repository → first workflow).

  Allen will be available at:
    API: http://localhost:4000
    UI:  http://localhost:5173

EOF
else
  cat <<EOF

  Setup finished but the health check above flagged something. Common fixes:
    - Authenticate Claude Code:                      ${C_BOLD}claude${C_RESET}
    - Authenticate Codex (optional):                 ${C_BOLD}codex${C_RESET}
    - Re-run the health check:                       ${C_BOLD}npm run health${C_RESET}

  Once health is green:
    - Build all packages:                            ${C_BOLD}npm run build${C_RESET}
    - Start Allen:                                   ${C_BOLD}npm start${C_RESET}
    - Open ${C_BOLD}http://localhost:5173${C_RESET} and complete onboarding.

EOF
fi

if [ -n "${CHOICE_LABEL:-}" ]; then
  if [ "$CHOICE_MODE" = "preserve" ]; then
    cat <<EOF
  ${C_BOLD}Default LLM provider:${C_RESET} ${CHOICE_LABEL}
    - Each seeded built-in agent keeps the provider+model defined in its seed
      (e.g. architects on opus, lightweight dispatchers on haiku, repo-scanner
      on codex/gpt-5.5).
    - Override per-agent in the Agents page (provider + model).
    - Override per-node in the workflow editor (Agent overrides → provider/model).
    - Chat: switch per-session in the chat picker. To pin a default, set
      ${C_BOLD}ALLEN_DEFAULT_CHAT_PROVIDER${C_RESET} in .env.
    - Existing agent records keep their stored values. To re-seed built-ins
      under the current rules, set ${C_BOLD}SEED_OVERRIDE=true${C_RESET} and restart.

EOF
  else
    cat <<EOF
  ${C_BOLD}Default LLM provider:${C_RESET} ${CHOICE_LABEL}
    - Chat, newly seeded built-in agents, and new workflow nodes use this by default.
    - Same-provider role-specific models in the seed are preserved (e.g. an agent
      pinned to opus stays on opus); cross-provider seeds fall back to the env model.
    - Override per-agent in the Agents page (provider + model).
    - Override per-node in the workflow editor (Agent overrides → provider/model).
    - Chat: switch per-session in the chat picker, or change the default by editing
      ${C_BOLD}ALLEN_DEFAULT_CHAT_PROVIDER${C_RESET} in .env.
    - Existing agent records keep their stored provider/model; only NEW agents pick
      up the env defaults. To re-seed built-ins, set ${C_BOLD}SEED_OVERRIDE=true${C_RESET}
      and restart.

EOF
  fi
fi

if [ "${CONTEXT_ENGINE_SETUP:-skipped}" = "installed" ]; then
  cat <<EOF
  ${C_BOLD}Context engine:${C_RESET} installed
    - Context LLM default: ${C_BOLD}${CONTEXT_LLM_PROVIDER_DEFAULT} / ${CONTEXT_LLM_MODEL_DEFAULT}${C_RESET}
    - Rebuild context from the repo UI after Allen starts.

EOF
else
  cat <<EOF
  ${C_BOLD}Context engine:${C_RESET} not installed by this run
    - Install later with: ${C_BOLD}npm run setup:context${C_RESET}

EOF
fi
