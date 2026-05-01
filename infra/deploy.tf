# ── Application deployment via SSM ──
# 1. Stores rendered configs in SSM Parameter Store (EC2 can read via AmazonSSMReadOnlyAccess)
# 2. SSM command on EC2: pulls configs from Parameter Store, clones/pulls repo, runs bootstrap
# 3. Polls for completion, streams output every 15s

# Store nginx config in SSM Parameter Store
resource "aws_ssm_parameter" "nginx_config" {
  name  = "/allen/${var.environment}/nginx-config"
  type  = "String"
  value = templatefile("${path.module}/templates/nginx.conf.tftpl", { domain = var.domain })
  tags  = local.tags
}

# Store .env.production in SSM Parameter Store (encrypted)
resource "aws_ssm_parameter" "env_production" {
  name  = "/allen/${var.environment}/env-production"
  type  = "SecureString"
  value = templatefile("${path.module}/templates/env.production.tftpl", {
    port               = var.app_port
    ws_port            = var.ws_port
    domain             = var.domain
    docdb_uri          = var.docdb_uri
    master_key         = var.master_key
    jwt_access_secret  = var.jwt_access_secret
    jwt_refresh_secret = var.jwt_refresh_secret
    access_token_ttl   = var.access_token_ttl
    refresh_token_ttl  = var.refresh_token_ttl
    admin_email        = var.admin_email
    admin_password     = var.admin_password

    # MCP preset credentials — flow into the EC2 runtime .env via SSM
    # Parameter Store. All optional (default "" in variables.tf); empty
    # values produce empty lines in .env which Allen's loader treats as
    # "ALLEN_<KEY> not set" → the corresponding MCP simply can't be added.
    allen_linear_access_token          = var.allen_linear_access_token
    allen_slack_bot_token              = var.allen_slack_bot_token
    allen_slack_team_id                = var.allen_slack_team_id
    allen_slack_signing_secret         = var.allen_slack_signing_secret
    allen_slack_interventions_channel  = var.allen_slack_interventions_channel
    allen_github_personal_access_token = var.allen_github_personal_access_token
    allen_postgres_connection_string   = var.allen_postgres_connection_string
    allen_mongodb_connection_string    = var.allen_mongodb_connection_string
    allen_oxylabs_username             = var.allen_oxylabs_username
    allen_oxylabs_password             = var.allen_oxylabs_password
    allen_oxylabs_endpoint             = var.allen_oxylabs_endpoint
    allen_opensearch_endpoint          = var.allen_opensearch_endpoint
    allen_opensearch_username          = var.allen_opensearch_username
    allen_opensearch_password          = var.allen_opensearch_password
    allen_opensearch_ssl_reject_unauthorized = var.allen_opensearch_ssl_reject_unauthorized
    allen_aws_region                   = var.allen_aws_region
    allen_aws_access_key_id            = var.allen_aws_access_key_id
    allen_aws_secret_access_key        = var.allen_aws_secret_access_key
    allen_aws_session_token            = var.allen_aws_session_token
    allen_api_base_url                 = var.allen_api_base_url
    allen_api_auth_token               = var.allen_api_auth_token

    # Node.js TLS verification flag — global, not MCP-specific
    node_tls_reject_unauthorized       = var.node_tls_reject_unauthorized

    # Agent execution mode + Claude binary path
    allen_agent_execution_mode         = var.allen_agent_execution_mode
    claude_bin                         = var.claude_bin

    # Logging
    log_level                     = var.log_level
    log_format                    = var.log_format
    enable_cloudwatch_logs        = var.enable_cloudwatch_logs
    cloudwatch_log_retention_days = var.cloudwatch_log_retention_days
    environment                   = var.environment
  })
  tags = local.tags
}

resource "null_resource" "deploy_app" {
  triggers = {
    instance_id    = var.instance_id
    domain         = var.domain
    deploy_version = var.deploy_version
    app_port       = var.app_port
    ws_port        = var.ws_port
    nginx_version  = aws_ssm_parameter.nginx_config.version
    env_version    = aws_ssm_parameter.env_production.version
  }

  depends_on = [
    aws_lb_listener_rule.allen,
    aws_lb_target_group_attachment.allen,
    aws_ssm_parameter.nginx_config,
    aws_ssm_parameter.env_production,
  ]

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = <<-SCRIPT
      set -euo pipefail

      echo "Sending deploy command to EC2 ${var.instance_id}..."
      COMMAND_ID=$(aws ssm send-command \
        --instance-ids "${var.instance_id}" \
        --document-name "AWS-RunShellScript" \
        --timeout-seconds 600 \
        --comment "Allen deploy v${var.deploy_version}" \
        --parameters 'commands=[
          "#!/bin/bash",
          "set -euo pipefail",
          "echo === Pulling configs from SSM Parameter Store ===",
          "aws ssm get-parameter --name /allen/${var.environment}/nginx-config --query Parameter.Value --output text > /tmp/allen-nginx.conf",
          "aws ssm get-parameter --name /allen/${var.environment}/env-production --with-decryption --query Parameter.Value --output text > /tmp/allen-env",
          "echo === Cloning repo if needed ===",
          "if [ ! -d /home/ubuntu/allen/.git ]; then sudo mkdir -p /home/ubuntu/allen && sudo chown ubuntu:ubuntu /home/ubuntu/allen && sudo -u ubuntu git clone ${var.repo_url} /home/ubuntu/allen; fi",
          "cd /home/ubuntu/allen && sudo -u ubuntu git fetch origin && sudo -u ubuntu git checkout ${var.repo_branch} && sudo -u ubuntu git reset --hard origin/${var.repo_branch}",
          "echo === Running bootstrap ===",
          "cd /home/ubuntu/allen && export REPO_URL=${var.repo_url} BRANCH=${var.repo_branch} ENV=${var.environment} ENABLE_CLOUDWATCH_LOGS=${var.enable_cloudwatch_logs} CLOUDWATCH_LOG_RETENTION_DAYS=${var.cloudwatch_log_retention_days} && sudo -u ubuntu -E bash infra/templates/bootstrap.sh 2>&1 | tee /tmp/allen-deploy.log"
        ]' \
        --query 'Command.CommandId' --output text)

      echo "SSM Command ID: $COMMAND_ID"
      echo ""
      echo "=== Streaming deploy logs (polling every 15s) ==="
      LAST_LEN=0
      for i in $(seq 1 40); do
        sleep 15

        STATUS=$(aws ssm get-command-invocation \
          --command-id "$COMMAND_ID" \
          --instance-id "${var.instance_id}" \
          --query 'Status' --output text 2>/dev/null || echo "Pending")

        OUTPUT=$(aws ssm get-command-invocation \
          --command-id "$COMMAND_ID" \
          --instance-id "${var.instance_id}" \
          --query 'StandardOutputContent' --output text 2>/dev/null || echo "")

        CUR_LEN=$${#OUTPUT}
        if [ "$CUR_LEN" -gt "$LAST_LEN" ]; then
          echo "$OUTPUT" | tail -c +$((LAST_LEN + 1))
          LAST_LEN=$CUR_LEN
        fi

        if [ "$STATUS" = "Success" ] || [ "$STATUS" = "Failed" ] || [ "$STATUS" = "Cancelled" ]; then
          break
        fi
      done

      echo ""
      echo "=== Final status: $STATUS ==="

      if [ "$STATUS" = "Success" ]; then
        echo "Deploy succeeded"
      else
        echo "Deploy FAILED"
        echo "--- stderr ---"
        aws ssm get-command-invocation \
          --command-id "$COMMAND_ID" \
          --instance-id "${var.instance_id}" \
          --query 'StandardErrorContent' --output text 2>/dev/null || true
        exit 1
      fi
    SCRIPT
  }
}
