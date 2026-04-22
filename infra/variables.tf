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
  description = "EC2 instance ID where Allen runs"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID where everything lives"
  type        = string
}

variable "environment" {
  description = "Environment tag (dev, staging, prod)"
  type        = string
  default     = "dev"
}

variable "listener_rule_priority" {
  description = "ALB listener rule priority (lower = checked first, must not collide with existing rules)"
  type        = number
  default     = 50
}

variable "deploy_version" {
  description = "Bump this to force a redeploy without changing infra"
  type        = string
  default     = "1"
}

variable "app_port" {
  description = "Allen Express API server port"
  type        = number
  default     = 4023
}

variable "ws_port" {
  description = "Allen terminal WebSocket server port"
  type        = number
  default     = 4024
}

variable "docdb_uri" {
  description = "DocumentDB connection URI (including tls and retryWrites params)"
  type        = string
  sensitive   = true
}

variable "master_key" {
  description = "AES-256 master key for at-rest secret encryption (base64-encoded 32 bytes)"
  type        = string
  sensitive   = true
}

# ── Auth secrets ──────────────────────────────────────────────────────────

variable "jwt_access_secret" {
  description = "HS256 signing secret for short-lived access tokens (base64-encoded, >=32 bytes)"
  type        = string
  sensitive   = true
}

variable "jwt_refresh_secret" {
  description = "HS256 signing secret for long-lived refresh tokens (base64-encoded, >=32 bytes, different from access)"
  type        = string
  sensitive   = true
}

variable "admin_email" {
  description = "Email address of the bootstrap admin user. Seeded by bootstrapAdmin on first boot only."
  type        = string
}

variable "admin_password" {
  description = "Initial password for the bootstrap admin. mustResetPassword is forced on first login."
  type        = string
  sensitive   = true
}

variable "access_token_ttl" {
  description = "Access token TTL (any string jsonwebtoken accepts, e.g. '15m', '1d'). Default: 1d."
  type        = string
  default     = "1d"
}

variable "refresh_token_ttl" {
  description = "Refresh token TTL. Default: 7d."
  type        = string
  default     = "7d"
}

variable "repo_url" {
  description = "Git repo URL for Allen"
  type        = string
  default     = "https://github.com/Kalpai-poc/allen.git"
}

variable "repo_branch" {
  description = "Git branch to deploy"
  type        = string
  default     = "main"
}

# ── MCP preset credentials (ALLEN_ prefix convention) ──────────────────────
# Every MCP preset declares which ALLEN_<KEY> env vars it needs. The Allen
# loader strips the prefix and passes <KEY> to the MCP subprocess. All
# default to "" so you can deploy with only the presets you actually use
# filled in; missing ones just mean the corresponding MCP can't be added.

variable "allen_linear_access_token" {
  description = "Linear MCP preset: personal API token (lin_api_...)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "allen_slack_bot_token" {
  description = "Slack MCP + integrations: bot user OAuth token (xoxb-...)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "allen_slack_team_id" {
  description = "Slack MCP preset: workspace team ID (T...)"
  type        = string
  default     = ""
}

variable "allen_slack_signing_secret" {
  description = "Slack webhook signature verification (required for inbound events)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "allen_slack_interventions_channel" {
  description = "Optional channel/DM ID for human-intervention Slack notifications"
  type        = string
  default     = ""
}

variable "allen_github_personal_access_token" {
  description = "GitHub MCP preset: personal access token (ghp_...)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "allen_postgres_connection_string" {
  description = "PostgreSQL MCP preset: full connection string (postgres://...)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "allen_mongodb_connection_string" {
  description = "MongoDB MCP preset: full connection string (mongodb://...)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "allen_oxylabs_username" {
  description = "Oxylabs MCP: realtime API username"
  type        = string
  default     = ""
}

variable "allen_oxylabs_password" {
  description = "Oxylabs MCP: realtime API password"
  type        = string
  sensitive   = true
  default     = ""
}

variable "allen_oxylabs_endpoint" {
  description = "Oxylabs MCP: API endpoint (default https://realtime.oxylabs.io/v1/queries)"
  type        = string
  default     = ""
}

variable "allen_aws_region" {
  description = "AWS MCP: region (default us-east-1)"
  type        = string
  default     = ""
}

variable "allen_aws_access_key_id" {
  description = "AWS MCP: access key ID. If unset, SDK uses the default credential chain."
  type        = string
  sensitive   = true
  default     = ""
}

variable "allen_aws_secret_access_key" {
  description = "AWS MCP: secret access key"
  type        = string
  sensitive   = true
  default     = ""
}

variable "allen_aws_session_token" {
  description = "AWS MCP: optional STS session token (temporary credentials only)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "allen_api_base_url" {
  description = "Pipeline API Server MCP: base URL (default http://localhost:4000)"
  type        = string
  default     = ""
}

variable "allen_api_auth_token" {
  description = "Pipeline API Server MCP: Cognito JWT if the API requires auth"
  type        = string
  sensitive   = true
  default     = ""
}

variable "node_tls_reject_unauthorized" {
  description = "Node.js TLS cert verification flag. '0' disables verification (needed for DocumentDB self-signed certs), '1' or unset enforces strict verification. SECURITY: only disable on trusted networks."
  type        = string
  default     = "1"
}

# ── Agent execution mode ──────────────────────────────────────────────────

variable "allen_agent_execution_mode" {
  description = "How the engine spawns Claude agents: 'cli' uses the global Claude Code binary (required for --agent <name> invocations), 'sdk' uses the bundled @anthropic-ai/claude-code SDK. Default: 'sdk'."
  type        = string
  default     = ""
}

variable "claude_bin" {
  description = "Absolute path to the global Claude Code binary with --agent support. Needed when running under npm scripts because `which claude` resolves to node_modules/.bin/claude (bundled SDK CLI without --agent). Leave empty to let the engine auto-detect via PATH. Value differs between local dev and the EC2 instance — set per-environment."
  type        = string
  default     = ""
}
