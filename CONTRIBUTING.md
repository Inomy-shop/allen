# Contributing to Allen

Allen coordinates coding agents, workspaces, workflow traces, artifacts, and integrations around real software repositories. Contributions should preserve that operating model: visible execution, reviewable outputs, human checkpoints, and safe handling of repo access and credentials.

## Good Contribution Areas

- Workflow YAML in `packages/engine/workflows/`.
- The production agent org seeded in `packages/server/src/services/org-seed.ts` (6 teams, 20+ agents); the engine's built-in agent set in `packages/engine/agents.yml` and routing in `packages/engine/router.yml`.
- Engine behavior in `packages/engine/src/`: validation, state, outputs, templates, parallel execution, MCP loading, and agent execution.
- Server behavior in `packages/server/src/`: auth, repos, workspaces, executions, chat, artifacts, integrations, streams, and cron.
- UI behavior in `packages/ui/src/`: workflow builder, execution detail, workspaces, chat, repos, settings, tickets, and admin pages.
- E2E coverage in `e2e/` for workflows that cross UI, API, database, and workspace behavior.
- Docs that make setup, workflows, security, and troubleshooting clearer.

## Development Setup

```bash
git clone https://github.com/Inomy-shop/allen.git
cd allen
./scripts/setup.sh        # installs deps; installs Node 22 via nvm if needed
claude                    # one-time Claude Code authentication
npm run build             # packages compile to dist/ before first run
npm start
```

`./scripts/setup.sh` installs Node 22 via nvm if Node is missing or older than 22, checks npm 10+ and git, installs MongoDB 7 (Homebrew on macOS) and the standalone Claude Code CLI if missing, runs `npm install`, creates `.env` from `.env.example`, and generates `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET`. The first admin account is created from the UI onboarding screen on first launch.

## Before You Change Code

- Keep changes focused on one Allen surface area when possible.
- Read the surrounding package before adding abstractions.
- Treat workflow, workspace, auth, MCP, and agent execution changes as security-sensitive.
- Do not include private repos, customer data, local `.env` values, API keys, provider tokens, or proprietary prompts in commits, test fixtures, logs, screenshots, or issues.

## Testing Expectations

Run the checks that match your change:

```bash
npm run build
npm run lint
npm test
```

Add `npm run test:e2e` when the change affects browser flows, workspaces, terminals, repo setup, execution pages, chat, authentication, or integration flows. The e2e suite needs the real app dependencies described in `e2e/README.md`.

## Pull Requests

1. Fork the repo and create a branch from `main`.
2. Make a focused change.
3. Add or update tests for changed behavior.
4. Update docs when setup, configuration, workflow behavior, security posture, or UI behavior changes.
5. Use the pull request template and include the exact validation you ran.

For large workflow, agent, security, integration, or architecture changes, open an issue first so the direction can be reviewed.

## Code Style

- TypeScript across engine, server, and UI.
- Prefer explicit types at module boundaries and persistence boundaries.
- Match local patterns in the package you are editing.
- Avoid drive-by formatting and unrelated refactors.
- Keep workflow YAML readable and include human-facing labels, descriptions, and outputs.

## Security Reports

Do not open public issues for vulnerabilities. Use the private reporting process in `SECURITY.md`.

## Conduct

Participation in Allen follows `CODE_OF_CONDUCT.md`.

## License

By contributing, you agree that your contributions are licensed under the MIT License.
