# Known Limitations

Allen is early alpha. These limitations are intentional to document current reality, not a promise that the behavior is final.

## Setup

- `./scripts/setup.sh` is a one-command bootstrap on macOS (it installs Node 22 via nvm if needed, MongoDB via Homebrew, the Claude Code CLI, dependencies, and generates `.env`). On Linux it installs Node 22 via nvm but checks for MongoDB and prints install instructions rather than installing it; native Windows is unsupported (use WSL2).
- Run with `npm run build` then `npm start` — packages compile to `dist/` and the engine is consumed as a built dependency.
- Setup is primarily validated on macOS. Linux and cloud-VM environments are supported but less exercised.

## Demo Experience

- Allen ships without a bundled sample repository; the first workflow runs against a user-supplied repo.

## Sandboxing

- Allen does not provide a hardened sandbox for hostile code.
- Workspace prompt constraints are not equivalent to OS-level isolation.
- Agents and tools may have the permissions of the host process and configured credentials.
- Operators should use dedicated workspace directories and disposable repos for first tests.

## Secrets

- `.env` is local and must not be committed.
- Integration credentials live in `.env`; MCP presets and repo-based MCP servers follow the `ALLEN_`-prefix convention.
- Python MCP server dependencies are auto-installed into a per-MCP venv at `<ALLEN_HOME>/venvs/<mcpId>/` from a sibling `requirements.txt`. Allen does not detect changes to `requirements.txt` automatically — click **Reinstall** or delete-and-re-add the MCP to pick up new pins.
- Public artifact/file links are capability URLs and should not contain secrets.

## Deployment

- Allen ships no containerization or one-command deploy path. It is built for local development against a locally-running MongoDB.
- Production deployment, TLS, domains, process supervision, and persistent storage need explicit operator setup.

## Agent Execution

- Claude Code CLI must be installed and authenticated for local-repo agent workflows.
- CLI trust prompts can still require manual intervention in some environments.
- Model aliases can be overridden with `ALLEN_MODEL_*`, but defaults may change.
- Agent outputs are parsed heuristically where workflows ask for structured JSON.

## Workspaces

- Workspace service ports are allocated locally from `15000` upward.
- Running many workspaces can exhaust available ports or leave stale local processes if the host is killed.
- Server boot attempts stale PID cleanup, but manual cleanup may still be needed after hard crashes.
- Workspace preview behavior differs between localhost path-based preview and deployed subdomain preview.

## Public Capability URLs

- Artifact links, uploaded file links, execution SSE, workspace log SSE, and workspace previews intentionally have unauthenticated paths.
- These URLs rely on unguessable IDs and should be treated as sensitive.
- This model should be reviewed before using Allen with sensitive generated artifacts.

## Integrations

- GitHub, Linear, Slack, and MCP flows depend on correctly scoped external tokens.
- Integration setup UX is still evolving.
- Some integration failures surface as workflow or agent errors rather than guided setup errors.

## Tests and CI

- CI covers build, lint, and Vitest tests.
- Playwright e2e tests are not in the default CI workflow because they need MongoDB, browser setup, live app processes, filesystem state, and Claude CLI for some specs.
- E2E tests can create real workspace and database state.

## Documentation

- Screenshots, demo videos, and deeper deployment guides are not included.
- API-level reference documentation is incomplete.
- Workflow-authoring documentation is incomplete.
