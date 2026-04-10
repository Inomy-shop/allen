terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }

  backend "s3" {
    bucket  = "es-pipeline-terraform-state-dev"
    key     = "flowforge/terraform.tfstate"
    region  = "us-east-1"
    encrypt = true
  }
}

provider "aws" {
  region = "us-east-1"
}

locals {
  tags = {
    Project     = "flowforge"
    Environment = var.environment
    ManagedBy   = "Terraform"
  }
}

# ── Existing resources (read-only, NOT modified) ──

data "aws_lb" "inomy" {
  arn = var.alb_arn
}

data "aws_lb_listener" "https" {
  load_balancer_arn = data.aws_lb.inomy.arn
  port              = 443
}

# EC2 instance data source removed — the SG rule for ALB→EC2 port 80 is
# managed in the es-data-pipeline repo, not here. The instance_id is only
# used by alb.tf (target group attachment) and deploy.tf (SSM command),
# both of which reference var.instance_id directly.
