# ── Application deployment via SSM ──
# Renders configs locally, writes them to EC2 via SSM parameters, then runs bootstrap.
# No S3 needed — configs are passed directly in the SSM command.

resource "null_resource" "deploy_app" {
  triggers = {
    instance_id    = var.instance_id
    domain         = var.domain
    deploy_version = var.deploy_version
    app_port       = var.app_port
    ws_port        = var.ws_port
    # Re-deploy when configs change
    nginx_hash     = md5(templatefile("${path.module}/templates/nginx.conf.tftpl", { domain = var.domain }))
    env_hash       = md5(templatefile("${path.module}/templates/env.production.tftpl", { port = var.app_port, ws_port = var.ws_port, docdb_uri = var.docdb_uri, master_key = var.master_key }))
  }

  depends_on = [
    aws_lb_listener_rule.flowforge,
    aws_lb_target_group_attachment.flowforge,
  ]

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = <<-SCRIPT
      set -euo pipefail

      # Render configs locally to temp files
      cat > /tmp/_ff_nginx.conf << 'NGINX_EOF'
${templatefile("${path.module}/templates/nginx.conf.tftpl", { domain = var.domain })}
NGINX_EOF

      cat > /tmp/_ff_env << 'ENV_EOF'
${templatefile("${path.module}/templates/env.production.tftpl", { port = var.app_port, ws_port = var.ws_port, docdb_uri = var.docdb_uri, master_key = var.master_key })}
ENV_EOF

      # Base64-encode configs to avoid shell escaping issues in SSM
      NGINX_B64=$(base64 < /tmp/_ff_nginx.conf)
      ENV_B64=$(base64 < /tmp/_ff_env)
      rm -f /tmp/_ff_nginx.conf /tmp/_ff_env

      echo "Sending deploy command to EC2 ${var.instance_id}..."
      COMMAND_ID=$(aws ssm send-command \
        --instance-ids "${var.instance_id}" \
        --document-name "AWS-RunShellScript" \
        --timeout-seconds 600 \
        --comment "FlowForge deploy v${var.deploy_version}" \
        --parameters commands="[\"#!/bin/bash\",\"set -euo pipefail\",\"echo $NGINX_B64 | base64 -d > /tmp/flowforge-nginx.conf\",\"echo $ENV_B64 | base64 -d > /tmp/flowforge-env\",\"if [ ! -d /opt/flowforge/.git ]; then sudo mkdir -p /opt/flowforge && sudo chown ubuntu:ubuntu /opt/flowforge && sudo -u ubuntu git clone ${var.repo_url} /opt/flowforge; fi\",\"cd /opt/flowforge && sudo -u ubuntu git fetch origin && sudo -u ubuntu git checkout ${var.repo_branch} && sudo -u ubuntu git reset --hard origin/${var.repo_branch}\",\"cd /opt/flowforge && export REPO_URL=${var.repo_url} && export BRANCH=${var.repo_branch} && sudo -u ubuntu -E bash infra/templates/bootstrap.sh 2>&1 | tee /tmp/flowforge-deploy.log\"]" \
        --query 'Command.CommandId' --output text)

      echo "SSM Command ID: $COMMAND_ID"
      echo "Waiting for completion (up to 10 minutes)..."

      aws ssm wait command-executed \
        --command-id "$COMMAND_ID" \
        --instance-id "${var.instance_id}" 2>/dev/null || true

      STATUS=$(aws ssm get-command-invocation \
        --command-id "$COMMAND_ID" \
        --instance-id "${var.instance_id}" \
        --query 'Status' --output text 2>/dev/null || echo "Unknown")

      if [ "$STATUS" = "Success" ]; then
        echo "Deploy succeeded"
      else
        echo "Deploy FAILED (status: $STATUS)"
        echo "--- stdout (last 3000 chars) ---"
        aws ssm get-command-invocation \
          --command-id "$COMMAND_ID" \
          --instance-id "${var.instance_id}" \
          --query 'StandardOutputContent' --output text 2>/dev/null | tail -c 3000 || true
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
