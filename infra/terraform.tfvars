# Non-sensitive values only. Committed to git.
# Sensitive values (docdb_uri, master_key) come from environment variables:
#   - Local:  source infra/.env then run infra/apply.sh
#   - GitHub: set in GitHub Environment secrets (auto-exported as TF_VAR_*)

domain         = "flowforge.inomy.shop"
alb_arn        = "arn:aws:elasticloadbalancing:us-east-1:257394465633:loadbalancer/app/InomyA-ApiSe-7LeVvZDFml8I/7bc0ff09e912f0c1"
instance_id    = "i-086efc3e8ad92eb7f"
vpc_id         = "vpc-033eec7eb19e904f0"
environment    = "dev"
deploy_version = "13"
app_port       = 4023
ws_port        = 4024
repo_url       = "https://github.com/Kalpai-poc/flowforge.git"
repo_branch    = "main"
