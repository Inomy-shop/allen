# Adding a new env var to Allen

This guide covers every file that needs a change when you introduce a new
environment variable — for example, a new MCP preset credential like
`ALLEN_STRIPE_API_KEY`.

There are **two audiences** for any env var:

1. **Local dev** — the Allen server running on your laptop reads from the
   root `.env`.
2. **Production (EC2)** — Terraform renders `.env.production` from the
   template, stores it in SSM Parameter Store, and the deploy pulls it to
   `/home/ubuntu/allen/.env`.

You need to touch different files depending on which audiences you want.

---

## The 4-file flow (for a production-deployed var)

When you add one env var for production, update **all four** of these files.
Miss any one and the var will silently stay empty at runtime.

```
┌─────────────────────────────────────────────────────────────────────┐
│  infra/.env                                                          │
│    export TF_VAR_allen_<key>="actual-value"                          │
│                                                                      │
│    Your local source-of-truth. apply.sh sources this file so         │
│    Terraform picks up the exports as variable values.                │
│    NEVER committed to git.                                           │
└────────────────────┬────────────────────────────────────────────────┘
                     │  sourced by apply.sh → $TF_VAR_allen_<key>
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│  infra/variables.tf                                                  │
│    variable "allen_<key>" {                                          │
│      description = "..."                                             │
│      type        = string                                            │
│      sensitive   = true  # if it's a credential                      │
│      default     = ""                                                │
│    }                                                                 │
│                                                                      │
│    Declares the variable to Terraform. Without this block,           │
│    Terraform ignores the TF_VAR_* export completely.                 │
└────────────────────┬────────────────────────────────────────────────┘
                     │  exposed as var.allen_<key>
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│  infra/deploy.tf                                                     │
│    value = templatefile("${path.module}/templates/env.production.   │
│                           tftpl", {                                  │
│      ...existing vars...                                             │
│      allen_<key> = var.allen_<key>     # ← ADD THIS                  │
│    })                                                                │
│                                                                      │
│    Passes the value into the template render. templatefile() only    │
│    substitutes variables that appear in this map.                    │
└────────────────────┬────────────────────────────────────────────────┘
                     │  ${allen_<key>} in the template
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│  infra/templates/env.production.tftpl                                │
│    ALLEN_<KEY>=${allen_<key>}                                        │
│                                                                      │
│    The literal line that lands in /home/ubuntu/allen/.env on EC2.    │
│    Allen's process reads it via process.env.ALLEN_<KEY>.             │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Worked example: adding `ALLEN_STRIPE_API_KEY`

### 1 — `infra/.env`

Append a new export:

```bash
# Stripe — payments MCP
export TF_VAR_allen_stripe_api_key="sk_live_..."
```

Naming convention: lowercase, underscore-separated, always `allen_` prefix
on the Terraform side.

### 2 — `infra/variables.tf`

Declare the variable:

```hcl
variable "allen_stripe_api_key" {
  description = "Stripe MCP: secret API key (sk_live_...)"
  type        = string
  sensitive   = true    # mask in plan/apply output
  default     = ""      # makes it optional
}
```

### 3 — `infra/deploy.tf`

Pass it to the template render inside `aws_ssm_parameter.env_production`:

```hcl
value = templatefile("${path.module}/templates/env.production.tftpl", {
  ...
  allen_stripe_api_key = var.allen_stripe_api_key
})
```

### 4 — `infra/templates/env.production.tftpl`

Add the env line:

```
# Stripe
ALLEN_STRIPE_API_KEY=${allen_stripe_api_key}
```

### Verify

```bash
cd infra
terraform validate   # should say "Success!"
./apply.sh plan      # check the aws_ssm_parameter.env_production diff
./apply.sh           # deploy
```

After deploy, SSH and confirm:

```bash
ssh ubuntu@<ec2-host>
grep ALLEN_STRIPE /home/ubuntu/allen/.env
# → ALLEN_STRIPE_API_KEY=sk_live_...
```

---

## Shortcut: adding **only for local dev** (not deployed)

If you just need the var on your laptop (e.g., testing an MCP before
deploying it), skip the four-file dance and add directly to:

```
/Users/shreemantkumar/flowforge/.env
```

Example:

```
ALLEN_STRIPE_API_KEY=sk_test_...
```

Restart the Allen server (`npm run dev` or equivalent). The server's
`process.env` picks it up on boot. No terraform involved.

When you later want it in production, do the 4-file flow above.

---

## Naming conventions

| Layer | Naming |
|---|---|
| Production env (`.env` on EC2, `process.env` at runtime) | `ALLEN_STRIPE_API_KEY` — uppercase, `ALLEN_` prefix |
| Terraform variable | `allen_stripe_api_key` — lowercase, underscores, `allen_` prefix |
| TF_VAR export in `infra/.env` | `TF_VAR_allen_stripe_api_key` — prepend `TF_VAR_` to the variable name |
| Template placeholder | `${allen_stripe_api_key}` — matches the variable name |

The `ALLEN_` prefix is how the MCP loader recognises which env belongs to
Allen vs. the spawning subprocess. When a preset declares it needs
`STRIPE_API_KEY`, the loader looks up `process.env.ALLEN_STRIPE_API_KEY`
and strips the prefix before passing to the child.

---

## When `sensitive = true` matters

Mark a variable `sensitive = true` in `variables.tf` when it's a
credential. Effects:

- Terraform masks the value in `plan` / `apply` output (prints `(sensitive value)` instead)
- Stops the value being accidentally shown in logs
- Does **not** encrypt it in state — use `aws_ssm_parameter` with
  `type = "SecureString"` for at-rest encryption (already done in
  `deploy.tf`)

Non-credential config (region, URL, flag defaults) can leave
`sensitive` off for easier debugging.

---

## Common mistakes

| Symptom | Cause | Fix |
|---|---|---|
| `TF_VAR_* is not set in .env` error at apply time | Your var name appears in `apply.sh`'s `REQUIRED_VARS` list | Only add vars to that list if they're truly mandatory. MCP vars have `default = ""` so they should NOT be in REQUIRED_VARS |
| Var set in `.env`, Terraform ignores it | Missing `variable` block in `variables.tf` | Add the declaration |
| Var in `variables.tf`, but `.env.production` still empty after deploy | Missing line in the `templatefile({...})` map in `deploy.tf` | Add the pass-through |
| `.env.production` has `ALLEN_FOO=${allen_foo}` (not substituted) | Passed to templatefile but the key name in the map doesn't match `${...}` in the `.tftpl` | Keys must match exactly (case-sensitive) |
| EC2 didn't pick up the new value | Terraform didn't redeploy because `env_version` didn't change | `terraform taint aws_ssm_parameter.env_production` then `./apply.sh`, OR change any var value to force a version bump |

---

## Files reference

| Purpose | Path |
|---|---|
| Local Terraform secrets (uncommitted) | `infra/.env` |
| Terraform variable declarations | `infra/variables.tf` |
| Deploy resource that renders `.env.production` | `infra/deploy.tf` |
| Rendered template | `infra/templates/env.production.tftpl` |
| Required-vars check | `infra/apply.sh` |
| Runtime `.env` on EC2 (after deploy) | `/home/ubuntu/allen/.env` |
| Runtime `.env` for local dev | `/Users/shreemantkumar/flowforge/.env` |
