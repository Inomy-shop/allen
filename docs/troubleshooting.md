# Troubleshooting

This guide covers common Allen setup and runtime failures.

## Setup Script Fails

`./scripts/setup.sh` runs an ordered sequence of dependency checks, bails on the first hard failure with a coloured error line, and is safe to re-run after you fix whatever it complained about. Skip to the row below that matches the line the script printed in red.

| Step | Failure mode | Fix |
|---|---|---|
| Node.js ≥ 22 | `nvm bootstrap failed` or `nvm failed to install Node 22` | The script installs Node 22 via nvm automatically (bootstrapping nvm if absent). If that failed, it usually means no `curl`/`wget` to fetch nvm, or a restricted network. Install Node 22 manually ([nvm](https://github.com/nvm-sh/nvm), [fnm](https://github.com/Schniz/fnm), Homebrew `brew install node@22`, or your OS package manager), then re-run. After an nvm install you may need a new shell (or `nvm use 22`) before re-running. |
| npm ≥ 10 | warns only | If npm is on 9 or lower: `npm install -g npm@10`. |
| Git | `git not found` | macOS: `xcode-select --install` or `brew install git`. Linux: `sudo apt install git` / `sudo dnf install git`. Windows: install [Git for Windows](https://git-scm.com/downloads). |
| MongoDB 7 (install) | `MongoDB not found` | macOS without Homebrew: install [Homebrew](https://brew.sh), re-run. Linux: follow the [MongoDB Linux install guide](https://www.mongodb.com/docs/manual/administration/install-on-linux/), re-run. Windows: install from [mongodb.com/try/download/community](https://www.mongodb.com/try/download/community), re-run. |
| MongoDB reachable | `MongoDB still not reachable on localhost:27017` | The script tries `brew services start` / `sudo systemctl start mongod` automatically. If that didn't work, start it yourself with the command the warn line suggested, then re-run. |
| Claude Code CLI | `Cannot install Claude Code: curl is not available` | Install `curl` first (`brew install curl` / `sudo apt install curl`), then re-run. If you'd rather install Claude Code another way, follow the [official Claude Code quickstart](https://docs.claude.com/en/docs/claude-code/quickstart) and re-run setup — it will detect the existing install. |
| Claude Code CLI | `Official Claude Code installer failed` | Re-run setup once (transient network); if it still fails, install Claude Code manually from the [official quickstart](https://docs.claude.com/en/docs/claude-code/quickstart). |
| Codex CLI | `npm install -g @openai/codex` permission denied | Configure a user-owned npm prefix (`npm config set prefix ~/.npm-global` and add `~/.npm-global/bin` to `PATH`), or run setup with `sudo`. Codex is optional — see [Codex CLI Not Found](#codex-cli-not-found) below to skip it entirely. |
| `CLAUDE_BIN` resolution | warns: `Could not find any claude binary with --agent support` | The npm-distributed Claude Agent SDK does NOT include the `--agent <name>` flag that Allen needs. Install the standalone CLI per the [official quickstart](https://docs.claude.com/en/docs/claude-code/quickstart), then re-run setup. See [Claude Code CLI Not Found](#claude-code-cli-not-found) for the long-form explanation. |
| Health check | `Health check reported issues` (yellow, not red) | Setup completed but at least one required check failed in the final `npm run health`. Usually means Claude Code is installed but not authenticated yet — run `claude` interactively (and `codex` if you want it), then `npm run health` to confirm. |

After fixing any of these, just re-run `./scripts/setup.sh`. The script is idempotent — checks that already passed are re-confirmed as no-ops, and your `.env` (with generated JWT secrets and pinned `CLAUDE_BIN`) is preserved.

## `npm install` Fails

Check versions:

```bash
node --version
npm --version
```

Expected:

- Node.js 22+
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
JWT_ACCESS_SECRET=<set>
JWT_REFRESH_SECRET=<set>
```

If no users exist yet, open the UI and create the first admin account from the onboarding screen. After any user exists, the first-admin bootstrap endpoint is closed.

If the user is forced to reset password, only auth reset routes are allowed until the reset is completed.

## Setup Health

Run the local readiness checks from the terminal:

```bash
npm run health
```

The command exits non-zero when required checks fail. Optional Codex checks may warn without blocking first workflow setup.

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

- Agent execution fails immediately.
- Logs mention `claude`, `CLAUDE_BIN`, or an error containing "requires globally-installed `claude` binary with `--agent <name>` support".
- CLI mode cannot start; switching to SDK mode (`ALLEN_AGENT_EXECUTION_MODE=sdk`) works as a workaround.

### Two binaries are named `claude`

There are two distinct binaries that ship under the name `claude`. Allen accepts only one of them:

| | `npm install -g @anthropic-ai/claude-code` | Official installer (`curl -fsSL https://claude.ai/install.sh \| bash`) |
|---|---|---|
| What it is | Claude Agent SDK + a bundled CLI shim | Standalone Claude Code CLI |
| `--agent <name>` flag | **NOT supported** | Supported |
| Installs to | npm global prefix bin | `~/.local/bin/claude` (managed under `~/.local/share/claude/versions/`) |
| Suitable for Allen | No | Yes |

The npm SDK is also installed as a transitive dependency of `packages/server` and `packages/engine` (used in SDK execution mode), so you'll see a `node_modules/.bin/claude` even on a fresh checkout. Allen's CLI executor (`packages/engine/src/cli-runner.ts`) explicitly rejects anything under `node_modules/.bin/` and anything that lacks `--agent <name>` support.

### Diagnose

```bash
# Show every claude on PATH:
which -a claude

# For each one, check whether it has --agent support:
claude --help | grep -- '--agent <agent>'   # prints the flag if supported
```

If the only match is under `node_modules/.bin/` (or under your npm prefix, e.g. `~/.nvm/.../bin/claude`), and `--help` does NOT show `--agent <agent>`, you have the wrong binary.

### Fix

```bash
# Install the standalone CLI (same command setup.sh uses):
curl -fsSL https://claude.ai/install.sh | bash

# Re-run setup — it will detect, verify, and pin the new binary in .env:
./scripts/setup.sh
```

After install, the script writes `CLAUDE_BIN=/Users/you/.local/bin/claude` to `.env`. To set it manually:

```bash
CLAUDE_BIN=/absolute/path/to/standalone/claude
```

Then restart Allen with `npm start`.

### Authenticate

Once installed, run `claude` once interactively and complete the browser-based OAuth flow. Auth is persisted on disk and survives restarts.

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

To run Allen without Codex, set `ALLEN_DEFAULT_CHAT_PROVIDER=claude-cli` in `.env` and restart. New chat sessions and the UI provider picker then default to `claude-cli`. Codex is required only for workflow nodes that specifically use it.

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

MCP presets and repo-based MCP servers use the `ALLEN_` prefix convention.

If a preset or repo MCP says it needs:

```text
POSTGRES_CONNECTION_STRING
```

put this in `.env`:

```bash
ALLEN_POSTGRES_CONNECTION_STRING=<value>
```

Restart Allen after editing `.env`.

## Python MCP Server Does Not Start

For repo-sourced MCP servers whose entry file ends in `.py`, Allen creates an isolated Python virtual environment per MCP at `<ALLEN_HOME>/venvs/<mcpId>/` (typically `~/.allen/venvs/<mcpId>/`) and installs `requirements.txt` into it on the first spawn. Each MCP gets its own venv, so dep versions never collide between MCPs.

When the **Test connection** error reads `process exited prematurely` followed by `stderr: ModuleNotFoundError: No module named '<pkg>'`, the entry file imports a package that isn't in the MCP's `requirements.txt`. Add it to `requirements.txt` next to the entry file, then either:

1. Click **Reinstall** in Settings → MCP Servers (wipes the venv and re-runs `pip install -r requirements.txt`), OR
2. Delete the MCP and re-add it.

To bootstrap the venv, Allen needs a base interpreter on `PATH`. Verify it:

```bash
python3 --version
```

You can override the bootstrap interpreter (e.g. to pin `python3.11`) via the **Python interpreter** field when adding/editing the MCP. The interpreter is only used once — to create the venv. After that, every spawn uses `<venvPath>/bin/python`.

### Manual interpreter (escape hatch)

If you'd rather manage the interpreter yourself (e.g. you have an existing project venv with the deps already installed), fill in the **Command** field with the path to that interpreter (`venv/bin/python`, `/opt/homebrew/bin/python3.11`, etc.). When **Command** is set, Allen skips venv creation and `pip install` entirely — the interpreter you specify must already have the required packages.

### Updating dependencies

Allen does **not** detect changes to `requirements.txt` automatically. To pick up new or upgraded deps:

- Click **Reinstall** in Settings → MCP Servers, **or**
- Delete the MCP and re-add it (this also wipes the venv).

`envKeys` you configure are resolved using the same `ALLEN_<KEY>` convention as Node MCP servers.

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
