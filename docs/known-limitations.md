# Known Limitations

Allen is early alpha. These limitations are intentional to document current reality, not a promise that the behavior is final.

## Setup

- There is no complete one-command setup yet.
- MongoDB must be installed and running locally before starting Allen.
- The server and UI run together with `npm start` for local development.
- Fresh-machine setup still needs validation across macOS, Linux, and cloud VMs.

## Demo Experience

- There is no bundled toy repository yet.
- The first useful workflow currently requires a local repository supplied by the user.
- New users should start with `understand-and-plan`, not an implementation workflow.

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

- There is no shipped containerization or one-command deploy path. The repo is currently optimized for local development with a locally-running MongoDB.
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

- CI currently covers build, lint, and Vitest tests.
- Playwright e2e tests are not in the default CI workflow because they need MongoDB, browser setup, live app processes, filesystem state, and Claude CLI for some specs.
- E2E tests can create real workspace and database state.

## Documentation

- Architecture, troubleshooting, security, limitations, and first-workflow docs now exist, but screenshots, demo videos, and deeper deployment docs are still missing.
- API-level documentation is not complete.
- Workflow authoring documentation is not complete.
