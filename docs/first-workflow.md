# First Workflow

This guide gets Allen from a local checkout to one useful workflow result: a repo-grounded implementation plan from `understand-and-plan`.

Use a disposable or non-critical repository for the first run. Allen can spawn agents that inspect files and later workflows can write code.

## Prerequisites

- Node.js 22+ (the setup script verifies this)
- A local git repository you are comfortable letting Allen inspect — or a GitHub repo URL you can clone via SSH
- An Anthropic account for Claude Code
- An OpenAI account for Codex (Allen's chat defaults to Codex)

The setup script handles MongoDB, both CLIs (`@anthropic-ai/claude-code` and `@openai/codex`), `npm install`, and `.env` generation.

## 1. Clone Allen

```bash
git clone https://github.com/Kalpai-poc/allen.git
cd allen
```

## 2. Run the setup script

```bash
npm run setup
```

This:

- Checks Node.js 22+, npm 10+, and git.
- Installs MongoDB 7 (macOS via Homebrew) or prints install instructions for your OS, then ensures it is reachable.
- Installs the standalone Claude Code CLI via the official installer (`curl -fsSL https://claude.ai/install.sh | bash`) if missing or if the one on `PATH` lacks `--agent` support. (The npm `@anthropic-ai/claude-code` package is deliberately not used — it lacks the `--agent` flag the engine requires.)
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

After the first login each CLI persists auth on disk. Skip a CLI if you do not plan to use the corresponding feature, but note that chat will fail without Codex unless you switch the default with `ALLEN_DEFAULT_CHAT_PROVIDER=claude-cli` in `.env` (or pick a different provider in the chat UI).

## 4. Start Allen

```bash
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

> **Note**: `ALLEN_GITHUB_PERSONAL_ACCESS_TOKEN` is **not** used to clone repos — it is only used by the `gh` CLI for PR creation, PR review resolution, and similar workflows. You can register repos without setting that token at all.

## 7. Run `understand-and-plan`

Open Workflows and choose:

```text
understand-and-plan
```

Inputs:

- `task`: a clear bounded task, such as "Add a CSV export button to the executions list."
- `repo_path`: the registered repository.

Start the run.

## 8. Review the Result

Open the execution detail page and inspect:

- Timeline and node status.
- Node logs.
- Template bindings.
- State outputs.
- Artifacts, if generated.
- Final plan.

The expected first value is not a code change. It is a grounded implementation plan that shows Allen can inspect the repo and produce useful next steps.

## 9. Next Workflows

After the planning workflow succeeds, try one of:

- `feature-plan-and-implement` for a controlled implementation workflow.
- `bug-investigate-and-fix` for a reproducible bug.
- `resolve-pr-reviews` for a GitHub PR review sweep.

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
2. Pick an issue. Click **Assign agent** to mark a preferred agent (`PATCH /api/linear/issues/:id/assign-agent`). This is just a marker — nothing runs yet.
3. Click **Dispatch** (`POST /api/linear/issues/:id/dispatch`). Provide the agent name, a registered repo, and any extra instructions. Allen creates a workspace from that repo, waits for it to be ready, then spawns the agent with the ticket title/body as the prompt.
4. The dispatch returns immediately with a `pending` assignment. The Tickets page polls `/api/linear/issues/:id` to show progress; click through to the workspace or execution page to watch the run.

Allen never writes back to Linear — it only reads issues and tracks assignment locally. If you want the agent to comment on the Linear issue, build that into the workflow itself using the Linear MCP server.
