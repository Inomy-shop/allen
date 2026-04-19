# Terraform Plan: Allen on AWS (allen.inomy.ai)

## Context

Deploy Allen to existing EC2 `i-086efc3e8ad92eb7f` (private subnet), route `allen.inomy.ai` through the existing ALB used by the Inomy ECS cluster. Both frontend and backend run on the single EC2. Deploy via a shell script on the box triggered by GitHub Actions via SSM. MongoDB via existing DocumentDB cluster.

## Discovered Infrastructure

```
Account:     257394465633 | Region: us-east-1
VPC:         vpc-033eec7eb19e904f0  (InomyApiVpc-dev, 192.168.0.0/16)

ALB:         InomyA-ApiSe-7LeVvZDFml8I  (internet-facing)
  ARN:       arn:...:loadbalancer/app/InomyA-ApiSe-7LeVvZDFml8I/7bc0ff09e912f0c1
  DNS:       InomyA-ApiSe-7LeVvZDFml8I-1301470003.us-east-1.elb.amazonaws.com
  SG:        sg-0ccc5623161e50493
  Subnets:   subnet-07272dc01d26c9e76 (1b), subnet-0c6cea4839e219f62 (1a)
  Listener:  HTTPS:443, cert: api.dev.inomy.shop
  Rules:     marketing.inomy.shop (p100), default → Inomy API

EC2:         i-086efc3e8ad92eb7f  (t3.large, running)
  IP:        192.168.3.140 (private, no public)
  Subnet:    subnet-0e29fdfa9efde3c0d (private, us-east-1b)
  SG:        sg-0d65b89f1c8fe1ba1 (allows TCP 3001 from API server SG)

DocumentDB:  es-pipeline-dev-docdb-cluster
  Endpoint:  es-pipeline-dev-docdb-cluster.cluster-c980k0oqiox4.us-east-1.docdb.amazonaws.com:27017
  Engine:    5.0.0
  SG:        sg-0dd9e489d1d90e62b (already allows EC2's SG ✓)

DNS:         inomy.shop managed at GoDaddy. No allen.inomy.ai zone yet.
ACM:         No cert for allen.inomy.ai yet.
```

## Workspace Preview — Shareable URLs via Subdomains

Each workspace gets a public URL that anyone can open:

```
https://<workspace-id>.allen.inomy.ai
```

Full interactivity: HMR, WebSockets, forms, navigation — works exactly like opening `localhost:15237` directly. Shareable with teammates, clients, or for testing on other devices.

### How it works

```
Friend opens: https://abc123.allen.inomy.ai
  │
  ▼
DNS: *.allen.inomy.ai → ALB  (wildcard A record)
  │
  ▼
ALB (HTTPS:443)
  cert: *.allen.inomy.ai     (wildcard ACM cert)
  rule: *.allen.inomy.ai → allen-dev-tg
  │
  ▼
nginx :80  (catches *.allen.inomy.ai)
  extracts subdomain "abc123"
  proxy_pass → http://127.0.0.1:4023/api/workspaces/abc123/preview/
  │
  ▼
Express :4023
  createWorkspaceProxy() → looks up workspace abc123
  proxy_pass → http://localhost:15237
  │
  ▼
Workspace dev server :15237  (Vite, Next.js, etc.)
  responds with full app (HTML, JS, CSS, HMR WebSocket)
```

### What changes vs. the base plan

| Component | Base plan | With shareable previews |
|---|---|---|
| **ACM cert** | `allen.inomy.ai` only | `allen.inomy.ai` + `*.allen.inomy.ai` (SAN) |
| **Route53** | 1 A record | 2 A records (apex + wildcard) |
| **ALB rule** | host = `allen.inomy.ai` | host = `allen.inomy.ai` OR `*.allen.inomy.ai` |
| **nginx** | 1 server block | 2 server blocks (main app + wildcard workspace proxy) |
| **Express** | existing `createWorkspaceProxy` on `/api/workspaces/:id/preview` | same — nginx rewrites the subdomain request to hit this path |

### nginx workspace proxy block (added alongside the main server block)

```nginx
# Workspace preview subdomains: <workspace-id>.allen.inomy.ai
# Proxies to Express which handles the workspace → port resolution internally.
server {
    listen 80;
    server_name ~^(?<workspace_id>[a-f0-9]+)\.allen\.inomy\.shop$;

    location / {
        # Rewrite to the existing workspace preview path on Express
        proxy_pass http://127.0.0.1:4023/api/workspaces/$workspace_id/preview/$request_uri;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket support (needed for Vite HMR, Next.js fast refresh, etc.)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 86400s;

        # No buffering — streaming/SSE/HMR needs this
        proxy_buffering off;
    }
}
```

---

## Allen Port Map (all services on the EC2)

| Port | Service | Protocol | Description |
|---|---|---|---|
| **80** | nginx | HTTP | Entry point from ALB. Reverse-proxies everything below. |
| **4023** | Express API server | HTTP | REST API + SSE streaming + workspace preview proxy |
| **4024** | Terminal + File watcher WebSocket | WS | Dedicated WebSocket server for workspace terminals and file watching |
| **15000-19999** | Workspace preview services | HTTP | Dynamic per-workspace (10 ports each). Proxied INTERNALLY by Express on 4023 via `/api/workspaces/:id/preview/*` — browser never hits these directly. |

**Key insight: The browser only uses 2 URL prefixes:**
- `/api/*` → everything HTTP (API calls, SSE streams, workspace preview proxying)
- `/ws/*` → WebSocket connections (terminal, file watcher)

Both use `window.location.host` as the base, so they go through the same nginx on port 80. The dynamic workspace ports (15000+) are **internal to Express** — the `createWorkspaceProxy` middleware handles `localhost:15xxx` routing; nginx and the ALB never see them.

**Therefore: ALB only needs to reach port 80. One SG rule covers the entire application.**

### Workspace Preview — how it works through nginx

The workspace preview renders in an iframe in the browser. The full request flow:

```
Browser iframe → src="/api/workspaces/:id/preview?service=vite"
  → nginx /api/* → proxy_pass 127.0.0.1:4023
    → Express catches /api/workspaces/:id/preview via createWorkspaceProxy()
      → Looks up workspace → finds service port (e.g., 15237)
      → http-proxy-middleware → http://localhost:15237
        → Workspace dev server (Vite, Next.js, etc.) responds
          → Back through the chain → rendered in the iframe
```

The browser **never** connects to port 15000+ directly. The iframe `src` is an `/api/*` path, which nginx handles like any other API request. Express does the internal proxying. No extra nginx rules or ALB config needed — it just works.

### Port restriction 15000-20000

The EC2 security group already blocks all inbound traffic except port 80 (ALB) and port 3001 (API server). So workspace ports 15000-20000 are externally unreachable. For defense-in-depth (block VPC-internal traffic too), add an iptables rule on the EC2:

```bash
# Block all non-localhost access to workspace dynamic ports
sudo iptables -A INPUT -p tcp --dport 15000:20000 ! -s 127.0.0.1 -j DROP
# Persist across reboots
sudo apt install -y iptables-persistent
sudo iptables-save | sudo tee /etc/iptables/rules.v4
```

This ensures workspace services are ONLY reachable from Express on localhost, even if the SG is accidentally loosened in the future.

## Architecture

```
GoDaddy:  allen.inomy.ai NS → Route53 zone (4 NS records)
Route53:  allen.inomy.ai A  → ALB (alias)

ALB (HTTPS:443)
  ├── Host: allen.inomy.ai → allen-dev-tg (NEW, p50)
  ├── Host: marketing.inomy.shop → marketing TG    (existing, p100)
  └── Default → Inomy API TG                       (existing)

allen-dev-tg (port 80, instance type)
  └── EC2 i-086efc3e8ad92eb7f (192.168.3.140)

        nginx :80  ←─── only port exposed to ALB
        ├── /              → static files from packages/ui/dist (SPA fallback)
        ├── /api/*         → proxy_pass http://127.0.0.1:4023 (Express API)
        │                    ├── /api/health             (ALB health check)
        │                    ├── /api/chat/sessions/*/stream (SSE, proxy_buffering off)
        │                    ├── /api/slack/events       (Slack webhook)
        │                    ├── /api/workspaces/*/preview/* (internal proxy → localhost:15000+)
        │                    └── all other /api routes
        └── /ws/*          → proxy_pass ws://127.0.0.1:4024 (WebSocket)
                             ├── /ws/workspaces/:id/terminal/:termId
                             └── /ws/file-watch (file change events)

        Allen server :4023  ←─── only reachable from nginx (127.0.0.1)
        Terminal WS :4024       ←─── only reachable from nginx (127.0.0.1)
        Workspace services :15000-19999  ←─── only reachable from Express (127.0.0.1)

        DocumentDB :27017 (via private VPC network, SG already allows ✓)
```

---

## Blast Radius Analysis — Impact on Existing Services

**CRITICAL: Every change below is ADDITIVE. No existing resource is modified or deleted.**

| # | Resource | Type | Touches existing? | Impact on Inomy API / marketing.inomy.shop |
|---|----------|------|-------------------|-------------------------------------------|
| 1 | Route53 zone `allen.inomy.ai` | **NEW** | ❌ No | None. Brand-new hosted zone. No existing zones touched. |
| 2 | ACM cert `allen.inomy.ai` | **NEW** | ❌ No | None. New cert, doesn't modify `api.dev.inomy.shop` cert. |
| 3 | ALB listener cert attachment | **ADD to existing** | ⚠️ Yes — adds a secondary cert to the HTTPS listener | **SAFE:** ALB supports multiple certs via SNI. The existing `api.dev.inomy.shop` cert stays as the default. The new cert is a secondary. No listener config changes. No downtime. |
| 4 | Target group `allen-dev-tg` | **NEW** | ❌ No | None. New TG with its own name. `InomyA-ApiSe-C4SYHKCDO3FA` and `inomy-marketing-dev-tg` are untouched. |
| 5 | ALB listener rule (priority 50) | **ADD to existing** | ⚠️ Yes — adds a new rule to the HTTPS listener | **SAFE:** host-header match for `allen.inomy.ai` ONLY. Traffic to `api.dev.inomy.shop` (default rule) and `marketing.inomy.shop` (p100) is unaffected because host headers don't match. Rule is purely additive — no existing rules are reordered or modified. |
| 6 | SG rule on EC2's SG | **ADD to existing** | ⚠️ Yes — adds an ingress rule to `sg-0d65b89f1c8fe1ba1` | **SAFE:** adds TCP port 80 from ALB's SG. The existing rule (TCP 3001 from `sg-02c7f1ce324ce0ab2`) is untouched. The `es-pipeline-dev-self-healing` service on port 3001 continues to work. |
| 7 | Route53 A record `allen.inomy.ai` | **NEW** | ❌ No | None. Created inside the new zone from step 1. |

**What is NOT touched (read-only via `data` sources):**
- ❌ The ALB itself — no modification to the load balancer resource
- ❌ The existing HTTPS listener — no change to default action, cert, or protocol
- ❌ The existing target groups (`InomyA-ApiSe-C4SYHKCDO3FA`, `inomy-marketing-dev-tg`)
- ❌ The ECS cluster or any ECS services
- ❌ The existing Route53 zones (`marketing.inomy.shop`, `es-datapipeline.inomy.shop`, etc.)
- ❌ The EC2 instance itself (no reboot, no AMI change, no instance profile change)
- ❌ DocumentDB cluster config (only creating a new database inside it)

**Rollback plan:** `terraform destroy` removes all 7 resources cleanly. The ALB reverts to its previous state (2 rules instead of 3, 1 cert instead of 2). Zero impact on existing services.

**EC2 side (non-Terraform, manual):**
- nginx on port 80 — new process, new port. Does NOT conflict with existing self-healing agent on port 3001.
- Allen on port 4023, Terminal WS on 4024 — new processes, new ports. No conflicts.
- Workspace dynamic ports 15000-19999 — new, internal only. No conflicts.
- DocumentDB: new `allen` database. Existing databases untouched. Same cluster, different database name.

---

## Terraform Resources (7 new + 3 data sources)

### Folder structure

```
infra/
│
├── main.tf                      # provider, locals, data sources (read-only existing infra)
├── variables.tf                 # all configurable values with types + defaults
├── terraform.tfvars             # actual values — GITIGNORED
│
├── dns.tf                       # Route53 hosted zone + A record (alias → ALB)
├── cert.tf                      # ACM certificate + DNS validation records
├── alb.tf                       # target group + attachment + listener rule + cert attachment
├── security.tf                  # SG ingress rule (ALB → EC2 port 80)
│
├── deploy.tf                    # null_resource that SSM-deploys the app to EC2
│                                  runs AFTER infra is created (depends_on)
│                                  sends bootstrap.sh to EC2 via aws ssm send-command
│                                  waits for completion before terraform finishes
│
├── templates/                   # config files pushed to the EC2 during deploy
│   ├── bootstrap.sh             # one-shot EC2 setup: install nginx + node, clone repo,
│   │                              write configs, build, start. Idempotent — safe to re-run.
│   ├── nginx.conf.tftpl         # nginx config (templated — ${domain} substituted)
│   ├── allen.service        # systemd unit file (static)
│   └── env.production.tftpl     # .env (templated — ${docdb_uri}, ${master_key} substituted)
│
├── outputs.tf                   # NS records for GoDaddy, cert ARN, TG ARN, domain
└── .gitignore                   # terraform.tfvars, *.tfstate*, .terraform/
```

### How `terraform apply` deploys end-to-end

```
terraform apply
│
├── Phase 1: Infrastructure (parallel)
│   ├── Route53 zone → created
│   ├── ACM cert → created (pending validation)
│   ├── SG rule → created
│   └── (blocks until DNS is delegated at GoDaddy + cert validates)
│
├── Phase 2: ALB wiring (after cert validates)
│   ├── Listener cert attachment → created
│   ├── Target group + attachment → created
│   └── Listener rule (host-header) → created
│
└── Phase 3: Application deploy (after ALB wiring)
    └── null_resource.deploy_app
        ├── Renders templates (nginx.conf, .env, systemd)
        ├── aws ssm send-command → EC2
        │   └── bootstrap.sh runs on the EC2:
        │       ├── Install nginx, Node.js 20 (if not present)
        │       ├── git clone / git pull (https://github.com/Kalpai-poc/flowforge)
        │       ├── git checkout main
        │       ├── Write nginx.conf, .env.production, allen.service
        │       ├── Download DocumentDB CA cert
        │       ├── Set iptables rules (block 15000-20000 externally)
        │       ├── npm ci && npm run build (engine, server, ui)
        │       ├── systemctl enable + start allen
        │       ├── systemctl reload nginx
        │       └── curl localhost:4023/api/health → verify
        └── terraform waits for SSM command to complete
```

### `deploy.tf` — the glue between infra and app

```hcl
resource "null_resource" "deploy_app" {
  # Re-deploy when any of these change
  triggers = {
    instance_id = var.instance_id
    domain      = var.domain
    # Bump this to force a redeploy without changing infra
    deploy_version = var.deploy_version
  }

  # Wait for ALB wiring to be ready before deploying
  depends_on = [
    aws_lb_listener_rule.allen,
    aws_lb_target_group_attachment.allen,
    aws_security_group_rule.alb_to_allen,
  ]

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = <<-SCRIPT
      set -euo pipefail

      # Render templates
      NGINX_CONF=$(cat <<'NGINX'
      ${templatefile("${path.module}/templates/nginx.conf.tftpl", {
        domain = var.domain
      })}
      NGINX
      )

      ENV_FILE=$(cat <<'ENV'
      ${templatefile("${path.module}/templates/env.production.tftpl", {
        port        = var.app_port
        ws_port     = var.ws_port
        docdb_uri   = var.docdb_uri
        master_key  = var.master_key
      })}
      ENV
      )

      # Send bootstrap script + configs to EC2 via SSM
      COMMAND_ID=$(aws ssm send-command \
        --instance-ids "${var.instance_id}" \
        --document-name "AWS-RunShellScript" \
        --timeout-seconds 600 \
        --parameters "commands=[
          \"bash -c 'cat > /tmp/allen-nginx.conf << ENDNGINX\n$${NGINX_CONF}\nENDNGINX'\",
          \"bash -c 'cat > /tmp/allen-env << ENDENV\n$${ENV_FILE}\nENDENV'\",
          \"sudo -u ubuntu bash /opt/allen/infra/templates/bootstrap.sh 2>&1 | tee /tmp/allen-bootstrap.log\"
        ]" \
        --query 'Command.CommandId' --output text)

      echo "SSM Command: $COMMAND_ID"

      # Wait for completion (up to 10 minutes)
      aws ssm wait command-executed \
        --command-id "$COMMAND_ID" \
        --instance-id "${var.instance_id}" || true

      # Check result
      STATUS=$(aws ssm get-command-invocation \
        --command-id "$COMMAND_ID" \
        --instance-id "${var.instance_id}" \
        --query 'Status' --output text)

      if [ "$STATUS" != "Success" ]; then
        echo "Deploy FAILED (status: $STATUS)"
        aws ssm get-command-invocation \
          --command-id "$COMMAND_ID" \
          --instance-id "${var.instance_id}" \
          --query 'StandardErrorContent' --output text
        exit 1
      fi

      echo "Deploy succeeded"
    SCRIPT
  }
}
```

### `templates/bootstrap.sh` — idempotent EC2 setup + deploy

```bash
#!/bin/bash
set -euo pipefail

REPO_DIR=/opt/allen
REPO_URL=https://github.com/Kalpai-poc/flowforge.git
BRANCH=main

echo "=== [1/8] Install system deps ==="
if ! command -v nginx &>/dev/null; then
  sudo apt update && sudo apt install -y nginx iptables-persistent
fi
if ! command -v node &>/dev/null || [[ "$(node -v)" < "v20" ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
fi

echo "=== [2/8] Clone or pull repo ==="
if [ ! -d "$REPO_DIR/.git" ]; then
  sudo mkdir -p "$REPO_DIR"
  sudo chown ubuntu:ubuntu "$REPO_DIR"
  git clone "$REPO_URL" "$REPO_DIR"
fi
cd "$REPO_DIR"
git fetch origin
git checkout "$BRANCH"
git pull origin "$BRANCH"

echo "=== [3/8] Write configs ==="
# nginx (rendered by Terraform, placed at /tmp by SSM)
sudo cp /tmp/allen-nginx.conf /etc/nginx/sites-available/allen
sudo ln -sf /etc/nginx/sites-available/allen /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

# .env.production (rendered by Terraform)
cp /tmp/allen-env "$REPO_DIR/.env.production"
chmod 600 "$REPO_DIR/.env.production"

# systemd service
sudo cp "$REPO_DIR/infra/templates/allen.service" \
        /etc/systemd/system/allen.service
sudo systemctl daemon-reload
sudo systemctl enable allen

echo "=== [4/8] Download DocumentDB CA cert ==="
if [ ! -f "$REPO_DIR/rds-combined-ca-bundle.pem" ]; then
  wget -q -O "$REPO_DIR/rds-combined-ca-bundle.pem" \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
fi

echo "=== [5/8] iptables — restrict workspace ports 15000-20000 ==="
if ! sudo iptables -C INPUT -p tcp --dport 15000:20000 ! -s 127.0.0.1 -j DROP 2>/dev/null; then
  sudo iptables -A INPUT -p tcp --dport 15000:20000 ! -s 127.0.0.1 -j DROP
  sudo iptables-save | sudo tee /etc/iptables/rules.v4 > /dev/null
fi

echo "=== [6/8] Install dependencies ==="
npm ci

echo "=== [7/8] Build ==="
npm run build --workspace=@allen/engine
npm run build --workspace=@allen/server
npm run build --workspace=@allen/ui

echo "=== [8/8] Start services ==="
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl restart allen

sleep 5
if curl -sf http://localhost:4023/api/health > /dev/null; then
  echo "✅ Allen is healthy"
else
  echo "❌ Health check failed"
  sudo journalctl -u allen --no-pager -n 20
  exit 1
fi
```

### `templates/nginx.conf.tftpl`

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name ${domain};

    root /opt/allen/packages/ui/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:4023;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        proxy_buffering off;
        proxy_cache off;
    }

    location /ws/ {
        proxy_pass http://127.0.0.1:4024;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400s;
    }
}
```

### `templates/env.production.tftpl`

```
PORT=${port}
TERMINAL_WS_PORT=${ws_port}
MONGODB_URI=${docdb_uri}
ALLEN_MASTER_KEY=${master_key}
```

### `templates/allen.service`

```ini
[Unit]
Description=Allen Server
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/allen/packages/server
EnvironmentFile=/opt/allen/.env.production
ExecStart=/usr/bin/node dist/app.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### Updated `variables.tf` (additional deploy vars)

Add these to the existing variables:

```hcl
variable "deploy_version" {
  description = "Bump this to force a redeploy without changing infra"
  type        = string
  default     = "1"
}

variable "app_port" {
  description = "Allen API server port"
  type        = number
  default     = 4023
}

variable "ws_port" {
  description = "Allen terminal WebSocket port"
  type        = number
  default     = 4024
}

variable "docdb_uri" {
  description = "DocumentDB connection URI (with TLS params)"
  type        = string
  sensitive   = true
}

variable "master_key" {
  description = "AES-256 master key for secret encryption (base64, 32 bytes)"
  type        = string
  sensitive   = true
}
```

### Updated `terraform.tfvars`

```hcl
domain         = "allen.inomy.ai"
alb_arn        = "arn:aws:elasticloadbalancing:us-east-1:257394465633:loadbalancer/app/InomyA-ApiSe-7LeVvZDFml8I/7bc0ff09e912f0c1"
instance_id    = "i-086efc3e8ad92eb7f"
vpc_id         = "vpc-033eec7eb19e904f0"
environment    = "dev"
deploy_version = "1"
docdb_uri      = "mongodb://allen_user:PASSWORD@es-pipeline-dev-docdb-cluster.cluster-c980k0oqiox4.us-east-1.docdb.amazonaws.com:27017/allen?tls=true&tlsCAFile=/opt/allen/rds-combined-ca-bundle.pem&retryWrites=false&directConnection=true"
master_key     = "<generate: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\">"
```

### File: `infra/main.tf`

```hcl
terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region = "us-east-1"
}

# ── Existing resources (read-only) ──

data "aws_lb" "inomy" {
  arn = "arn:aws:elasticloadbalancing:us-east-1:257394465633:loadbalancer/app/InomyA-ApiSe-7LeVvZDFml8I/7bc0ff09e912f0c1"
}

data "aws_lb_listener" "https" {
  load_balancer_arn = data.aws_lb.inomy.arn
  port              = 443
}

data "aws_instance" "allen" {
  instance_id = "i-086efc3e8ad92eb7f"
}
```

### File: `infra/variables.tf`

```hcl
variable "domain" {
  description = "Domain name for Allen"
  type        = string
  default     = "allen.inomy.ai"
}

variable "alb_arn" {
  description = "ARN of the existing ALB"
  type        = string
}

variable "instance_id" {
  description = "EC2 instance ID for Allen"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID where everything lives"
  type        = string
}

variable "environment" {
  description = "Environment tag"
  type        = string
  default     = "dev"
}

variable "listener_rule_priority" {
  description = "Priority for the ALB listener rule (lower = checked first)"
  type        = number
  default     = 50
}
```

### File: `infra/terraform.tfvars` (GITIGNORED)

```hcl
domain      = "allen.inomy.ai"
alb_arn     = "arn:aws:elasticloadbalancing:us-east-1:257394465633:loadbalancer/app/InomyA-ApiSe-7LeVvZDFml8I/7bc0ff09e912f0c1"
instance_id = "i-086efc3e8ad92eb7f"
vpc_id      = "vpc-033eec7eb19e904f0"
environment = "dev"
```

### File: `infra/dns.tf`

```hcl
resource "aws_route53_zone" "allen" {
  name    = var.domain
  comment = "Allen ${var.environment} — managed by Terraform"
  tags    = local.tags
}

resource "aws_route53_record" "allen" {
  zone_id = aws_route53_zone.allen.zone_id
  name    = var.domain
  type    = "A"

  alias {
    name                   = data.aws_lb.inomy.dns_name
    zone_id                = data.aws_lb.inomy.zone_id
    evaluate_target_health = true
  }
}
```

### File: `infra/cert.tf`

```hcl
resource "aws_acm_certificate" "allen" {
  domain_name       = var.domain
  validation_method = "DNS"
  tags              = local.tags
  lifecycle { create_before_destroy = true }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.allen.domain_validation_options :
    dvo.domain_name => {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  }

  zone_id = aws_route53_zone.allen.zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.value]
  ttl     = 60
}

resource "aws_acm_certificate_validation" "allen" {
  certificate_arn         = aws_acm_certificate.allen.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}
```

### File: `infra/alb.tf`

```hcl
# Attach cert to ALB HTTPS listener (SNI — additive, doesn't change existing cert)
resource "aws_lb_listener_certificate" "allen" {
  listener_arn    = data.aws_lb_listener.https.arn
  certificate_arn = aws_acm_certificate_validation.allen.certificate_arn
}

# Target Group (instance type, port 80 → nginx on the EC2)
resource "aws_lb_target_group" "allen" {
  name        = "allen-${var.environment}-tg"
  port        = 80
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "instance"

  health_check {
    path                = "/api/health"
    port                = "traffic-port"
    protocol            = "HTTP"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 10
    interval            = 30
    matcher             = "200"
  }

  stickiness {
    type            = "lb_cookie"
    cookie_duration = 86400
    enabled         = true
  }

  tags = local.tags
}

resource "aws_lb_target_group_attachment" "allen" {
  target_group_arn = aws_lb_target_group.allen.arn
  target_id        = var.instance_id
  port             = 80
}

# Host-header routing rule — ONLY fires for allen.inomy.ai
resource "aws_lb_listener_rule" "allen" {
  listener_arn = data.aws_lb_listener.https.arn
  priority     = var.listener_rule_priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.allen.arn
  }

  condition {
    host_header {
      values = [var.domain]
    }
  }
}
```

### File: `infra/security.tf`

```hcl
# Allow ALB to reach the EC2 on port 80 (nginx).
# ADDITIVE — does NOT touch the existing port 3001 rule.
resource "aws_security_group_rule" "alb_to_allen" {
  type                     = "ingress"
  from_port                = 80
  to_port                  = 80
  protocol                 = "tcp"
  source_security_group_id = tolist(data.aws_lb.inomy.security_groups)[0]
  security_group_id        = tolist(data.aws_instance.allen.vpc_security_group_ids)[0]
  description              = "Allow ALB to reach Allen nginx on port 80"
}
```

### File: `infra/outputs.tf`

```hcl
output "ns_records_for_godaddy" {
  description = "Add these as NS records for 'allen' subdomain at GoDaddy"
  value       = aws_route53_zone.allen.name_servers
}

output "acm_cert_arn" {
  value = aws_acm_certificate.allen.arn
}

output "target_group_arn" {
  value = aws_lb_target_group.allen.arn
}

output "alb_dns" {
  value = data.aws_lb.inomy.dns_name
}

output "domain" {
  value = var.domain
}
```

### Updated `main.tf` with locals

```hcl
terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region = "us-east-1"
}

locals {
  tags = {
    Project     = "allen"
    Environment = var.environment
    ManagedBy   = "Terraform"
  }
}

# ── Existing resources (read-only, NOT modified) ──

data "aws_lb" "inomy" {
  arn = var.alb_arn
}

data "aws_lb_listener" "https" {
  load_balancer_arn = data.aws_lb.inomy.arn
  port              = 443
}

data "aws_instance" "allen" {
  instance_id = var.instance_id
}
```

---

## EC2 Setup (on the machine itself)

### nginx config: `/etc/nginx/sites-available/allen`

```nginx
# Required for conditional WebSocket upgrade headers
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name allen.inomy.ai;

    # ── Frontend (Vite-built static files) ──
    root /opt/allen/packages/ui/dist;
    index index.html;

    # SPA fallback — all non-API, non-WS routes serve index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # ── API + SSE streams + workspace preview proxy ──
    # All go to Express on port 4023. Express handles:
    #   - REST API (/api/*)
    #   - SSE streaming (/api/chat/sessions/*/stream, /api/executions/*/stream)
    #   - Slack webhook (/api/slack/events)
    #   - Workspace preview reverse-proxy (/api/workspaces/*/preview/* → localhost:15000+)
    location /api/ {
        proxy_pass http://127.0.0.1:4023;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket upgrade support (needed for workspace preview WS connections
        # that go through Express's createWorkspaceProxy middleware)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # Long timeouts — agents can take 10+ minutes, SSE streams run indefinitely
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;

        # SSE streaming requires no buffering
        proxy_buffering off;
        proxy_cache off;
    }

    # ── Terminal + File Watcher WebSockets ──
    # Dedicated WS server on port 4024 handles:
    #   - Terminal sessions: /ws/workspaces/:id/terminal/:termId
    #   - File watcher events: shared on the same WS server
    location /ws/ {
        proxy_pass http://127.0.0.1:4024;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # Keep terminal connections alive for 24 hours
        proxy_read_timeout 86400s;
    }
}
```

```bash
sudo ln -sf /etc/nginx/sites-available/allen /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

### systemd: `/etc/systemd/system/allen.service`

```ini
[Unit]
Description=Allen Server
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/allen/packages/server
EnvironmentFile=/opt/allen/.env.production
ExecStart=/usr/bin/node dist/app.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### env: `/opt/allen/.env.production`

```bash
PORT=4023
TERMINAL_WS_PORT=4024
MONGODB_URI=mongodb://allen_user:PASSWORD@es-pipeline-dev-docdb-cluster.cluster-c980k0oqiox4.us-east-1.docdb.amazonaws.com:27017/allen?tls=true&tlsCAFile=/opt/allen/rds-combined-ca-bundle.pem&retryWrites=false&directConnection=true
ALLEN_MASTER_KEY=<base64-encoded-32-bytes>
```

**DocumentDB notes:**
- Download the AWS RDS CA bundle:
  ```bash
  wget -O /opt/allen/rds-combined-ca-bundle.pem \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
  ```
- `retryWrites=false` is required — DocumentDB doesn't support retryable writes
- `directConnection=true` avoids replica set discovery issues
- Create a DocumentDB user `allen_user` with readWrite on the `allen` database (or use the existing admin user for dev)

### Deploy script: `/opt/allen/deploy.sh`

```bash
#!/bin/bash
set -euo pipefail
cd /opt/allen

echo "=== Pulling latest code ==="
git pull origin main

echo "=== Installing dependencies ==="
npm ci

echo "=== Building ==="
npm run build --workspace=@allen/engine
npm run build --workspace=@allen/server
npm run build --workspace=@allen/ui

echo "=== Restarting server ==="
sudo systemctl restart allen

echo "=== Waiting for health check ==="
sleep 5
curl -sf http://localhost:4023/api/health && echo " ✓ healthy" || echo " ✗ unhealthy"
```

### GitHub Actions deploy via SSM

```yaml
# .github/workflows/deploy-allen.yml
name: Deploy Allen
on:
  workflow_dispatch:
  push:
    branches: [main]
    paths: ['packages/**']

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::257394465633:role/github-deploy-role
          aws-region: us-east-1

      - name: Deploy via SSM
        run: |
          aws ssm send-command \
            --instance-ids i-086efc3e8ad92eb7f \
            --document-name "AWS-RunShellScript" \
            --parameters 'commands=["sudo -u ubuntu bash /opt/allen/deploy.sh 2>&1 | tee /tmp/allen-deploy.log"]' \
            --timeout-seconds 300 \
            --comment "Allen deploy from GitHub Actions"
```

**Prerequisite:** create an IAM role `github-deploy-role` with `ssm:SendCommand` permission on the target instance, and set up GitHub OIDC trust.

---

## Deployment Sequence

### Phase 1: Terraform (first apply — creates Route53 zone)

```bash
cd terraform/allen
terraform init
terraform apply    # Creates Route53 zone, outputs NS records
                   # ACM cert will be PENDING (DNS not yet delegated)
```

### Phase 2: GoDaddy NS delegation (manual, one-time)

1. Log into GoDaddy → DNS management for `inomy.shop`
2. Add NS records for the `allen` subdomain:
   - **Host**: `allen`
   - **Type**: NS
   - **Values**: each of the 4 nameservers from `terraform output ns_records_for_godaddy`
3. Wait 5-30 min for propagation
4. Verify: `dig allen.inomy.ai NS` returns the AWS nameservers

### Phase 3: Terraform (second apply — cert validates, infra completes)

```bash
terraform apply    # ACM cert validates now that DNS resolves
                   # Creates: cert attachment, target group, listener rule, SG rule, A record
```

### Phase 4: EC2 setup (one-time via SSM)

```bash
aws ssm start-session --target i-086efc3e8ad92eb7f

# On the EC2:
sudo apt update && sudo apt install -y nginx

# Install Node.js 20+ (if not already)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Clone Allen
sudo mkdir -p /opt/allen && sudo chown ubuntu:ubuntu /opt/allen
git clone https://github.com/Kalpai-poc/flowforge.git /opt/allen
cd /opt/allen && npm ci

# Download DocumentDB CA cert
wget -O /opt/allen/rds-combined-ca-bundle.pem \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem

# Restrict workspace dynamic ports (15000-20000) to localhost only
sudo iptables -A INPUT -p tcp --dport 15000:20000 ! -s 127.0.0.1 -j DROP
sudo apt install -y iptables-persistent
sudo iptables-save | sudo tee /etc/iptables/rules.v4

# Create .env.production (fill in actual values)
cat > /opt/allen/.env.production << 'EOF'
PORT=4023
TERMINAL_WS_PORT=4024
MONGODB_URI=mongodb://allen_user:PASSWORD@es-pipeline-dev-docdb-cluster.cluster-c980k0oqiox4.us-east-1.docdb.amazonaws.com:27017/allen?tls=true&tlsCAFile=/opt/allen/rds-combined-ca-bundle.pem&retryWrites=false&directConnection=true
ALLEN_MASTER_KEY=<generate-with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))">
EOF

# Set up nginx config (copy from plan above)
sudo nano /etc/nginx/sites-available/allen
sudo ln -sf /etc/nginx/sites-available/allen /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# Set up systemd service (copy from plan above)
sudo nano /etc/systemd/system/allen.service
sudo systemctl daemon-reload
sudo systemctl enable allen

# Build + start
bash /opt/allen/deploy.sh
```

### Phase 5: Verify

```bash
# From your local machine:
curl -I https://allen.inomy.ai/api/health      # → 200 OK
curl -s https://allen.inomy.ai/ | head -5       # → HTML (SPA)

# In the AWS console:
# EC2 → Target Groups → allen-dev-tg → Targets tab → healthy
```

### Phase 6: Update Slack webhook URL (permanent URL, no more ngrok)

In api.slack.com → Event Subscriptions → Request URL:
```
https://allen.inomy.ai/api/slack/events
```

---

## Verification Checklist

- [ ] `dig allen.inomy.ai` resolves to ALB IPs
- [ ] ACM cert status is ISSUED in the AWS console
- [ ] `curl -I https://allen.inomy.ai/api/health` → 200 OK
- [ ] Allen UI loads at `https://allen.inomy.ai`
- [ ] Chat session works (create, send message, get streaming response — tests SSE)
- [ ] Workspace terminal works (open workspace, launch terminal — tests WebSocket /ws/)
- [ ] Workspace preview works (start a service in a workspace — tests internal proxy on 15000+)
- [ ] Slack bot works via `@allen` mention using the permanent URL
- [ ] ALB target group shows instance as healthy in AWS console
- [ ] `es-pipeline-dev-self-healing` service on port 3001 still works (no regression)
- [ ] Inomy API at `api.dev.inomy.shop` still works (no regression)
- [ ] Marketing at `marketing.inomy.shop` still works (no regression)
- [ ] GitHub Actions deploy works: push to `main` → SSM command → Allen restarts
