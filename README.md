# Allen

> An agentic operating system for software development - assign, coordinate, observe, and improve AI agents across real engineering workflows.

Allen helps engineering teams run multiple coding agents against real repositories. It includes workflow orchestration, isolated workspaces, execution traces, artifacts, human checkpoints, chat, and integrations with GitHub, Linear, Slack, MCP servers, and Claude Code.

> Status: early alpha. Use it with dedicated workspaces and review workflows before running them on important repositories.

## What Allen Does

- Runs YAML workflows for planning, bug investigation, feature implementation, PR review resolution, and repo exploration.
- Coordinates team agents and specialist coding agents from `packages/engine/agents.yml`.
- Creates and manages repo workspaces for agent execution.
- Stores executions, artifacts, chat sessions, repos, users, secrets, teams, and integrations in MongoDB.
- Shows workflow traces, node outputs, checkpoints, logs, artifacts, and workspace state in the React UI.
- Uses Claude Code CLI for local-repo agent execution, with SDK fallback for non-repo contexts.

## Quickstart

### Requirements

You only need Node.js 22+ on your machine to begin. The setup script will check for and (where possible) install the rest:

- Node.js 22+ and npm 10+
- MongoDB 7 (auto-installed on macOS via Homebrew; instructions printed elsewhere)
- Claude Code CLI (auto-installed via `npm install -g @anthropic-ai/claude-code`)
- Codex CLI (auto-installed via `npm install -g @openai/codex`) — Allen's chat defaults to Codex
- An Anthropic account to authenticate Claude Code, and an OpenAI account to authenticate Codex

### 1. Clone

```bash
git clone https://github.com/Kalpai-poc/allen.git
cd allen
```

### 2. Run setup

```bash
npm run setup
```

The setup script:

- Verifies Node.js 22+ and npm 10+.
- Installs MongoDB 7 (macOS via Homebrew) or prints install instructions for your OS, then starts it.
- Installs the Claude Code CLI globally if it is missing.
- Runs `npm install` for all workspace packages.
- Creates `.env` from `.env.example` and generates strong values for `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET`.

Re-running the script is safe — it skips work that is already done.

### 3. Authenticate the CLIs (one-time)

```bash
claude    # log in with your Anthropic account
codex     # log in with your OpenAI account
```

Both CLIs persist auth on disk after the first login.

### 4. Start Allen

```bash
npm start
```

This starts the API server on `http://localhost:4000` and the UI on `http://localhost:5173`.

### 5. Create the first admin

Open `http://localhost:5173`. On a fresh instance, Allen opens the onboarding screen so you can create the first admin account in the UI. After any user exists, sign in with that account.

Allen will run the same prerequisite checks in the browser that are available from the terminal:

```bash
npm run health
```

## First Workflow

Allen ships with workflow definitions in `packages/engine/workflows/`:

- `understand-and-plan.yml` - inspect a repo and produce an implementation plan.
- `bug-investigate-and-fix.yml` - reproduce, diagnose, fix, test, review, and summarize a bug.
- `feature-plan-and-implement.yml` - clarify requirements, write PRD/HLA/TDD, implement, validate, and open a PR.
- `resolve-pr-reviews.yml` - resolve PR review comments, run tests, push fixes, and summarize.

Typical first run:

1. Add a repository in the UI.
2. Open Workflows.
3. Choose `understand-and-plan`.
4. Select the repo and enter a bounded task.
5. Review the execution trace, artifacts, and final plan before running an implementation workflow.

## Architecture

Allen is a TypeScript monorepo using npm workspaces and Turbo.

- `packages/engine` - workflow engine, YAML validation, agent loading, node execution, conditions, parallel branches, state, MCP loading, output extraction, and learning context.
- `packages/server` - Express API, MongoDB persistence, auth, users, teams, repos, executions, chat, artifacts, secrets, Slack, Linear, GitHub, workspaces, streams, and cron.
- `packages/ui` - React/Vite frontend for chat, workflows, execution details, workspaces, repos, tickets, settings, users, and admin views.
- `e2e` - Playwright coverage for workspaces, terminals, chat, executions, repo management, and rendered UI behavior.

See `docs/architecture.md` for the full architecture overview.

## Documentation

- `docs/first-workflow.md` - first local workflow from setup to execution review.
- `docs/architecture.md` - engine, server, UI, workspaces, agents, and integrations.
- `docs/security.md` - repo execution, sandboxing limits, secrets, MCP, and public capability URLs.
- `docs/troubleshooting.md` - common setup and runtime failures.
- `docs/known-limitations.md` - current alpha limitations.

## Development Checks

```bash
npm run build     # TypeScript build plus Vite production build
npm run lint      # TypeScript no-emit checks across packages
npm test          # Vitest unit/integration suites
npm run test:e2e  # Playwright e2e suite; requires live app dependencies
```

## Security

Allen can execute agent-driven commands against repositories. Treat it like developer infrastructure:

- Run agents in dedicated workspaces.
- Review workflow YAML and agent definitions before running them.
- Use least-privilege tokens for GitHub, Linear, Slack, model providers, and MCP servers.
- Never commit `.env`, API keys, OAuth tokens, SSH keys, or private prompts.
- Report vulnerabilities privately through GitHub Security Advisories: https://github.com/Kalpai-poc/allen/security/advisories/new

See `SECURITY.md` for the reporting policy and `docs/security.md` for the operational security model.

## Contributing

Read `CONTRIBUTING.md` before sending a PR. Useful contributions include workflow examples, agent definitions, trace/workspace fixes, docs, tests, and focused improvements to the engine, server, or UI.

Report bugs and request features through GitHub Issues: https://github.com/Kalpai-poc/allen/issues

## License

[MIT](LICENSE) - Copyright 2026 The Allen Authors.
