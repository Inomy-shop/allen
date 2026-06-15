# Security and Sandboxing

Allen is not just a web app. It runs agents that can inspect repositories, use tools, run terminal commands, create artifacts, and interact with external services. Treat it as developer infrastructure with repo-write capability.

## Core Security Model

Allen assumes the operator controls:

- The machine or server running Allen.
- The repositories registered in Allen.
- The credentials provided to Allen.
- The workflow YAML and agent definitions being run.
- The update feed URLs the desktop app fetches at startup.

Allen does not provide a hardened sandbox for hostile code or untrusted workflows.

### Desktop update URL validation

The desktop app's auto-update feature is protected by a URL validation layer (`packages/desktop/src/url-policy.ts`):

- **Update feed URLs** are validated on access: `ALLEN_UPDATE_FEED_URL` and `ALLEN_RELEASE_NOTES_FEED_URL` must be HTTPS URLs. The download URL (`url` field in the feed) must share the same origin as the feed URL to prevent MITM-style payload substitution.
- **External navigation** is restricted to HTTPS URLs. Loopback hosts (`localhost`, `127.0.0.1`, `::1`, `*.localhost`) are allowed over HTTP for local design-preview dev servers.
- The URL policy module is pure logic with no Electron imports, making it independently unit-testable (`url-policy.test.ts`).
- Operators hosting their own update feed should serve it over HTTPS and keep the signing origin private.

## Workspaces

Agents should work inside dedicated workspaces, not arbitrary filesystem paths.

Workspace protections include:

- Workspace-specific worktree paths.
- Workspace context injected into agent prompts.
- Server-side workspace metadata.
- Port allocation per workspace.
- Terminal and preview flows tied to workspace IDs.
- Cleanup of stale workspace service PIDs on server boot.

Important limitation: prompt constraints are not a kernel sandbox. If a tool has host filesystem access, the operator must still treat it as powerful.

Recommended practice:

- Use `WORKSPACE_BASE_DIR` to keep workspaces in one dedicated directory.
- Do not register repos with committed secrets.
- Do not run unfamiliar workflows against important repositories.
- Review generated diffs before merging.

## Agent Execution

Agent execution can happen through Claude Code CLI or SDK.

Relevant settings:

- `ALLEN_AGENT_EXECUTION_MODE=cli|sdk`
- `CLAUDE_BIN=/absolute/path/to/claude`
- `ALLEN_SYSTEM_PROMPT_MODE=append|custom`
- `ALLEN_AGENT_SKIP_LEARNINGS=true|false`

CLI mode runs agents through the local Claude Code CLI (local developer auth and tools). SDK mode runs them in-process. Select the mode with `ALLEN_AGENT_EXECUTION_MODE`.

Review these before changing execution behavior:

- `packages/engine/src/node-executor.ts`
- `packages/engine/src/codex-executor.ts`
- `packages/engine/src/cli-runner.ts`
- `packages/server/src/services/chat-tools.ts`
- `packages/server/src/services/chat-providers.ts`

## Credentials

All credentials Allen needs are read from `.env`.

Required for boot:

- `JWT_ACCESS_SECRET`
- `JWT_REFRESH_SECRET`

Optional — set only the integrations you use:

- `ALLEN_GITHUB_PERSONAL_ACCESS_TOKEN` for GitHub CLI calls and PR review workflows.
- `ALLEN_LINEAR_ACCESS_TOKEN` for Linear ticket workflows.
- `ALLEN_SLACK_BOT_TOKEN`, `ALLEN_SLACK_SIGNING_SECRET`, `ALLEN_SLACK_TEAM_ID` for Slack.
- MCP server credentials, supplied per server as `ALLEN_<KEY>` (for example, an MCP that needs `POSTGRES_CONNECTION_STRING` reads it from `ALLEN_POSTGRES_CONNECTION_STRING`). The MCP loader strips the `ALLEN_` prefix when forwarding the value to the MCP subprocess, and forwards only the keys that server explicitly declares.

Do not commit `.env`, tokens, API keys, customer data, private prompts, or copied repo contents.

## MCP Servers

MCP servers extend what agents can do. Allen intentionally does not forward the entire host environment to MCP subprocesses.

The MCP loader maps configured keys like:

```text
GITHUB_PERSONAL_ACCESS_TOKEN -> process.env.ALLEN_GITHUB_PERSONAL_ACCESS_TOKEN
```

The subprocess receives the unprefixed variable only when the MCP definition explicitly requests it.

Before enabling an MCP server:

- Check what tools it exposes.
- Check what environment variables it needs.
- Use least-privilege credentials.
- Avoid connecting production databases unless the workflow requires it and the risk is understood.

## Public Capability URLs

Some Allen URLs are intentionally public because browsers, Slack, email, iframes, and EventSource cannot always attach Authorization headers.

Public routes include:

- Uploaded file downloads.
- Artifact content links.
- Execution SSE stream by unguessable execution ID.
- Workspace log SSE by workspace ID.
- Workspace preview proxy.

These follow a capability URL pattern: possession of the unguessable URL grants access.

Operational implications:

- Do not put secrets in artifacts or uploaded files.
- Treat shared artifact/file URLs as sensitive.
- Be careful before posting execution or workspace links into public channels.
- Review route changes in `packages/server/src/app.ts`, `file.routes.ts`, `artifact.routes.ts`, and workspace routes.

## Authentication and Users

Allen is invite/admin controlled. There is no public signup.

On first boot:

1. The UI detects that no users exist.
2. The first operator creates the admin account at `/onboarding/account`.
3. The public bootstrap endpoint closes as soon as any user exists.

JWT settings:

- `JWT_ACCESS_SECRET`
- `JWT_REFRESH_SECRET`
- Optional `ACCESS_TOKEN_TTL`
- Optional `REFRESH_TOKEN_TTL`

Rotate JWT secrets if they are exposed.

## Integrations

Use least-privilege credentials for:

- GitHub
- Linear
- Slack
- Model providers
- Databases exposed through MCP

Allen can create PRs, post Slack messages, read Linear tickets, and run tools depending on configuration. The integration token controls the blast radius.

## Security Checklist Before Public Use

- Create the first admin through the UI onboarding screen, then use a strong password.
- Generate strong JWT secrets (`./scripts/setup.sh` does this on first run).
- Keep `.env` out of git.
- Run secret scanning before publishing the repository.
- Use a dedicated workspace directory.
- Test with a disposable repo first.
- Review workflow YAML and agent definitions.
- Review public artifact/file sharing behavior.
- Enable GitHub secret scanning and Dependabot alerts for the public repo.
