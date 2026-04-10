output "ns_records_for_godaddy" {
  description = "Add these 4 NS records for the 'flowforge' subdomain at GoDaddy"
  value       = aws_route53_zone.flowforge.name_servers
}

output "domain" {
  description = "FlowForge URL"
  value       = "https://${var.domain}"
}

output "acm_cert_arn" {
  description = "ACM certificate ARN"
  value       = aws_acm_certificate.flowforge.arn
}

output "target_group_arn" {
  description = "ALB target group ARN"
  value       = aws_lb_target_group.flowforge.arn
}

output "alb_dns" {
  description = "ALB DNS name (what the A record points at)"
  value       = data.aws_lb.inomy.dns_name
}
