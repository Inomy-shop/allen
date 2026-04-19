# ACM certificate for allen.inomy.ai (DNS-validated)
# Will PEND until the Route53 NS records are delegated at GoDaddy.

# Wildcard cert covers both *.allen.inomy.ai (workspace previews)
# and allen.inomy.ai (main app) via the SAN.
# Using wildcard as primary domain makes ACM produce a single shared
# validation CNAME — avoids the duplicate-record issue.
resource "aws_acm_certificate" "allen" {
  domain_name               = "*.${var.domain}"
  subject_alternative_names = [var.domain]
  validation_method         = "DNS"
  tags                      = local.tags

  lifecycle { create_before_destroy = true }
}

# DNS validation record (created inside our Route53 zone)
resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.allen.domain_validation_options :
    dvo.domain_name => {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  }

  allow_overwrite = true  # ACM may return the same CNAME for apex + wildcard
  zone_id         = aws_route53_zone.allen.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.value]
  ttl             = 60
}

# Wait for ACM to validate (blocks until DNS propagates)
resource "aws_acm_certificate_validation" "allen" {
  certificate_arn         = aws_acm_certificate.allen.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}
