# Conductor (conductor.build) — Deep Dive

**Last reviewed:** 2026-04-17
**Category:** Local-first parallel-agent orchestrator (Mac)
**One-line pitch:** A free Mac-native Tauri app that orchestrates many Claude Code and Codex sessions in parallel, each isolated in its own git worktree — the polished UX for the "run 5 agents at once" pattern.

---

## 1. Company & traction

- **Founders:** **Charlie Holtz** (ex-Replicate) & **Jackson de Campos**.
- **Y Combinator:** S24 batch.
- **Funding:** **$22M Series A** (2025, lead not publicly disclosed at time of writing).
- **Customers (public / cited):** Linear, Vercel, Notion, Ramp, Square, Spotify, Life360, Reducto, Stripe. **Listed in Vercel's own docs as a recommended coding agent.**
- **Platform:** **macOS-only** (Windows on waitlist; no Linux plans announced).
- **Installs:** six-figure download counts inferred from public usage patterns; exact numbers not disclosed.

## 2. Core thesis

Most coding AI products wrap a single agent session. Conductor's thesis is that **you should run 5 agent sessions simultaneously on the same codebase — each in an isolated git worktree** — and review them together.

The bet: most of the value of coding agents is in parallel exploration ("try 3 different approaches and pick the best"), but **git branching + context switching is the real friction**. Conductor solves the workflow friction, not the model quality.

## 3. Technical stack under the hood

### 3a. Tauri (not Electron)
- **Tauri**: Rust core process + system WebView for the renderer.
- Advantage: ~50–150 MB bundle instead of ~250+ MB for Electron; faster startup; better macOS-native feel.
- **Bun-based bundle** update in early 2026 shaved another ~150 MB off the download.

### 3b. Claude Code SDK — TypeScript wrapper
Critically: Conductor **wraps the Claude Code SDK TypeScript package**, not the raw CLI. This means:
- **No proprietary LLM plumbing** — Conductor is a thin harness.
- **All Claude Code features work out of the box** — slash commands, plugin-installed commands, CLAUDE.md, tool permissions, MCP servers.
- **Updates to Claude Code propagate quickly** — Conductor added Opus 4.7, Sonnet 4.6, GPT-5.3-Codex-Spark within days of release.

### 3c. Git worktree isolation
The central abstraction:
- Each "workspace" = one git worktree on its own branch.
- Agents run with `cwd` = the worktree path.
- File edits, commits, test runs stay isolated.
- **Merge conflicts across parallel workspaces are avoided** because they're on different branches.
- **`/resolve-merge-conflicts`** custom slash command auto-runs when a workspace falls behind main.

### 3d. Authentication model — BYO
- Uses the user's existing Claude Code / Codex auth: API key, Claude Pro subscription, or Max plan.
- **No markup on model usage** — Conductor charges nothing; you pay Anthropic / OpenAI directly.
- `gh` CLI auth required for GitHub integration.

## 4. UI architecture

Three-panel layout:

- **Left sidebar** — list of workspaces (one per agent), status badges, task titles.
- **Middle panel** — chat interface for the active workspace; supports `@file` tagging, slash commands, images.
- **Right panel** — live file changes (git diff view) + integrated terminal.

Plus:
- **Big Terminal mode** (2026 feature) — full-screen terminal for the active workspace.
- **Chrome integration** — screenshots / test output from headless Chrome during agent runs.
- **GitHub panel** — PR status, review comments synced.

## 5. Orchestration & parallelism

- **N Claude Code / Codex sessions in parallel** — each in its own worktree.
- **Multiple agents per worktree** supported (e.g., planner + implementer on the same branch).
- **Workspace forking from conversation checkpoints** with auto-generated chat summaries — pivot mid-conversation into a new branch.
- **Agent handoff plans** — one agent hands a plan doc to another agent to execute. Limited but shipping.
- **Interactive planning** — agents can ask clarifying questions before starting work.

## 6. Memory model

- **Per-workspace** (= per worktree) — each agent sees only its own branch + CLAUDE.md + conversation history.
- **Per-repo "General Agent Preferences"** — custom instructions applied to every workspace in that repo.
- **No cross-session memory of its own** — whatever Claude Code remembers, Conductor remembers. No blocks, no archival, no consolidation.
- Inherits Claude Code's CLAUDE.md conventions.

## 7. Skills & extensibility

- **Claude Code slash commands** work natively — including plugin-installed commands.
- **Custom slash commands** editable in-app.
- **MCP servers** supported — Context7, Linear MCP, Postgres MCP, etc.
- Conductor itself is **not extensible** — no plugin system, no public API, no SDK. It's a product, not a platform.

## 8. Integrations

- **GitHub** (via `gh` CLI) — PR creation, review comments synced back into the workspace chat, GitHub Enterprise auth added in 2026.
- **Linear** — rich integration. Pick a Linear issue when creating a workspace; auto-injects title, description, acceptance criteria, labels; deep-links from Linear back to Conductor.
- **MCP** — any standards-compliant MCP server.
- **Vercel** — deploy monitoring within a workspace.
- **Chrome** — headless browser for UI testing/screenshots.
- **Terminal** — any local CLI tool works because you're in a real shell.

## 9. Enterprise / safety features

- **Tool Approval System** (2026) — review-and-approve gating for destructive tools before they run.
- **GitHub Enterprise auth** — on-prem-tier GitHub support.
- **No server-side component** — everything runs locally, so enterprise data never leaves the dev machine unless the dev sends it (via Claude Code's Anthropic call).

## 10. Pricing & availability

- **Free** — no subscription, no tiers, no feature gates.
- **Closed source.**
- **BYO auth** — Claude Pro ($20/mo), Max ($200/mo), or Anthropic API key. Same for Codex / OpenAI.
- **macOS 13+.** Windows waitlist.

## 11. Strengths

1. **Best-in-class UX for the parallel-agent workflow** — no competitor handles worktrees this cleanly.
2. **Free + BYO keys** — literally zero platform cost; you pay for model usage.
3. **Tauri-based** — small, fast, macOS-native feel (no Electron bloat).
4. **Deep Linear + GitHub loops** — from Linear issue → autofilled workspace → PR → review comments synced back.
5. **Claude Code-native** — all slash commands, plugins, and Claude Code features work automatically.
6. **Rapid model adoption** — Opus 4.7, Sonnet 4.6, Codex-Spark added within days of Anthropic / OpenAI release.
7. **Tool Approval + GHE auth** — meets enterprise security bar without adding server complexity.
8. **Customer endorsements from demanding devs** — Linear / Vercel / Notion / Stripe use it daily.

## 12. Weaknesses

1. **Mac-only** — the biggest adoption ceiling. Windows / Linux users blocked.
2. **GitHub-only VCS** — no GitLab / Bitbucket.
3. **No server-side state** — no team collaboration, no shared workspaces, no org-level settings.
4. **No persistent memory beyond Claude Code's defaults** — every workspace starts from scratch except for CLAUDE.md + general prefs.
5. **No declarative workflow layer** — you can't define "run these three agents in this sequence every time I hit `/deploy`". It's session-based, not workflow-based.
6. **No spec / planning artifact** — opinionless on how you plan; inherits Claude Code's style.
7. **Wrapper architecture means hard ceilings** — Conductor can't be smarter than Claude Code; innovation velocity is coupled to Anthropic.
8. **Not extensible** — no plugin API; what you see is what you get.

## 13. Changelog (2026 highlights)

- Claude Opus 4.7 + Sonnet 4.6 support.
- GPT-5.3-Codex-Spark support.
- **Tool Approval System** (enterprise gating).
- **GitHub Enterprise auth**.
- **Big Terminal mode**.
- **Workspace forking** from chat checkpoints with auto-summaries.
- **Chrome integration** for screenshot / test workflows.
- Bun-based bundle: ~150 MB smaller.
- 10× faster fuzzy search.

## 14. Who it's for

- **Senior engineers / tech leads / founding engineers** who want to run 3–10 coding agents simultaneously without wrestling with `git worktree add` manually.
- **Mac users** (only).
- **Teams on GitHub + Linear** (sweet-spot integration).
- **Claude Pro / Max subscribers** who want to extract maximum value from their plan.
- **NOT** the right fit for teams needing cross-machine collaboration, declarative workflows, or cross-platform access.

## 15. How Conductor compares in one sentence to each competitor

| vs. | Contrast |
|---|---|
| Factory | Factory has persistent VMs + multi-droid taxonomy + enterprise features; Conductor is local-first with zero infra. |
| Letta | Letta is a memory framework; Conductor has no memory of its own. |
| 8090 | 8090 is enterprise SDLC with artifacts; Conductor is individual productivity. |
| ProductNow | Non-overlapping — different buyer, different job. |
| Kiro | Kiro is IDE with specs; Conductor is many IDEs (sessions) running in parallel. |
| FlowForge | FlowForge is declarative server-side workflows; Conductor is ephemeral local sessions. Both could be used together — FlowForge server runs long workflows, dev uses Conductor for interactive parallel work. |

## 16. Sources

- [Conductor homepage](https://www.conductor.build/)
- [Conductor docs](https://docs.conductor.build/)
- [Conductor changelog](https://www.conductor.build/changelog)
- [Conductor on Y Combinator](https://www.ycombinator.com/companies/conductor)
- [Conductor listed in Vercel docs](https://vercel.com/docs/agent-resources/coding-agents/conductor)
- [The New Stack — hands-on review](https://thenewstack.io/a-hands-on-review-of-conductor-an-ai-parallel-runner-app/)
- [Elite AI-Assisted Coding: Parallel Agents with Worktrees and Conductor (Charlie Holtz interview)](https://elite-ai-assisted-coding.dev/p/the-parallel-agent-multiplier-conductor-with-charlie-holtz)
- [Medium — Scaling the Loop with conductor.build](https://georgetaskos.medium.com/scaling-the-loop-run-5-claude-code-sessions-in-parallel-with-conductor-build-539b52888a81)
- [Show HN — Conductor launch](https://news.ycombinator.com/item?id=44594584)
- [Conductor on Grokipedia](https://grokipedia.com/page/Conductorbuild)
- [Ry Walker Research — Conductor](https://rywalker.com/research/conductor)
