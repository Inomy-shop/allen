# Allen

> An agentic operating system for software development — assign work to a coordinated org of AI agents, watch them execute against real repositories, intervene at checkpoints, and improve them over time.

**Website:** <https://askallen.build/>

Allen runs a multi-team organization of AI agents against your codebases. You talk to it in chat or hand it a Linear ticket; team-lead agents plan and delegate to specialist coding agents; work runs in isolated git worktrees with live terminals; every step is traced, every output is an artifact, and humans approve at defined checkpoints. It integrates with GitHub, Linear, Slack, MCP servers, Claude Code, and Codex.

> **Status: early alpha.** Run it against dedicated workspaces and disposable or non-critical repositories first. Review workflow and agent definitions before pointing it at code you care about.

---

## Table of contents

- [What Allen does](#what-allen-does)
- [Core concepts](#core-concepts)
- [Quickstart](#quickstart)
- [First workflow](#first-workflow)
- [Feature tour](#feature-tour)
- [Architecture](#architecture)
- [Default ports](#default-ports)
- [Configuration](#configuration)
- [Integrations](#integrations)
- [Development](#development)
- [Documentation](#documentation)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

---

## What Allen does

- **Chat-driven agent work.** Open a chat, describe a task, and Allen routes it to the right agent or workflow. Agents can delegate to other agents; the full delegation tree is visible.
- **A seeded agent org.** On first boot Allen seeds 6 teams (executive, product, engineering, quality, meta, unassigned) and 20+ agents — team leads that orchestrate and specialists that write code, review, test, document, investigate bugs, and resolve PR feedback.
- **YAML workflows.** Multi-step pipelines with agent nodes, code nodes, conditionals, parallel branches, sub-workflows, and human checkpoints. Nine workflows ship built-in (planning, bug fix, feature implementation, PR review resolution, self-healing, and more).
- **Isolated workspaces.** Every coding task runs in a dedicated git worktree with a live terminal (WebSocket PTY), file watcher, and a reverse proxy to preview dev servers.
- **Full execution observability.** Traces, per-node logs, tool calls, costs and token usage breakdown (cached input, non-cached input, output), checkpoints, artifacts, and a Mermaid graph of every workflow.
- **Human-in-the-loop.** Workflows pause at intervention points (approval, question, escalation) and wait for a person.
- **Integrations.** GitHub (PR sync, CodeRabbit comment resolution), Linear (ticket dispatch to agents/workflows), Slack (chat from a thread), and MCP servers (Postgres, custom tools, etc.).
- **Self-healing.** An hourly monitor watches Allen's own runtime, fingerprints incidents, files Linear tickets, and can auto-dispatch a bug-fix workflow.
- **Learning/memory.** Agents capture and retrieve learnings (facts, patterns, mistakes) scoped to global/workflow/context/agent, backed by embeddings.

## Core concepts

| Concept | What it is |
|---|---|
| **Agent** | A configured LLM persona (system prompt, model, tools, MCP allowlist, delegation targets). Team agents orchestrate; specialist agents do the hands-on work. |
| **Team** | A group of agents with a lead and a parent team. Defines the delegation org chart. |
| **Workflow** | A YAML pipeline of nodes (`agent`, `code`, `human`, `condition`, `workflow`) connected by edges, with parallel branches and retries. |
| **Execution** | One run of a workflow or a single spawned agent. Has state, traces, logs, tool calls, artifacts. |
| **Workspace** | An isolated git worktree for a repo where agents run, with a terminal and preview proxy. |
| **Chat session** | A conversation with an agent. Can spawn agents, run workflows, and delegate. |
| **Intervention** | A human checkpoint where a workflow pauses for approval/input. |
| **Artifact** | A versioned output (PRD/HLD/TDD doc, generated file) addressable by a capability URL. |
| **Learning** | A captured insight injected into future agent prompts by scope. |
| **MCP server** | A Model Context Protocol tool server exposed to agents; configured per-server with `ALLEN_`-prefixed env vars. |

## Quickstart

### Requirements

`./scripts/setup.sh` checks for and (where possible) installs everything below — including Node 22 itself via nvm if it is missing:

- Node.js 22+ and npm 10+
- Git
- MongoDB 7 (auto-installed on macOS via Homebrew; install instructions printed for other OSes)
- **Claude Code CLI — required.** Installed via the official standalone installer (`curl -fsSL https://claude.ai/install.sh | bash`); the engine drives it with its `--agent` flag. You need an Anthropic account to authenticate it.
- **Codex CLI — optional.** Installed via `npm install -g @openai/codex`. Allen's chat defaults to Codex; set `ALLEN_DEFAULT_CHAT_PROVIDER=claude-cli` in `.env` to use Claude Code for chat instead and skip the OpenAI account entirely.

Supported platforms: macOS and Linux (and WSL2 on Windows). Native Windows is not supported.

### 1. Clone

```bash
git clone https://github.com/Inomy-shop/allen.git
cd allen
```

### 2. Run setup

```bash
./scripts/setup.sh
```

The setup script, in order:

1. Verifies npm 10+ and git, and installs Node 22 via nvm if Node is missing or older than 22.
2. Checks/installs MongoDB 7 (macOS via Homebrew) and ensures it is reachable on `localhost:27017`.
3. Installs the standalone Claude Code CLI via the official installer if missing or if the one on `PATH` lacks `--agent` support.
4. Installs the Codex CLI via npm if missing.
5. Runs `npm install` across all workspace packages.
6. Creates `.env` from `.env.example`, generates `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`, and auto-pins `CLAUDE_BIN` to the verified standalone CLI.
7. Prompts whether to install the optional Cognee-backed context engine. Pressing Enter skips it; run `npm run setup:context` later to install it.
8. Runs `npm run health` and prints PASS/FAIL per dependency.

Re-running is safe — it skips work already done and preserves your `.env`. If a step fails the script exits with a red error line; see [docs/troubleshooting.md → Setup Script Fails](docs/troubleshooting.md#setup-script-fails) for the fix matrix.

### 3. Authenticate the CLIs (one-time)

```bash
claude    # log in with your Anthropic account
codex     # optional: log in with your OpenAI account (skip if using claude-cli for chat)
```

Both CLIs persist auth on disk after first login.

### 4. Build and start Allen

The packages compile to `dist/` and the engine is consumed as a built dependency, so build before starting:

```bash
npm run build
npm start
```

This starts the API server on `http://localhost:4000` and the UI on `http://localhost:5173`.

### 5. Create the first admin

Open `http://localhost:5173`. On a fresh instance Allen opens an onboarding flow: create the first admin account → health check → register a repository → run a first workflow. After any user exists, the first-admin bootstrap endpoint closes and you sign in normally.

You can re-run the dependency checks any time:

```bash
npm run health
```

## First workflow

Use a disposable or non-critical repository for the first run — agents inspect files, and implementation workflows can write code, create branches, and open PRs.

1. Register a repository (local path, or clone from a GitHub SSH URL) on the Agents → Repos screen.
2. Open **Workflows** and choose `bug-fix-by-severity`.
3. Select the repo and enter a bug report (e.g. "Clicking Delete on an empty workflow crashes the UI with 'Cannot read property id of undefined'").
4. Watch the execution: timeline, node logs, tool calls, artifacts, and the opened PR.
5. Once you trust the output, try `feature-plan-and-implement` for a new-feature run.

Built-in workflows in `packages/engine/workflows/`:

| Workflow | Purpose |
|---|---|
| `feature-plan-and-implement.yml` | Take a user-supplied requirement spec (PRD-style), produce the TDD, audit it, implement, validate, and open a PR. No PRD authoring inside the workflow. |
| `bug-fix-by-severity.yml` | Triage a bug by severity and dispatch the appropriate fix path. |
| `tdd-design-by-severity.yml` | Generate a technical design document (TDD) from a user-supplied requirement, scaled to severity. |
| `milestone-implementation-from-prd-tdd.yml` | Implement milestones from existing PRD/TDD docs. |
| `resolve-pr-reviews.yml` | Resolve CodeRabbit/PR review comments, run tests, push fixes, summarize. |
| `self-healing-incident-triage.yml` | Classify and route a production/runtime incident. |
| `allen-self-healing-monitor-hourly.yml` | Hourly scan of Allen's own runtime; files and dispatches incidents. |
| `multi-repo-change-orchestration.yml` | Parent orchestrator for cross-repo change delivery — clarify, plan per-repo work, approve, then run child workflows in dependency-aware parallel phases. |

See [`docs/first-workflow.md`](docs/first-workflow.md) for a step-by-step walkthrough.

## Feature tour

**Chat & delegation.** Talk to any agent. `@mention` workflows, repos, agents, or Linear tickets (`@ENG-123`). Agents delegate to other agents; conversation threads are persisted and the delegation tree is visible in the execution view.

**Visual workflow builder.** Build workflows in the UI (`/workflows/new`) by wiring agent/condition/parallel/human nodes, or check YAML into `packages/engine/workflows/`. The engine validates structure on load and renders a Mermaid graph.

**Workspaces.** Each coding task gets a git worktree under `<ALLEN_HOME>/worktrees/`. The Workspaces page gives you a live terminal (real PTY over WebSocket), a file browser with live diffs, an embedded chat, and a reverse proxy so you can preview a dev server the agent started.

**Executions & traces.** The Executions page lists running and recent runs (paginated, filterable). Drill into any execution for the node timeline, per-node logs, tool calls with payloads, token usage breakdown (cached input, non-cached input, output — per-node and execution totals), cost accounting, checkpoints, and artifacts.

**Interventions.** When a workflow hits a human node it creates an intervention (approval / question / escalation) with a deadline. The Interventions page lists what needs you; answering resumes the run.

**Tickets (Linear).** Browse and filter Linear issues, mark a preferred agent, and dispatch a ticket to an agent or a workflow. Allen creates a workspace from a chosen repo and runs the agent with the ticket as the prompt. Allen reads issues and tracks assignment locally; write-back happens through the Linear MCP server.

**Pull requests.** Mirrors GitHub PRs, tracks CodeRabbit comments, and can trigger the `resolve-pr-reviews` workflow to address review feedback automatically.

**Cron / scheduled work.** Six built-in jobs (repo scan/pull, PR sync, MCP bundle cleanup, CodeRabbit sweep, hourly self-healing monitor) plus user-created scheduled agent/workflow runs via the Schedules page.

**Self-healing monitoring.** An hourly agent-led scan inspects Allen's own runtime records, fingerprints and deduplicates incidents, files Linear tickets, and can auto-dispatch `bug-fix-by-severity`. See [`docs/SELF_HEALING_MONITORING.md`](docs/SELF_HEALING_MONITORING.md).

**Learnings & memory.** Agents record learnings (facts, patterns, mistakes) scoped to global / workflow / context / agent. Relevant learnings are retrieved by embedding similarity and injected into future prompts.

**MCP servers.** Register Model Context Protocol servers (presets like Postgres, or repo-based Node/Python servers). Credentials are supplied as `ALLEN_<KEY>` env vars and forwarded to the MCP subprocess with the prefix stripped — the subprocess never sees unrelated `.env` secrets.

## Architecture

Allen is a TypeScript monorepo using npm workspaces and Turbo.

- **`packages/engine`** — Workflow engine: YAML loading and validation, agent loading (`agents.yml`) and keyword routing (`router.yml`), node execution (Claude via CLI or in-process SDK; Codex via subprocess), template rendering, condition evaluation (Filtrex), parallel-branch merging, state persistence, MCP loading, 4-layer output extraction, and embedding-backed learnings.
- **`packages/server`** — Express API + MongoDB. Auth (JWT access/refresh, first-admin bootstrap), the seeded agent org, chat, executions, workspaces (git worktrees + PTY terminals + reverse proxy), cron scheduler, integrations (Linear/Slack/GitHub), MCP registry, self-healing monitor, and SSE streams. ~28 route modules, ~65 services.
- **`packages/ui`** — React 18 + Vite + Tailwind frontend: dashboard/chat, executions, workflows + visual builder, workspaces, agents/teams/skills/repos, tickets, pull requests, schedules, interventions, settings, and the onboarding flow.
- **`e2e`** — Playwright coverage across workspaces, terminals, chat, executions, repo management, and rendered UI.

> Note: Allen's production agent org is **seeded into MongoDB by `packages/server/src/services/org-seed.ts`** (6 teams, 20+ agents). `packages/engine/agents.yml` holds the engine's built-in default agents.

See [`docs/architecture.md`](docs/architecture.md) for the full breakdown.

## Default ports

| Service | Port | Override |
|---|---|---|
| API server | `4000` | `PORT` |
| UI (Vite dev) | `5173` | `UI_PORT` |
| Workspace terminal + file-watch WebSocket | `4024` | `TERMINAL_WS_PORT` |
| Workspace service/preview ports | `15000`+ (10 per workspace) | — |
| MongoDB | `27017` | `MONGODB_URI` |
| Playwright e2e API | `4023` | `API_PORT` |

> If you override `PORT`, also set `TERMINAL_WS_PORT` explicitly so the UI dev proxy and the server agree on the terminal WebSocket port.

## Configuration

All configuration is environment variables in `.env` (created from `.env.example` by setup). Required to boot: `PORT`, `MONGODB_URI`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`. Everything else is optional and grouped in `.env.example`: token lifetimes, public URL, paths/agent-execution, and GitHub/Linear/Slack/MCP credentials. Create the first admin in the UI onboarding screen on first launch.

## Integrations

| Integration | Env vars | What it enables |
|---|---|---|
| **GitHub** | `ALLEN_GITHUB_PERSONAL_ACCESS_TOKEN` | `gh` CLI calls, PR sync, and PR review resolution. (Repo cloning uses SSH.) |
| **Linear** | `ALLEN_LINEAR_ACCESS_TOKEN` | Read projects/issues, dispatch tickets to agents/workflows. Issue write-back is via the Linear MCP server. |
| **Slack** | `ALLEN_SLACK_BOT_TOKEN`, `ALLEN_SLACK_SIGNING_SECRET`, `ALLEN_SLACK_TEAM_ID` | Drive an Allen chat session from a Slack thread; post responses back. |
| **MCP servers** | `ALLEN_<KEY>` per server | Extra agent tools (Postgres, custom Node/Python MCP servers, etc.). |
| **Self-healing Linear** | `ALLEN_SELF_HEALING_LINEAR_TEAM_KEY`, `ALLEN_SELF_HEALING_LINEAR_PROJECT_NAME`, `ALLEN_SELF_HEALING_ASSIGNEE_EMAIL` | Where the hourly monitor files incident tickets. |

## Development

```bash
npm run build     # TypeScript build across packages + Vite production build
npm run lint      # TypeScript no-emit type checks (engine, server, ui)
npm test          # Vitest unit/integration suites
npm run test:e2e  # Playwright e2e; needs live app deps (see e2e/README.md)
npm run health    # Re-run the runtime dependency checks
```

CI (`.github/workflows/ci.yml`) runs build, lint, and Vitest on every PR and push to `main`.

## Documentation

- [`docs/first-workflow.md`](docs/first-workflow.md) — first local workflow, setup → execution review.
- [`docs/architecture.md`](docs/architecture.md) — engine, server, UI, workspaces, agents, data model, integrations.
- [`docs/SELF_HEALING_MONITORING.md`](docs/SELF_HEALING_MONITORING.md) — the hourly self-healing loop.
- [`docs/security.md`](docs/security.md) — repo execution, sandboxing limits, secrets, MCP, public capability URLs.
- [`docs/troubleshooting.md`](docs/troubleshooting.md) — setup and runtime failure fixes.
- [`docs/known-limitations.md`](docs/known-limitations.md) — current alpha constraints.
- [`docs/claude-prompting-best-practices.md`](docs/claude-prompting-best-practices.md) / [`docs/gemini-prompting-best-practices.md`](docs/gemini-prompting-best-practices.md) — prompt-engineering references.

## Security

Allen executes agent-driven commands against repositories. Treat it like developer infrastructure with repo-write capability:

- Run agents in dedicated workspaces and disposable repos until you trust a workflow.
- Review workflow YAML and agent definitions before running them.
- Use least-privilege tokens for GitHub, Linear, Slack, model providers, and MCP servers.
- Never commit `.env`, API keys, OAuth tokens, SSH keys, or private prompts.
- Public capability URLs (artifacts, files, execution/workspace SSE, workspace preview) rely on unguessable IDs — treat them as sensitive.
- Report vulnerabilities privately via GitHub Security Advisories: https://github.com/Inomy-shop/allen/security/advisories/new

See [`SECURITY.md`](SECURITY.md) for the reporting policy and [`docs/security.md`](docs/security.md) for the operational model.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before sending a PR. High-value contributions: workflow examples, agent definitions, engine/server/UI fixes, docs, and tests. For large workflow/agent/security/architecture changes, open an issue first.

Report bugs and request features via GitHub Issues: https://github.com/Inomy-shop/allen/issues

## License

[MIT](LICENSE) — Copyright 2026 The Allen Authors.
