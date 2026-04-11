# ── Application deployment via SSM ──
# 1. Stores rendered configs in SSM Parameter Store (EC2 can read via AmazonSSMReadOnlyAccess)
# 2. SSM command on EC2: pulls configs from Parameter Store, clones/pulls repo, runs bootstrap
# 3. Polls for completion, streams output every 15s

# Store nginx config in SSM Parameter Store
resource "aws_ssm_parameter" "nginx_config" {
  name  = "/flowforge/${var.environment}/nginx-config"
  type  = "String"
  value = templatefile("${path.module}/templates/nginx.conf.tftpl", { domain = var.domain })
  tags  = local.tags
}

# Store .env.production in SSM Parameter Store (encrypted)
resource "aws_ssm_parameter" "env_production" {
  name  = "/flowforge/${var.environment}/env-production"
  type  = "SecureString"
  value = templatefile("${path.module}/templates/env.production.tftpl", {
    port       = var.app_port
    ws_port    = var.ws_port
    docdb_uri  = var.docdb_uri
    master_key = var.master_key
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
    aws_lb_listener_rule.flowforge,
    aws_lb_target_group_attachment.flowforge,
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
        --comment "FlowForge deploy v${var.deploy_version}" \
        --parameters 'commands=[
          "#!/bin/bash",
          "set -euo pipefail",
          "echo === Pulling configs from SSM Parameter Store ===",
          "aws ssm get-parameter --name /flowforge/${var.environment}/nginx-config --query Parameter.Value --output text > /tmp/flowforge-nginx.conf",
          "aws ssm get-parameter --name /flowforge/${var.environment}/env-production --with-decryption --query Parameter.Value --output text > /tmp/flowforge-env",
          "echo === Cloning repo if needed ===",
          "if [ ! -d /home/ubuntu/flowforge/.git ]; then sudo mkdir -p /home/ubuntu/flowforge && sudo chown ubuntu:ubuntu /home/ubuntu/flowforge && sudo -u ubuntu git clone ${var.repo_url} /home/ubuntu/flowforge; fi",
          "cd /home/ubuntu/flowforge && sudo -u ubuntu git fetch origin && sudo -u ubuntu git checkout ${var.repo_branch} && sudo -u ubuntu git reset --hard origin/${var.repo_branch}",
          "echo === Running bootstrap ===",
          "cd /home/ubuntu/flowforge && export REPO_URL=${var.repo_url} && export BRANCH=${var.repo_branch} && sudo -u ubuntu -E bash infra/templates/bootstrap.sh 2>&1 | tee /tmp/flowforge-deploy.log"
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
