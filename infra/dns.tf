# Route53 hosted zone for allen.inomy.ai
# After apply, add the NS records from the output to GoDaddy.

resource "aws_route53_zone" "allen" {
  name    = var.domain
  comment = "Allen ${var.environment} — managed by Terraform"
  tags    = local.tags
}

# A record (alias) pointing the domain at the existing ALB
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

# Wildcard A record for workspace preview subdomains
# e.g., abc123.allen.inomy.ai → same ALB
resource "aws_route53_record" "allen_wildcard" {
  zone_id = aws_route53_zone.allen.zone_id
  name    = "*.${var.domain}"
  type    = "A"

  alias {
    name                   = data.aws_lb.inomy.dns_name
    zone_id                = data.aws_lb.inomy.zone_id
    evaluate_target_health = true
  }
}
