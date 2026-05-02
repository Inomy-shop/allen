# CloudWatch Log Group for Allen service logs
# Only created when enable_cloudwatch_logs = true
resource "aws_cloudwatch_log_group" "allen_server" {
  count = var.enable_cloudwatch_logs ? 1 : 0

  name              = "/allen/${var.environment}/server"
  retention_in_days = var.cloudwatch_log_retention_days

  tags = merge(local.tags, {
    Name = "/allen/${var.environment}/server"
  })
}

output "cloudwatch_log_group_name" {
  description = "CloudWatch log group name for Allen service logs (empty when cloudwatch logging is disabled)"
  value       = var.enable_cloudwatch_logs ? aws_cloudwatch_log_group.allen_server[0].name : ""
}

output "cloudwatch_log_group_arn" {
  description = "CloudWatch log group ARN for Allen service logs (empty when cloudwatch logging is disabled)"
  value       = var.enable_cloudwatch_logs ? aws_cloudwatch_log_group.allen_server[0].arn : ""
}
