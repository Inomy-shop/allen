# ── Attach the new cert to the existing ALB HTTPS listener via SNI ──
# ADDITIVE — the existing api.dev.inomy.shop cert stays as the default.
# ALB uses SNI to pick the right cert per request.

resource "aws_lb_listener_certificate" "flowforge" {
  listener_arn    = data.aws_lb_listener.https.arn
  certificate_arn = aws_acm_certificate_validation.flowforge.certificate_arn
}

# ── Target Group (instance type, port 80 → nginx on the EC2) ──

resource "aws_lb_target_group" "flowforge" {
  name        = "flowforge-${var.environment}-tg"
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

  # Sticky sessions — keeps SSE and WebSocket upgrade connections on the same target
  stickiness {
    type            = "lb_cookie"
    cookie_duration = 86400
    enabled         = true
  }

  tags = local.tags
}

# Register the EC2 in the target group
resource "aws_lb_target_group_attachment" "flowforge" {
  target_group_arn = aws_lb_target_group.flowforge.arn
  target_id        = var.instance_id
  port             = 80
}

# ── Host-header routing rule ──
# ADDITIVE — only fires when Host == flowforge.inomy.shop.
# Existing rules (marketing.inomy.shop p100, default → Inomy API) are untouched.

resource "aws_lb_listener_rule" "flowforge" {
  listener_arn = data.aws_lb_listener.https.arn
  priority     = var.listener_rule_priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.flowforge.arn
  }

  condition {
    host_header {
      values = [var.domain, "*.${var.domain}"]
    }
  }
}
