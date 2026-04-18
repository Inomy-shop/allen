# Kiro (kiro.dev) — Deep Dive

**Last reviewed:** 2026-04-17
**Category:** AWS-backed agentic IDE for spec-driven development
**One-line pitch:** A cross-platform Code OSS-based agentic IDE from AWS that structures AI coding around a three-file spec (requirements in EARS notation + design + tasks) with file-level agent hooks and Bedrock-routed models.

---

## 1. Company & traction

- **Origin:** AWS product (not a separate company). Built as Amazon's answer to Cursor / Claude Code / Copilot.
- **Team:** AWS internal (specific eng leads not public).
- **Launch timeline:**
  - **Public preview:** July 14, 2025.
  - **General availability:** November 17, 2025.
  - **AWS re:Invent 2025:** featured in Werner Vogels keynote; DVT209 / DVT314 sessions on spec-driven dev.
  - **Kiro CLI 2.0** (2026): Windows support, headless CI/CD mode.
  - **GovCloud availability** (Feb 2026).
- **Traction:** AWS-distribution scale; specific install counts not published. Strong developer-blog activity on AWS + DEV Community.

## 2. Runtime substrate

### 2a. IDE — Code OSS fork
- **Code OSS** is the open-source foundation of VS Code (no Microsoft branding / marketplace / telemetry).
- Kiro is a fork, so **VS Code settings import works** (keybindings, themes, extensions compat).
- **Open VSX** extension marketplace instead of Microsoft's marketplace — compatible with most community extensions, not with Microsoft-exclusive ones.
- **Cross-platform** — Mac, Windows, Linux (full parity at GA).

### 2b. CLI — `kiro-cli`
- A separate CLI binary that talks to Bedrock directly.
- Stores OAuth tokens in `~/.local/share/kiro-cli/data.sqlite3` (Linux/macOS) or `%APPDATA%/kiro-cli/data.sqlite3` (Windows).
- **Spawned fresh per prompt** — a new `kiro-cli` subprocess per Kiro Assistant turn. Model selection dropdown takes effect on the next run.
- **CLI 2.0**: headless CI/CD mode → Kiro becomes scriptable in pipelines.
- **ACP (Agent Communication Protocol)** support — the CLI can be wired into third-party agents as a tool.

### 2c. Persistence
- **SQLite** at `~/Library/Application Support/kiro-assistant/` on macOS; equivalent on other platforms.
- Stores: conversation history, model settings, steering files metadata, spec file references.
- **Per-project state** lives in `.kiro/` at the repo root (specs, hooks, steering files).

## 3. Model plumbing

### 3a. Amazon Bedrock as the model backend
- Everything routes through **Amazon Bedrock** — AWS's managed LLM service — using foundation models from Amazon (Nova family) and third parties.
- **Primary:** Claude Sonnet 4.5, Sonnet 4.6 (added Feb 2026), Opus 4.6 (Pro+ tiers).
- **Auto mode** — mixes frontier models (Sonnet 4 series) for intent detection + caching to balance quality / latency / cost.
- **Model selection UI** — Default Model dropdown in Settings; per-chat override.
- **Sonnet 4 pinned mode costs ~1.3× Auto mode** in credits.
- **No BYO API keys** on the core surface — you pay Kiro credits which pay AWS which pays the model providers.

### 3b. Access security
- Kiro Assistant talks to Bedrock under your **Kiro Subscription** credentials — no exposed AWS account.
- Enterprise plans can point at a **customer-controlled Bedrock account** in GovCloud / isolated regions.

## 4. Spec-driven development (the flagship feature)

Kiro's core thesis: **human-reviewable specs before agent work.** A **"Feature Spec"** is three files, all stored in-repo under `.kiro/specs/<feature>/`:

### 4a. `requirements.md`
- User stories + **acceptance criteria in EARS notation** (Easy Approach to Requirements Syntax).
- EARS template: **"WHEN [condition] THE SYSTEM SHALL [expected behavior]."**
- Benefits: formal reasoning, property-based testing, non-native-English-friendly.

### 4b. `design.md`
- Technical architecture — components, data flow, interfaces (TypeScript types, API contracts), sequence diagrams (Mermaid), data models.
- Generated from the requirements doc + existing codebase context.

### 4c. `tasks.md`
- Sequenced implementation steps with completion tracking.
- Kiro can execute tasks **one-by-one or in batches**.
- **Tasks update dynamically** as implementation progresses (marking complete, refining remaining work).

### 4d. Workflow variants
- **Top-down:** start with requirements → design → tasks → code.
- **Retrofit:** start from existing code + add specs (for already-started features).

Specs are **diffable, reviewable, and versioned in git** — arguably the most human-readable planning artifact in any AI coding product.

## 5. Steering files

Separate from specs: **per-project or global "steering files"** hold persistent context. Live in `.kiro/steering/`.

Uses:
- Coding standards, style guides.
- Preferred workflows ("always run `npm test` after changes").
- Domain terminology.
- Tool preferences.

**The steering files are the agent's memory between sessions** — injected into every prompt for that project / globally.

## 6. Agent hooks (the automation primitive)

Event-driven agent actions stored in `.kiro/hooks/`:

### 6a. Trigger types
- **File events**: `created`, `saved`, `deleted`.
- **Prompt/agent lifecycle**: `prompt_submit`, `agent_stop`, `pre_tool_use`, `post_tool_use`.
- **Spec task events**: `pre_task_execution`, `post_task_execution` (added 2026).
- **Manual trigger** — a custom button in the IDE.

### 6b. Hook actions
Natural-language hook definitions describe what the agent should do on trigger. Examples:
- "When a component file is saved, update the corresponding test file."
- "When a task completes, run `npm run lint` and `npm test`."
- "Before any tool use, check if it's modifying the `payments/` directory and require approval."

Hooks effectively let Kiro **operate as a continuous background agent** responding to your work — the closest thing to "persistent agent attention" in an IDE.

## 7. Autonomous agent (preview)

Announced at AWS re:Invent 2025:

- **Runs asynchronously** — you assign it a task; it works while you focus on something else.
- **Up to 10 concurrent tasks.**
- **Sub-agent coordination** — specialized sub-agents for research/planning, coding, and verification.
- **Cross-session memory** — remembers feedback like "always use our standard error handling pattern" across sessions.
- **Multi-repo awareness** — can treat multiple repositories as a unified task (e.g., a feature spanning frontend + backend repos).
- **Preview with weekly limits** on Pro, Pro+, Power tiers.

This is Kiro's push into "autonomous engineering agent" territory, closer to Factory's droid model.

## 8. MCP support

**Native, first-class** MCP integration:

- **Local and remote MCP servers** both supported.
- **MCP configuration** in `.kiro/mcp.json` at project level or `~/.kiro/mcp.json` globally.
- **Bedrock AgentCore** integration — wire Kiro to MCP-backed Bedrock agents.
- Use cases: docs lookup, database queries, API calls, custom tools.

## 9. Multi-agent architecture

- **Kiro autonomous agent** coordinates three sub-agent roles: research/planning, coding, verification.
- **Agent hooks** can trigger specialized sub-agents on events.
- **Not a general-purpose multi-agent framework** — not like Letta or FlowForge where you define arbitrary agents. Roles are opinionated to the spec-driven workflow.

## 10. Integrations

- **Git** — integrated commit-message generation, diffs, diagnostics.
- **VS Code settings import.**
- **Open VSX extensions.**
- **Bedrock AgentCore** — AWS-native agent infra.
- **MCP** — any standards-compliant MCP server.
- **AWS services** via MCP (e.g., Amazon DynamoDB MCP, Amazon S3 MCP).
- **Chat + CLI + IDE** all share the same backend and spec state.

## 11. Pricing (at GA)

| Plan | Price | Credits/mo | Features |
|---|---|---|---|
| **Free** | $0 | 50 | Basic chat, limited hooks |
| **Pro** | $20/mo | 1,000 | Full feature set, Sonnet 4.5 |
| **Pro+** | $40/mo | 2,000 | Higher limits, Opus access |
| **Power** | $200/mo | 10,000 | Highest limits, autonomous agent preview |
| **Enterprise** | Custom | Custom | SAML/SCIM SSO, analytics, GovCloud |

- **Overage:** $0.04 per credit.
- **500 bonus credits** for new signups.
- **GovCloud** ~20% premium, no free tier.
- **Sonnet 4 pinned** costs ~1.3× Auto mode per call.

## 12. Enterprise features

- **SAML / SCIM SSO.**
- **Usage analytics dashboards.**
- **GovCloud availability.**
- **Customer-controlled Bedrock account** option.
- **Audit logs** of agent actions.

## 13. Strengths

1. **Spec-driven development is a genuine IDE-level differentiator** — no other product ships EARS + design + tasks as three diffable artifacts.
2. **Agent hooks** are the cleanest event-driven automation in any coding tool today.
3. **Cross-platform + CLI + headless CI/CD** — the most complete surface set.
4. **AWS backing** — infinite runway, enterprise GTM, GovCloud, compliance.
5. **Code OSS fork** — VS Code ergonomics with compat layer for most extensions.
6. **First-class MCP** — local + remote, AWS integration via Bedrock AgentCore.
7. **Transparent pricing** — credit-based, predictable at Pro/Pro+/Power tiers.
8. **Steering files** + spec files give **human-reviewable project memory**, not black-box context.

## 14. Weaknesses

1. **Locked to Bedrock routing** — no BYO keys, no direct Anthropic / OpenAI path on the core product.
2. **Single agent in IDE** (outside preview autonomous agent) — doesn't orchestrate many sessions in parallel the way Conductor does.
3. **Credit model unpredictable** — overage costs can surprise; Sonnet 4 pinned is 1.3× Auto.
4. **Spec-driven workflow adds up-front overhead** — wrong fit for quick exploratory or throwaway code.
5. **Autonomous agent still preview** — weekly limits; production reliability unclear.
6. **Microsoft-exclusive VS Code extensions don't work** (Open VSX gap).
7. **Kiro is an AWS product** — customers with multi-cloud or non-AWS strategies may resist.
8. **No OSS path** — closed source; you can't self-host.

## 15. Who it's for

- **Teams that value up-front spec rigor** — companies with change-management or compliance requirements.
- **AWS-aligned organizations** — natural fit if your infra is already on AWS.
- **Developers who want VS Code ergonomics + agent features** without switching to Cursor or Claude Code.
- **Non-native English speakers writing requirements** — EARS is a documented aid.
- **Enterprise teams wanting SSO / audit / GovCloud** — rare combination in AI coding.

## 16. Changelog (2025–2026 highlights)

- **Jul 2025:** Public preview launch.
- **Nov 17, 2025:** GA + four-tier pricing (Free/Pro/Pro+/Power).
- **AWS re:Invent 2025:** Werner Vogels keynote feature; autonomous agent preview; pre/post task execution hooks.
- **Feb 2026:** Claude Sonnet 4.6 support; GovCloud availability; Agent Plugins.
- **Early 2026:** Kiro CLI 2.0 (Windows + headless CI/CD); ACP support for third-party agent integration.

## 17. Sources

- [Kiro homepage](https://kiro.dev/)
- [Kiro Documentation (AWS)](https://aws.amazon.com/documentation-overview/kiro/)
- [Kiro Docs — Specs](https://kiro.dev/docs/specs/)
- [Kiro Docs — Feature Specs](https://kiro.dev/docs/specs/feature-specs/)
- [Kiro Docs — Best practices](https://kiro.dev/docs/specs/best-practices/)
- [Kiro Docs — Model selection](https://kiro.dev/docs/chat/model-selection/)
- [Kiro autonomous agent](https://kiro.dev/autonomous-agent/)
- [Kiro autonomous agent docs](https://kiro.dev/docs/autonomous-agent/)
- [Introducing Kiro blog](https://kiro.dev/blog/introducing-kiro/)
- [Introducing Kiro autonomous agent blog](https://kiro.dev/blog/introducing-kiro-autonomous-agent/)
- [Kiro pricing](https://kiro.dev/pricing/)
- [Kiro changelog](https://kiro.dev/changelog/)
- [Kiro GitHub](https://github.com/kirodotdev/Kiro)
- [AWS Weekly Roundup — Kiro GA](https://aws.amazon.com/blogs/aws/aws-weekly-roundup-how-to-join-aws-reinvent-2025-plus-kiro-ga-and-lots-of-launches-nov-24-2025/)
- [AWS Weekly Roundup — Sonnet 4.6 + Kiro GovCloud (Feb 2026)](https://aws.amazon.com/blogs/aws/aws-weekly-roundup-claude-sonnet-4-6-in-amazon-bedrock-kiro-in-govcloud-regions-new-agent-plugins-and-more-february-23-2026/)
- [DEV Track Spotlight: Spec-driven development (DEV314)](https://dev.to/aws/dev-track-spotlight-spec-driven-development-with-kiro-dev314-45e8)
- [DEV Track Spotlight: Kiro + MCP + Bedrock AgentCore (DEV331)](https://dev.to/aws/dev-track-spotlight-building-ai-agents-with-kiro-mcp-and-amazon-bedrock-agentcore-dev331-jf1)
- [Constellation Research — Kiro autonomous agents](https://www.constellationr.com/blog-news/insights/aws-kiro-launches-autonomous-agents-individual-developers)
- [Caylent — Kiro first impressions](https://caylent.com/blog/kiro-first-impressions)
- [Morphllm — Spec-driven development guide](https://www.morphllm.com/spec-driven-development)
