# Troubleshooting

This guide covers common Allen setup and runtime failures.

## `npm run setup` Fails

The setup script verifies Node.js, installs MongoDB, the Claude Code CLI, and the Codex CLI when missing, runs `npm install`, and prepares `.env`. It is safe to re-run after fixing whatever it complained about.

Common failure modes:

- **Node version too old.** Install Node.js 20+ via nvm, fnm, or your OS package manager, then re-run.
- **`brew` not installed on macOS.** Install Homebrew from https://brew.sh and re-run, or install MongoDB manually from https://www.mongodb.com/try/download/community.
- **Linux MongoDB install needs sudo.** The script does not install MongoDB on Linux automatically; follow https://www.mongodb.com/docs/manual/administration/install-on-linux/, then re-run.
- **`npm install -g @anthropic-ai/claude-code` or `@openai/codex` permission denied.** Configure an npm prefix you own (e.g. `npm config set prefix ~/.npm-global` and add `~/.npm-global/bin` to `PATH`), or install with sudo, then re-run.

## `npm install` Fails

Check versions:

```bash
node --version
npm --version
```

Expected:

- Node.js 20+
- npm 10+

Then retry:

```bash
npm install
```

If native dependencies fail, make sure your OS has normal build tooling installed. On macOS, install Xcode Command Line Tools.

## MongoDB Connection Fails

Typical symptoms:

- Server does not start.
- API health check fails.
- Logs mention `MONGODB_URI` or connection refused.

Confirm MongoDB 7 is installed and running locally.

**macOS (Homebrew):**

```bash
brew services list | grep mongodb
brew services start mongodb-community@7.0
```

**Linux (systemd):**

```bash
systemctl status mongod
sudo systemctl start mongod
```

Check that the database is reachable:

```bash
mongosh --eval "db.runCommand({ ping: 1 })"
```

Verify `.env`:

```bash
MONGODB_URI=mongodb://localhost:27017/allen
```

Then start Allen with `npm start`; Allen connects directly to your local `mongod`.

## Server Port Is Busy

Default server port:

```bash
PORT=4000
```

If another process uses port 4000, either stop it or change `PORT` in `.env`.

Also remember:

- Terminal and file-watch WebSocket share port `4024` (file-watch clients connect to `/ws/workspaces/:id/watch`).
- Workspace services use port blocks from `15000` upward.

## UI Does Not Load

Run:

```bash
npm start
```

Open:

```text
http://localhost:5173
```

If API calls fail, check:

```bash
curl http://localhost:4000/api/health
```

If the API is on a different port, make sure the UI configuration and API calls are pointed at the right backend.

## Cannot Sign In

Check `.env`:

```bash
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=ChangeMe!123
JWT_ACCESS_SECRET=<set>
JWT_REFRESH_SECRET=<set>
```

The bootstrap admin is created only when no admin exists yet. If you changed `ADMIN_EMAIL` after the first boot, the existing admin in MongoDB may still be the old account.

If the user is forced to reset password, only auth reset routes are allowed until the reset is completed.

## Missing JWT Secret Error

Generate two secrets:

```bash
openssl rand -hex 32
openssl rand -hex 32
```

Set:

```bash
JWT_ACCESS_SECRET=<first value>
JWT_REFRESH_SECRET=<second value>
```

Restart Allen.

## Claude Code CLI Not Found

Symptoms:

- Agent execution fails.
- Logs mention `claude` or `CLAUDE_BIN`.
- CLI mode cannot start.

Check:

```bash
which claude
claude --version
```

If needed, set:

```bash
CLAUDE_BIN=/absolute/path/to/claude
```

Then restart Allen.

## Codex CLI Not Found

Symptoms:

- Chat fails on the default provider.
- MCP server registration silently fails (Allen logs swallow the error).
- Logs mention `codex`.

Check:

```bash
which codex
codex --version
```

Install or repair:

```bash
npm install -g @openai/codex
codex   # log in once with your OpenAI account
```

If your global npm prefix is not on `PATH`, either fix `PATH` (e.g. `npm config get prefix` and add the `bin` directory) or run setup again with the script's recommended prefix.

If you don't want to install Codex, switch Allen's default chat provider by setting `ALLEN_DEFAULT_CHAT_PROVIDER=claude-cli` in `.env` and restarting. New chat sessions and the UI provider picker will pick `claude-cli` instead. Workflow nodes that require Codex specifically will still fail.

## Agent Hangs on Trust Prompt

Allen attempts to pre-answer local trust prompts on boot, but this can fail gracefully if the required tools are unavailable.

Try manually running Claude Code once in the relevant Allen home/workspace path and accept the trust prompt.

Useful settings:

```bash
ALLEN_HOME=$HOME/.allen
WORKSPACE_BASE_DIR=$HOME/allen-workspaces
```

## Workflow Does Not Start

Check:

- MongoDB is running.
- You are signed in.
- The workflow exists in `packages/engine/workflows/`.
- The registered repo path exists and is a git repo.
- Required workflow inputs are filled.
- Claude Code CLI is installed and authenticated if the workflow uses agents.

Start with `understand-and-plan` before running implementation workflows.

## Workflow Pauses Waiting for Input

This can be expected. Human nodes and clarification gates create interventions/checkpoints.

Open:

- Execution detail page.
- Interventions page.
- Chat, if the workflow was started from chat.

Answer the prompt to continue.

## Workspace Terminal Does Not Connect

Check the terminal WebSocket port:

```bash
TERMINAL_WS_PORT=4024
```

Potential causes:

- Server is not running.
- Workspace was deleted.
- Workspace path no longer exists.
- Port 4024 is blocked or occupied.
- Browser cannot reach the server host.

## Workspace Preview Does Not Load

Check:

- The workspace service command is running.
- The service binds to the allocated port, not a hard-coded conflicting port.
- The service health check path is correct.
- For local dev, path-based preview uses the server proxy.
- For deployed subdomain preview, `ALLEN_PUBLIC_DOMAIN` must be configured correctly.

Workspace service ports are allocated from `15000` upward in blocks of 10.

## GitHub Integration Fails

Set in `.env`:

```bash
ALLEN_GITHUB_PERSONAL_ACCESS_TOKEN=<token>
```

Make sure the token has the repo permissions needed for the workflow. PR review resolution needs enough access to read PR comments, push branches, and comment/resolve as configured. Restart Allen after editing `.env`.

## Linear Integration Fails

Set in `.env`:

```bash
ALLEN_LINEAR_ACCESS_TOKEN=<token>
```

Restart Allen after editing `.env`.

## Slack Integration Fails

Set in `.env`:

```bash
ALLEN_SLACK_BOT_TOKEN=<token>
ALLEN_SLACK_SIGNING_SECRET=<signing-secret>
```

Slack webhooks require raw request body handling, so do not move `/api/slack` behind JSON parsing without reviewing `packages/server/src/app.ts`. Restart Allen after editing `.env`.

## MCP Server Missing Environment Variables

MCP presets use the `ALLEN_` prefix convention.

If a preset says it needs:

```text
POSTGRES_CONNECTION_STRING
```

put this in `.env`:

```bash
ALLEN_POSTGRES_CONNECTION_STRING=<value>
```

Restart Allen after editing `.env`.

## Public Artifact or File Link Exposes Sensitive Data

Artifact and file links are capability URLs. Anyone with the URL may be able to access the content.

Do not save secrets into artifacts. If sensitive content was exposed:

1. Remove the file/artifact from storage.
2. Rotate any exposed credentials.
3. Treat shared links as compromised.

## Tests Fail

Run unit/integration tests:

```bash
npm test
```

Run build and type checks:

```bash
npm run build
npm run lint
```

E2E tests:

```bash
npm run test:e2e
```

E2E tests need MongoDB, browser dependencies, live server/UI, and Claude CLI for agent-spawning specs. See `e2e/README.md`.
