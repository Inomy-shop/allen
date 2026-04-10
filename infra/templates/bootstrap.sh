#!/bin/bash
# FlowForge EC2 bootstrap + deploy script.
# Idempotent — safe to re-run on every deploy.
# Called by Terraform's null_resource.deploy_app via SSM send-command.
set -euo pipefail

REPO_DIR=/opt/flowforge
REPO_URL="${REPO_URL:-https://github.com/Kalpai-poc/flowforge.git}"
BRANCH="${BRANCH:-main}"

echo "========================================"
echo "FlowForge Deploy — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "========================================"

# ── 1. System dependencies ──────────────────────────────────────────────────
echo "=== [1/8] Install system deps ==="
if ! command -v nginx &>/dev/null; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq nginx
fi
if ! command -v iptables-save &>/dev/null; then
  sudo apt-get install -y -qq iptables-persistent
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
if [ -f /tmp/flowforge-nginx.conf ]; then
  sudo cp /tmp/flowforge-nginx.conf /etc/nginx/sites-available/flowforge
  sudo ln -sf /etc/nginx/sites-available/flowforge /etc/nginx/sites-enabled/
  sudo rm -f /etc/nginx/sites-enabled/default
  echo "  nginx config: updated"
else
  echo "  nginx config: /tmp/flowforge-nginx.conf not found, skipping"
fi

# .env.production (rendered by Terraform)
if [ -f /tmp/flowforge-env ]; then
  cp /tmp/flowforge-env "$REPO_DIR/.env.production"
  chmod 600 "$REPO_DIR/.env.production"
  echo "  .env.production: updated"
else
  echo "  .env.production: /tmp/flowforge-env not found, skipping"
fi

# systemd service
sudo cp "$REPO_DIR/infra/templates/flowforge.service" /etc/systemd/system/flowforge.service
sudo systemctl daemon-reload
sudo systemctl enable flowforge
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
echo "=== [6/8] npm ci ==="
cd "$REPO_DIR"
npm ci --prefer-offline 2>&1 | tail -3

# ── 7. Build all packages ─────────────────────────────────────────────────
echo "=== [7/8] Build ==="
npm run build --workspace=@flowforge/engine 2>&1 | tail -1
npm run build --workspace=@flowforge/server 2>&1 | tail -1
npm run build --workspace=@flowforge/ui 2>&1 | tail -1
echo "  build complete"

# ── 8. Start / restart services ────────────────────────────────────────────
echo "=== [8/8] Start services ==="
sudo nginx -t 2>&1
sudo systemctl reload nginx
echo "  nginx: reloaded"

sudo systemctl restart flowforge
echo "  flowforge: restarted"

# Health check — wait up to 15 seconds
echo "Waiting for health check..."
for i in $(seq 1 15); do
  if curl -sf http://localhost:4023/api/health > /dev/null 2>&1; then
    echo "✅ FlowForge is healthy (attempt $i)"
    echo ""
    echo "Deploy complete: $(git rev-parse --short HEAD) on $(git branch --show-current)"
    exit 0
  fi
  sleep 1
done

echo "❌ Health check failed after 15 seconds"
echo "--- journalctl output ---"
sudo journalctl -u flowforge --no-pager -n 30
exit 1
