#!/bin/bash
# Local deploy wrapper — loads secrets from .env then runs terraform.
#
# Usage:
#   cd infra
#   ./apply.sh              # terraform apply
#   ./apply.sh plan          # terraform plan (dry run)
#   ./apply.sh destroy       # terraform destroy
#
# Secrets come from infra/.env (TF_VAR_docdb_uri, TF_VAR_master_key).
# Non-sensitive values come from terraform.tfvars (committed to git).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Load secrets from .env
if [ -f .env ]; then
  echo "Loading secrets from .env"
  source .env
else
  echo "ERROR: infra/.env not found. Copy from .env.example and fill in values."
  echo "  cp .env.example .env"
  exit 1
fi

# Verify required secrets are set
REQUIRED_VARS=(
  TF_VAR_docdb_uri
  TF_VAR_master_key
  TF_VAR_jwt_access_secret
  TF_VAR_jwt_refresh_secret
  TF_VAR_admin_email
  TF_VAR_admin_password
)
for v in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!v:-}" ]; then
    echo "ERROR: $v is not set in .env"
    exit 1
  fi
done

# Init if needed
if [ ! -d .terraform ]; then
  echo "Running terraform init..."
  terraform init
fi

# Run terraform with the requested command (default: apply)
CMD="${1:-apply}"
echo "Running: terraform $CMD"
terraform "$CMD"
