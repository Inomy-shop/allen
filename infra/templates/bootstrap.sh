#!/bin/bash
# Allen EC2 bootstrap + deploy script.
# Idempotent — safe to re-run on every deploy.
# Called by Terraform's null_resource.deploy_app via SSM send-command.
set -euo pipefail

REPO_DIR=/home/ubuntu/allen
REPO_URL="${REPO_URL:-https://github.com/Kalpai-poc/flowforge.git}"
BRANCH="${BRANCH:-main}"

echo "========================================"
echo "Allen Deploy — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "========================================"

# ── 1. System dependencies ──────────────────────────────────────────────────
echo "=== [1/8] Install system deps ==="
if ! command -v nginx &>/dev/null; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq nginx
fi
# Build tools for native modules (node-pty, etc.)
if ! command -v make &>/dev/null || ! command -v g++ &>/dev/null; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq build-essential python3 make g++
fi
if ! command -v node &>/dev/null || [[ "$(node -v)" < "v20" ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
echo "  node: $(node -v)  npm: $(npm -v)  nginx: $(nginx -v 2>&1)"

# ── 2. Clone or pull repo ──────────────────────────────────────────────────
echo "=== [2/8] Clone or pull repo ==="
if [ ! -d "$REPO_DIR/.git" ]; then
  sudo mkdir -p "$REPO_DIR"
  sudo chown ubuntu:ubuntu "$REPO_DIR"
  git clone "$REPO_URL" "$REPO_DIR"
fi
cd "$REPO_DIR"
git fetch origin
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"
echo "  branch: $(git branch --show-current)  commit: $(git rev-parse --short HEAD)"

# ── 3. Write config files ──────────────────────────────────────────────────
echo "=== [3/8] Write configs ==="

# nginx (rendered by Terraform, placed at /tmp by SSM)
if [ -f /tmp/allen-nginx.conf ]; then
  sudo cp /tmp/allen-nginx.conf /etc/nginx/sites-available/allen
  sudo ln -sf /etc/nginx/sites-available/allen /etc/nginx/sites-enabled/
  sudo rm -f /etc/nginx/sites-enabled/default
  echo "  nginx config: updated"
else
  echo "  nginx config: /tmp/allen-nginx.conf not found, skipping"
fi

# .env.production (rendered by Terraform)
if [ -f /tmp/allen-env ]; then
  cp /tmp/allen-env "$REPO_DIR/.env.production"
  chmod 600 "$REPO_DIR/.env.production"
  echo "  .env.production: updated"
else
  echo "  .env.production: /tmp/allen-env not found, skipping"
fi

# systemd service
sudo cp "$REPO_DIR/infra/templates/allen.service" /etc/systemd/system/allen.service
sudo systemctl daemon-reload
sudo systemctl enable allen
echo "  systemd: enabled"

# ── 4. DocumentDB CA cert ──────────────────────────────────────────────────
echo "=== [4/8] DocumentDB CA cert ==="
if [ ! -f "$REPO_DIR/rds-combined-ca-bundle.pem" ]; then
  wget -q -O "$REPO_DIR/rds-combined-ca-bundle.pem" \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
  echo "  downloaded"
else
  echo "  already exists"
fi

# ── 4b. Create /tmp/allen working dir (used as default cwd for agents) ──
sudo mkdir -p /tmp/allen
sudo chown ubuntu:ubuntu /tmp/allen


# ── 5. iptables — restrict workspace ports 15000-20000 to localhost ────────
echo "=== [5/8] iptables ==="
if ! sudo iptables -C INPUT -p tcp --dport 15000:20000 ! -s 127.0.0.1 -j DROP 2>/dev/null; then
  sudo iptables -A INPUT -p tcp --dport 15000:20000 ! -s 127.0.0.1 -j DROP
  echo "  rule added: block 15000-20000 from non-localhost"
else
  echo "  rule already exists"
fi
# Persist if iptables-persistent is installed
if command -v iptables-save &>/dev/null && [ -d /etc/iptables ]; then
  sudo iptables-save | sudo tee /etc/iptables/rules.v4 > /dev/null
elif command -v netfilter-persistent &>/dev/null; then
  sudo netfilter-persistent save 2>/dev/null || true
fi

# ── 6. Install dependencies ────────────────────────────────────────────────
echo "=== [6/9] npm ci ==="
cd "$REPO_DIR"
# Don't pipe to `tail` — we need full error output if the install fails.
npm ci --prefer-offline

# ── 6b. Playwright browser + system libs (for `npm run test:e2e` on EC2) ───
# Playwright needs ~20 shared libs (libnss3, libatk, libxkbcommon, etc.) that
# are not on the base Ubuntu AMI. Installed once per deploy; idempotent.
# If this box never runs E2E, `npm run test:e2e` is a no-op and the download
# still finishes in <30s, so the cost is negligible.
echo "=== [6b/9] Playwright browser + deps ==="
if command -v npx &>/dev/null; then
  # install-deps uses apt-get install (needs sudo); install downloads the
  # chromium bundle (no sudo needed, lives in ~/.cache/ms-playwright/).
  sudo npx --yes playwright install-deps chromium 2>&1 | tail -5 || \
    echo "  WARN: playwright install-deps failed — e2e may need manual system libs"
  npx --yes playwright install chromium 2>&1 | tail -3
  echo "  playwright: ready"
fi

# ── 7. Build all packages ─────────────────────────────────────────────────
# Do NOT pipe to `tail` — tsc errors are lost and we only see the final
# "npm error command sh -c tsc" line, which tells us nothing about the
# actual compile failure. Full output makes deploy debugging possible.
echo "=== [7/9] Build ==="
npm run build --workspace=@allen/engine
npm run build --workspace=@allen/server
npm run build --workspace=@allen/ui
echo "  build complete"

# ── 8. Start / restart services ────────────────────────────────────────────
echo "=== [8/9] Start services ==="
sudo nginx -t 2>&1
sudo systemctl reload nginx
echo "  nginx: reloaded"

sudo systemctl restart allen
echo "  allen: restarted"

# Health check — wait up to 15 seconds
echo "Waiting for health check..."
for i in $(seq 1 15); do
  if curl -sf http://localhost:4023/api/health > /dev/null 2>&1; then
    echo "✅ Allen is healthy (attempt $i)"
    echo ""
    echo "Deploy complete: $(git rev-parse --short HEAD) on $(git branch --show-current)"
    exit 0
  fi
  sleep 1
done

echo "❌ Health check failed after 15 seconds"
echo "--- journalctl output ---"
sudo journalctl -u allen --no-pager -n 30
exit 1
