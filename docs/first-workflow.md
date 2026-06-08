# First Workflow

This guide gets Allen from a local checkout to one useful workflow result: a repo-grounded bug fix produced by `bug-fix-by-severity`.

Use a disposable or non-critical repository for the first run. Allen can spawn agents that inspect files and later workflows can write code.

## Prerequisites

- Node.js 22+ (the setup script verifies this)
- A local git repository you are comfortable letting Allen inspect — or a GitHub repo URL you can clone via SSH
- An Anthropic account for Claude Code
- An OpenAI account for Codex (Allen's chat defaults to Codex)

The setup script installs MongoDB, the Claude Code CLI, the Codex CLI, dependencies, and generates `.env`.

## 1. Clone Allen

```bash
git clone https://github.com/Inomy-shop/allen.git
cd allen
```

## 2. Run the setup script

```bash
./scripts/setup.sh
```

This:

- Checks npm 10+ and git, and installs Node 22 via nvm if Node is missing or older than 22.
- Installs MongoDB 7 (macOS via Homebrew) or prints install instructions for your OS, then ensures it is reachable.
- Installs the standalone Claude Code CLI via the official installer (`curl -fsSL https://claude.ai/install.sh | bash`) if missing or if the one on `PATH` lacks `--agent` support. Allen's engine requires the standalone CLI's `--agent` flag.
- Installs the Codex CLI via `npm install -g @openai/codex` if missing.
- Runs `npm install`.
- Creates `.env` from `.env.example`, fills in fresh `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`, and auto-pins `CLAUDE_BIN` to the verified standalone CLI.
- Runs `npm run health` and reports PASS/FAIL per dependency.

Re-running it is safe — it skips completed work and preserves your `.env`.

Optional `.env` overrides for predictable local state:

```bash
ALLEN_HOME=$HOME/.allen
WORKSPACE_BASE_DIR=$HOME/allen-workspaces
```

## 3. Authenticate the CLIs (one-time)

Allen drives both Claude Code (used for agent execution against repos) and Codex (the default chat provider). Both need a one-time login on the host:

```bash
claude    # log in with your Anthropic account
codex     # log in with your OpenAI account
```

After the first login each CLI persists auth on disk. Chat uses Codex by default; to use Claude Code for chat instead, set `ALLEN_DEFAULT_CHAT_PROVIDER=claude-cli` in `.env` (or pick a provider in the chat UI). Skip a CLI you do not plan to use.

## 4. Build and start Allen

Build first — packages compile to `dist/` and the engine is imported as a built dependency:

```bash
npm run build
npm start
```

Expected ports:

- API server: `http://localhost:4000`
- UI: `http://localhost:5173`
- Workspace terminal + file-watch WebSocket: `4024` (file-watch shares the terminal port at `/ws/workspaces/:id/watch`)
- Workspace app ports: allocated from `15000` upward in blocks of 10

Check server health:

```bash
curl http://localhost:4000/api/health
```

Check setup readiness:

```bash
npm run health
```

## 5. Sign In

Open `http://localhost:5173`.

1. If this is a fresh instance, create the first admin account in the onboarding screen.
2. If an admin already exists, sign in with that account.
3. You should land in the Allen UI.

## 6. Add a Repository

Open the Repos page in the UI. There are two ways to register a repo.

### Option A — Register an existing local path

Point Allen at a path that already exists on disk. No GitHub credentials are needed; Allen just records the path and scans it.

Pick a repo that:

- Is a git repository.
- Has no secrets committed.
- Can be safely inspected by an agent.
- Has a small, bounded task you can ask Allen to plan.

### Option B — Clone from a GitHub URL

Allen can clone the repo into `<ALLEN_HOME>/repositories/<name>` for you. The clone uses **SSH** (`git clone git@github.com:owner/repo.git`), so the host running Allen must have an SSH key registered with your GitHub account.

Quick check that SSH works against GitHub:

```bash
ssh -T git@github.com
```

If you see `Hi <your-username>! You've successfully authenticated…`, the clone option will work. If not, follow GitHub's docs to add an SSH key, then retry.

> **Note**: Repo cloning uses SSH and needs an SSH key on the host. `ALLEN_GITHUB_PERSONAL_ACCESS_TOKEN` is used by the `gh` CLI for PR creation, PR review resolution, and similar workflows, and is optional for registering repos.

## 7. Run `bug-fix-by-severity`

Open Workflows and choose:

```text
bug-fix-by-severity
```

Inputs:

- `bug_report`: a clear description of the bug — symptoms, repro steps, error messages, and stack traces if you have them. Example: "Clicking Delete on an empty workflow crashes the UI with 'Cannot read property id of undefined'. Reproduced on Chrome 120."
- `repo_path`: the registered repository.

Start the run. The investigator will classify the bug as small / medium / large and route through a proportionate fix pipeline. Expect one human approval gate after root-cause and fix-scope are proposed.

## 8. Review the Result

Open the execution detail page and inspect:

- Timeline and node status.
- Node logs.
- Template bindings.
- State outputs.
- Artifacts, if generated.
- The opened PR (for small/medium/large severities that complete).

## 9. Next Workflows

After the first workflow succeeds, try one of:

- `feature-plan-and-implement` for a new feature with PRD/HLD/TDD and implementation.

Review workflow YAML before running implementation workflows. They can create branches, modify files, run tests, and interact with external tools depending on available credentials.

## 10. Creating your own workflow

You can either edit the seed YAMLs in `packages/engine/workflows/` or build a new workflow visually:

- **Visual builder.** In the UI, open Workflows → New. The builder lets you wire agent nodes, condition nodes, parallel branches, and human checkpoints, then validates and saves to MongoDB via `POST /api/workflows`. Workflows created in the UI are owned by your team and are immediately runnable.
- **Seed YAMLs.** Drop a new file in `packages/engine/workflows/`. The engine validates structure on load (`packages/engine/src/validator.ts`); see the existing files for the schema. Restart Allen so the seed picks it up. This is the right path for workflows that should be checked into source control.

Both approaches share the same node types — agent, human, condition, parallel — and the same template bindings, output extraction, and learning capture. See `docs/architecture.md` for the engine model.

## 11. Dispatching a Linear ticket to an agent

Allen can pull a Linear ticket, hand it to an agent, and run it inside a workspace.

Prerequisites:

- Set `ALLEN_LINEAR_ACCESS_TOKEN` in `.env` (Linear → Settings → API → Personal API keys).
- Restart Allen so the new env value is picked up.
- Have at least one repo registered (Step 6 above) — the agent runs in a workspace cloned from one of your repos.

Flow in the UI:

1. Open the Tickets page. If Linear is not connected, the page tells you which `.env` key is missing.
2. Pick an issue. Click **Assign agent** to mark a preferred agent (`PATCH /api/linear/issues/:id/assign-agent`). This records the assignment only; dispatch (step 3) starts the run.
3. Click **Dispatch** (`POST /api/linear/issues/:id/dispatch`). Provide the agent name, a registered repo, and any extra instructions. Allen creates a workspace from that repo, waits for it to be ready, then spawns the agent with the ticket title/body as the prompt.
4. The dispatch returns immediately with a `pending` assignment. The Tickets page polls `/api/linear/issues/:id` to show progress; click through to the workspace or execution page to watch the run.

Allen reads Linear issues and tracks agent assignment locally. To have an agent comment on or update a Linear issue, build that into the workflow using the Linear MCP server.
