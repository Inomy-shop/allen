# Factory (factory.ai) — Deep Dive

**Last reviewed:** 2026-04-17
**Category:** Enterprise agent-native SDLC platform
**One-line pitch:** A fleet of specialized AI "Droids" — each with its own persistent compute environment — that drive development across the full SDLC from IDE, CLI, Slack, Linear, and a web app.

---

## 1. Company & traction

- **Founded:** 2023 (emerged 2024). Headquartered in San Francisco.
- **Funding:**
  - Seed + Series A led by NEA, Sequoia, Nvidia, J.P. Morgan.
  - **Series B: $50M at ~$300M post-money** (Sept 2025).
  - Reported **follow-on at $150M / ~$1.5B valuation** in early 2026.
- **Customers (public):** MongoDB, Nvidia, Adobe, EY, Palo Alto Networks, Adyen, Bayer, Zapier, Clari, Bilt, Chainguard, Groq, Podium.
- **Enterprise distribution:** **Wipro partnership** (Jan 2026) to accelerate agent-native dev for their global client base.
- **Growth:** ~200% QoQ through 2025 per published interviews.
- **Benchmarks (published):** Code Droid at **19.27% SWE-bench Full, 31.67% SWE-bench Lite; pass@2 = 37.67%, pass@6 = 42.67%.** Ranked **#1 on Terminal-Bench** (late 2025). Customer-cited outcomes: 31× faster feature delivery, 96% shorter migrations.

## 2. Product surfaces (5)

Factory is unusual in covering five developer entry points with one backend:

1. **Web app** (`app.factory.ai`) — mission-style UI, ticket → PR traceability, multi-droid view.
2. **Droid CLI** — interactive TUI.
3. **Droid Exec** — **headless one-shot CLI** for CI/CD, batch, shell pipelines. Supports `--session-id` for multi-turn over stdin, `--auto` to enable write operations, `low|medium|high` autonomy levels.
4. **IDE extensions** — VS Code, JetBrains, Vim.
5. **Collaboration surfaces** — Slack, Microsoft Teams, Linear trigger (ticket → droid mission).

The CLI is model-agnostic: users specify model, reasoning effort, tool lists, and working directory per call.

## 3. Droids (5 named specialists)

Factory's agent taxonomy:

| Droid | Role |
|---|---|
| **Code Droid** | Feature work, refactors, bug fixes, migrations, PRs. Benchmark-leader. |
| **Knowledge Droid** | Research, spec authoring, legacy-code explanation, documentation. |
| **Reliability Droid** | On-call triage, root-cause analysis, incident response, runbook execution. |
| **Product Droid** | Converts Slack threads/tickets into specs, backlog grooming, ticket assignment. |
| **Tutorial Droid** | Onboards new users to Factory itself. |

Plus **Review Droid** and **QA Droid** mentioned in docs as specialized flavors. Droids execute **"Missions"** — multi-day autonomous workloads with full ticket-to-PR traceability.

## 4. Architecture under the hood

### 4a. Persistent droid computers
Each droid gets its **own real VM** with installed packages, running services, and saved state that survives across days. If a droid was mid-task Monday, Tuesday it picks up with the same working tree, env vars, and running dev server. This is the feature that distinguishes Factory from wrap-a-CLI competitors.

### 4b. Context engine — HyperCode + ByteRank
- **HyperCode** — multi-resolution codebase representation combining **explicit graph structure** (AST/symbol graphs) with **implicit latent-space similarity** (embeddings across levels of abstraction). Solves context-window limitations by indexing not just text but relationships.
- **ByteRank** — retrieval algorithm layered on HyperCode; a RAG system tailored to code.
- Integrations push additional context: Jira tickets, design docs, Sentry logs, Linear issues, GitHub PRs — all indexed and queryable.

### 4c. Planning loop
Published technical report describes:
1. Take high-level problem.
2. Decompose into subtasks, translate to **action space**.
3. Reason over **optimal trajectories** (self-criticism and reflection on both real and imagined decisions — borrowed from robotics/cog-sci).
4. **Generate multiple trajectories** for a task (pass@k style).
5. Validate each trajectory with tests — both existing and self-generated.
6. Select optimal solution.

This explicit pass@k with test-validated selection is the most sophisticated autonomous planning in the cohort.

### 4d. Safety — DroidShield
DroidShield is a real-time static analysis pass gating every code edit before commit: scans for security vulnerabilities, IP breaches, suspicious patterns. Logged with reasoning — every droid action has an auditable explanation.

### 4e. Model plumbing
- **Multi-model**: Claude Opus/Sonnet (Anthropic), GPT-5 (OpenAI), Gemini. Different models for different sub-tasks.
- **Per-call model selection** via CLI flags; web UI selects per mission.
- **No BYO keys for SaaS plans** — Factory bills by token overage; Enterprise plans offer on-prem/private-cloud with customer-controlled keys.

### 4f. Tool / extension model
- **AGENTS.md** — per-project file (convention, not proprietary) that tells droids how to work with the codebase (commands, style, conventions). Similar role to `CLAUDE.md`.
- **MCP support** — Factory droids consume MCP servers for external tool access.
- **Custom tools** registerable at the droid level.
- **Computer use** — droids drive the browser, VS Code, terminal directly (not just generate diffs).

## 5. Memory

Two explicit tiers:

1. **Org Memory** — stable facts recorded automatically when teammates say things like "always use snake_case for API endpoints". Applied to every developer's droid in the org.
2. **User Memory** — personal preferences, tool choices.

Plus **persistent droid computers** act as implicit long-lived memory (files, installed deps, running services survive).

**Not disclosed publicly:** whether there's a structured memory-blocks architecture (Letta-style) or if it's prompt-prefix + RAG.

## 6. Orchestration

- **Multiple droids concurrent**, each in its own VM. Cross-droid coordination is via **shared indexed project context** (HyperCode index + ticket state), not explicit message-passing.
- **Mission = top-level orchestration unit**. A mission can span days, produce multiple commits/PRs, span multiple droids (e.g., Code Droid writes feature → Review Droid reviews → QA Droid tests).
- **Autonomy controls** via `--auto` flag (Droid Exec) and per-mission approval gates in the web app.

## 7. Human-in-the-loop

- **Approvals** on destructive actions (configurable).
- **Mission review** in the web UI: see trajectory, files changed, test results, droid's reasoning log before merging.
- **Request changes** feedback loops (droid iterates after human review).
- Autonomy levels: `low` (ask often), `medium`, `high` (rarely ask).

## 8. Integrations (native)

- **VCS**: GitHub, GitLab (PR creation, branch ops, code review).
- **Tickets**: Jira, Linear (trigger missions from tickets).
- **Chat**: Slack, Microsoft Teams (triggers + approvals).
- **On-call**: PagerDuty (Reliability Droid integration).
- **Observability**: Sentry (log ingestion).
- **CI/CD**: hooks for self-healing builds (Droid Exec in pipelines).
- **MCP**: generic external tool integration.

## 9. Deployment / pricing

- **Cloud SaaS** by default.
- **Pro**: $20/mo (2 seats, ~20M tokens).
- **Max**: $200/mo (5 seats, ~200M tokens).
- **Enterprise** (custom): on-prem / private-cloud, SSO/SAML, SOC-2, audit logs, dedicated compute.
- **Overage:** ~$2.70/M tokens.

Not open source.

## 10. Strengths

1. **Only product in cohort with persistent per-droid VMs** — true long-lived agent workspaces.
2. **Published benchmarks** (#1 Terminal-Bench, solid SWE-bench numbers) give concrete credibility.
3. **5-surface distribution** (IDE/CLI/Slack/Teams/Linear/web) is the widest in the cohort.
4. **Specialized droid taxonomy** covers the full SDLC (not just coding — reliability, product, knowledge).
5. **Enterprise-ready**: SOC-2, SSO/SAML, on-prem, dedicated compute, DroidShield safety gating.
6. **Multi-trajectory planning + test-validated selection** — genuine autonomous planning, not just ReAct.
7. **HyperCode/ByteRank** — specialized code retrieval, not generic RAG.
8. **AGENTS.md standard** — adopts community convention rather than inventing proprietary config.

## 11. Weaknesses

1. **Closed source, closed harness** — no self-extension path beyond MCP + AGENTS.md.
2. **Pricing opaque at Enterprise tier** — Max at $200/mo is the last public number; enterprise starts via sales.
3. **No structured memory architecture** disclosed — relies on Org/User memory + VM state + RAG. Letta is ahead here.
4. **Emergent (not declarative) workflows** — you can't diff a mission the way you can diff a workflow YAML. Harder to audit before the fact.
5. **SaaS-default**: developers who want local-first or full self-host need Enterprise contracts.
6. **Specialized droid specialization requires learning** — choosing the right droid for the right task has a discovery cost.

## 12. Recent news / changelog (2025–2026)

- **Sep 2025:** Series B $50M at $300M.
- **Late 2025:** GA ("Droids for the Entire SDLC"); #1 Terminal-Bench.
- **Early 2026:** $150M follow-on at ~$1.5B valuation (reported).
- **Jan 2026:** Wipro partnership for global enterprise distribution.
- **2026:** Droid Exec headless mode; Factory CLI support for Claude Sonnet 4.6 / Opus 4.6; AGENTS.md convention formalized.

## 13. Sources

- [Factory homepage](https://factory.ai)
- [Factory is GA](https://factory.ai/news/factory-is-ga)
- [Factory CLI product page](https://factory.ai/product/cli)
- [Factory Droid CLI docs](https://docs.factory.ai)
- [Droid Exec (Headless) docs](https://docs.factory.ai/cli/droid-exec/overview)
- [Memory & Context Management docs](https://docs.factory.ai/guides/power-user/memory-management)
- [Code Droid: A Technical Report](https://factory.ai/news/code-droid-technical-report)
- [Droid: #1 on Terminal-Bench](https://factory.ai/news/terminal-bench)
- [Factory on ZenML LLMOps DB](https://www.zenml.io/llmops-database/autonomous-software-development-using-multi-model-llm-system-with-advanced-planning-and-tool-integration)
- [NEA blog — Factory](https://www.nea.com/blog/factory-the-platform-for-agent-native-development)
- [Wipro × Factory partnership (2026)](https://www.wipro.com/newsroom/press-releases/2026/wipro-and-factory-partner-to-accelerate-agent-native-software-development-for-enterprises-globally/)
- [Latent.Space: Factory — The A-SWE Droid Army](https://www.latent.space/p/factory)
- [Sid Bharath: Factory guide](https://www.siddharthbharath.com/factory-ai-guide/)
