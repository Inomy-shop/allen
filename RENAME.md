# Renaming the project

The display name is centralized. Everything else requires a coordinated rename across code + infra + deployed state.

## Step 1 — change the display name (5 min)

Edit these two files and commit. That covers UI strings, system prompts that reference the brand, Slack CTAs, auto-generated git branch prefix, git commit author, MCP server registration identity, and the default MongoDB database name.

- `packages/engine/src/brand.ts` — server/engine side
- `packages/ui/src/lib/brand.ts` — browser side (cannot import from engine)

```ts
// change these two
export const BRAND_NAME = 'Allen';      // display form
export const BRAND_SLUG = 'allen';      // lowercase / url-safe form
```

Everything that flows from these constants updates automatically:

| Derived from | What it becomes |
|---|---|
| `BRAND_NAME` | UI titles, chat placeholders, login text, Slack CTA, git commit author, log startup line |
| `BRAND_SLUG` | MCP server registration, DB name default, git branch prefix, log tag |

Run `npm run build` in each package. Done.

## Step 2 — change the identifier (1-2 hours, requires coordinated deploy)

If you also want to rename the lower-level identifiers (package names, env vars, on-disk paths, domain, etc.), these are NOT pulled from `brand.ts` because they're interface contracts with external systems. Rename them with a scripted pass.

### 2a. Code-side identifiers (one git commit)

| What | Where | Pattern |
|---|---|---|
| npm packages | `packages/*/package.json` + all imports | `@allen/*` → `@new/*` |
| CLI bin | `packages/engine/package.json` `bin.allen` | `"allen"` → `"new"` |
| Env vars | everywhere | `ALLEN_*` → `NEW_*` |
| `DO_NOT_RENAME` guard | `packages/server/src/services/secret.service.ts` | `ALLEN_MASTER_KEY` → `NEW_MASTER_KEY` |
| On-disk paths | `packages/engine/src/paths.ts` | `.allen`, `/tmp/allen`, `/var/lib/allen` → new |
| CSS class | `packages/ui/src/index.css` + JSX usages | `.prose-allen` → `.prose-new` |
| File names | see list below | `allen-*` → `new-*` |
| Domain | `infra/variables.tf` + `infra/*.tf` + `docs/plans/aws-deployment-allen.md` | `allen.inomy.ai` → new |
| Terraform resource names | `infra/*.tf` | `aws_*.allen` → `aws_*.new` |

**File names to rename (`git mv`):**
- `packages/server/src/services/allen-mcp-server.ts`
- `infra/templates/allen.service`
- `.github/workflows/deploy-allen.yml`
- `docs/plans/aws-deployment-allen.md`
- `docs/competitive/00-allen.md`

Bulk pattern (adapt):
```bash
grep -rl 'ALLEN_'  --exclude-dir={node_modules,dist,.git,data} | xargs sed -i '' 's/ALLEN_/NEW_/g'
grep -rl '@allen/' --exclude-dir={node_modules,dist,.git,data} | xargs sed -i '' 's#@allen/#@new/#g'
grep -rl '\.allen\b' --exclude-dir={node_modules,dist,.git,data} | xargs sed -i '' 's/\.allen/\.new/g'
# ...etc
```

### 2b. Deployed state (on EC2, in lockstep with the deploy)

1. Stop the service: `sudo systemctl stop allen.service`
2. Move on-disk data: `mv ~/.allen ~/.new` then `git worktree repair` in each repo under `~/.new/repositories/`
3. Rename MongoDB DB: `mongodump --db=allen` + `mongorestore --nsFrom=allen.* --nsTo=new.*`
4. Rewrite env vars in `.env.production`: `sudo sed -i 's/^ALLEN_/NEW_/g' /home/ubuntu/flowforge/.env.production`
5. Rewrite SSM parameters: `/allen/<env>/*` → `/new/<env>/*`
6. Rename secret keys in the Mongo `secrets` collection (the `ALLEN_SECRET_PREFIX` constant is updated in code, but existing documents keep their old names — one-shot script needed)
7. Codex MCP cleanup: `codex mcp remove allen` (the new server registers itself on boot)
8. Terraform state moves: `for r in aws_route53_zone aws_route53_record aws_lb_target_group ...; do terraform state mv $r.allen $r.new; done`
9. Systemd unit: copy the new unit file, disable/delete the old `allen.service`, enable the new one
10. DNS: register the new domain with your registrar, create Route53 zone, request new ACM cert, update ALB listener host-header rule

Script template: see `scripts/migrate-flowforge-to-allen.ts` for a working example — adapt the string constants.

### 2c. Intentionally NOT renamed

These stay as `flowforge` because they're out of scope:

- GitHub repository URL `github.com/Kalpai-poc/flowforge.git` (3 infra sites)
- Local working directory name `/Users/*/flowforge` (user-specific)
