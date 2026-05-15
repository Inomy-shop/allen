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
    warn "MongoDB still not reachable on localhost:27017. Start it manually before running 'npm start'."
  fi
fi

# ---------------------------------------------------------------------------
# Claude Code CLI
# ---------------------------------------------------------------------------
step "Checking Claude Code CLI"
if have claude; then
  ok "claude $(claude --version 2>/dev/null | head -n1 || echo 'installed')"
else
  warn "claude CLI not found. Installing globally via npm..."
  if npm install -g @anthropic-ai/claude-code; then
    ok "Installed Claude Code CLI"
    warn "Authenticate it once with: claude  (then complete the login prompt)"
  else
    err "Could not install Claude Code CLI. Install manually: npm install -g @anthropic-ai/claude-code"
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
# Done
# ---------------------------------------------------------------------------
step "Setup complete"
cat <<EOF

  Next steps:
    1. Authenticate Claude Code once if you haven't: ${C_BOLD}claude${C_RESET}
    2. Authenticate Codex once if you haven't:       ${C_BOLD}codex${C_RESET}
    3. Check local readiness:                        ${C_BOLD}npm run health${C_RESET}
    4. Start Allen:                                  ${C_BOLD}npm start${C_RESET}
    5. Open the UI and create the first admin account.

  Allen will be available at:
    API: http://localhost:4000
    UI:  http://localhost:5173

EOF
