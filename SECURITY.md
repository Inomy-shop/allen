# Security Policy

Allen can run AI agents against software repositories. It manages workspaces, terminal commands, artifacts, auth, users, teams, chats, workflows, and integrations. Treat it like developer infrastructure with repo-write capability.

## Private Reporting

Do not open a public issue for a vulnerability.

Report vulnerabilities through GitHub Security Advisories:

https://github.com/Inomy-shop/allen/security/advisories/new

Useful reports include:

- Affected commit or branch.
- The Allen area involved: auth, workspace isolation, agent execution, MCP, artifacts, file uploads, GitHub, Linear, Slack, chat, or UI.
- Reproduction steps using sanitized data.
- Expected impact: credential exposure, unauthorized access, unintended repo writes, command execution, artifact exposure, or data leak.
- Logs or screenshots with secrets and private repo content removed.

## Supported Versions

Allen is pre-release. Security fixes target `main` until versioned releases are established.

| Version | Supported |
| --- | --- |
| `main` | Yes |
| Earlier commits | Best effort |

## Operator Responsibilities

- Run Allen only against repositories and systems you are allowed to modify.
- Use dedicated workspace directories for agent work.
- Review workflow YAML in `packages/engine/workflows/` before running it.
- Review agent definitions before granting tool access — the production org is seeded from `packages/server/src/services/org-seed.ts`; `packages/engine/agents.yml` holds the engine's built-in defaults.
- Keep `.env`, API keys, OAuth tokens, SSH keys, model-provider credentials, and MCP credentials out of git.
- Use least-privilege credentials for GitHub, Linear, Slack, Anthropic, and MCP servers.
- Rotate `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, provider keys, and integration tokens if exposed.
- Review artifacts before sharing them outside Allen.

## Security-Sensitive Code

The highest-risk areas are:

- `packages/server/src/auth/`
- `packages/server/src/services/workspace.service.ts`
- `packages/server/src/services/workspace-terminal.ts`
- `packages/server/src/services/workspace-proxy.ts`
- `packages/server/src/routes/file.routes.ts`
- `packages/server/src/routes/artifact.routes.ts`
- `packages/server/src/services/github-auth.ts`
- `packages/server/src/services/linear.service.ts`
- `packages/server/src/services/slack.service.ts`
- `packages/engine/src/codex-executor.ts`
- `packages/engine/src/node-executor.ts`
- `packages/engine/src/mcp-loader.ts`
- `packages/engine/src/mcp-install.ts`
- `packages/server/src/services/org-seed.ts` (seeded agent org)
- `packages/engine/agents.yml` (engine built-in agents)
- `packages/engine/workflows/`

Changes in these areas should include focused tests and a clear explanation of safety impact.
