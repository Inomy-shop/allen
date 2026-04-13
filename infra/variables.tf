variable "domain" {
  description = "Domain name for FlowForge"
  type        = string
  default     = "flowforge.inomy.shop"
}

variable "alb_arn" {
  description = "ARN of the existing ALB"
  type        = string
}

variable "instance_id" {
  description = "EC2 instance ID where FlowForge runs"
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
  description = "FlowForge Express API server port"
  type        = number
  default     = 4023
}

variable "ws_port" {
  description = "FlowForge terminal WebSocket server port"
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
  description = "Git repo URL for FlowForge"
  type        = string
  default     = "https://github.com/Kalpai-poc/flowforge.git"
}

variable "repo_branch" {
  description = "Git branch to deploy"
  type        = string
  default     = "main"
}
