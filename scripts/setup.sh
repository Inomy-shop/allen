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
# ---------------------------------------------------------------------------
step "Checking Node.js (need 22+)"
if have node; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$NODE_MAJOR" -ge 22 ]; then
    ok "Node $(node -v)"
  else
    err "Node $(node -v) found; Allen needs 22+."
    warn "Install Node 22+ via nvm (https://github.com/nvm-sh/nvm), fnm, or your OS package manager, then re-run."
    exit 1
  fi
else
  err "Node.js not found."
  if [ "$PLATFORM" = "macos" ] && have brew; then
    warn "Install with: brew install node@22  (then add it to PATH per brew's instructions)"
  else
    warn "Install Node 22+ from https://nodejs.org/ or via nvm/fnm, then re-run."
  fi
  exit 1
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
    1. Start Allen:                                  ${C_BOLD}npm start${C_RESET}
    2. Open ${C_BOLD}http://localhost:5173${C_RESET} and complete the onboarding screens
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
    - Start Allen:                                   ${C_BOLD}npm start${C_RESET}
    - Open ${C_BOLD}http://localhost:5173${C_RESET} and complete onboarding.

EOF
fi
