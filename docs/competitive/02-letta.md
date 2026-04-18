# Letta (letta.com) — Deep Dive

**Last reviewed:** 2026-04-17
**Category:** Open-source stateful-agent platform (formerly MemGPT)
**One-line pitch:** Apache-2.0 framework + hosted platform for building AI agents with persistent, tiered, agent-editable long-term memory — the reference implementation of "stateful agents."

---

## 1. Company & traction

- **Origin:** UC Berkeley Sky Computing Lab. **MemGPT** paper (Packer & Wooders, 2023) became the product.
- **Founders:** Sarah Wooders (CEO) & Charles Packer (CTO).
- **Funding:** **$10M seed** led by Felicis (Sept 2024) at ~$70M post-money. Angels include Jeff Dean, Clem Delangue, Cristobal Valenzuela. No 2025–2026 follow-on publicly confirmed.
- **GitHub:** **22k+ stars** on `letta-ai/letta`, Apache-2.0.
- **Ecosystem:** Active Discord; extensive tutorials and community integrations.

## 2. What's in the box

### 2a. Letta server
A Python server + REST API. The core runtime for agents: holds agents, memory, tools, conversations, and the LLM call loop. Packaged as a Docker image.

### 2b. SDKs & APIs
- **Python SDK** (`letta-client`)
- **TypeScript SDK** (`@letta-ai/letta-client`)
- **REST API** (port 8283)
- **Conversations API** — shared memory across parallel user sessions for consumer-facing agent products.

### 2c. ADE — Agent Development Environment
Web GUI for inspecting/building agents. Shows:
- **Live context window state** (what's pinned, what's in recall, what's in archival).
- Memory-edit tool calls in real time.
- Tool call traces, messages, reasoning tokens.
- The closest thing in the cohort to a "mechanistic interpretability UI" for production agents.

### 2d. Letta Code
A memory-first coding agent, shipped as:
- Desktop app (Mac/Windows/Linux).
- `@letta-ai/letta-code` npm CLI.

Built on Letta's agent primitive — same memory system, same server, wrapped as a coding agent.

### 2e. Letta Evals
Regression-testing framework for stateful agents. Tests memory retention, tool accuracy, multi-session consistency.

## 3. Runtime substrate

- **Python server** + **PostgreSQL** for persistence (SQLite for dev).
- **pgvector** extension required for archival memory.
- **Docker**: `docker pull letta/letta` and run; exposes port 8283. Supports external Postgres via `LETTA_PG_URI`. Auto-runs migrations on start. AWS Aurora integration officially documented.
- **Self-host or cloud**: `app.letta.com` is the hosted platform.

## 4. The memory architecture (the differentiator)

Letta's memory is **tiered, inspired by computer architecture**, and **agent-editable**:

### 4a. Core memory — "RAM"
- **Memory blocks**: labeled, size-bounded, string-valued context units pinned in the system prompt.
- Examples of default blocks: `human` (who am I talking to), `persona` (who am I), plus arbitrary user-defined blocks.
- **Agent edits them directly** via tools: `memory_replace`, `memory_insert`, `memory_rethink`.
- **Shared blocks**: a single block can be attached to multiple agents — cross-agent shared state.

### 4b. Recall memory — "disk cache"
- Full conversation history, stored out-of-context in the DB.
- Searchable via `conversation_search` and `conversation_search_date`.
- Auto-populated — every message goes here when it leaves the message buffer.

### 4c. Archival memory — "cold storage"
- Vector DB-backed, out-of-context.
- Agent inserts facts via `archival_memory_insert` and retrieves via `archival_memory_search`.
- Hybrid search: vector + full-text + date filters.
- This is where summarized / consolidated knowledge lives.

### 4d. Agent-managed paging
The message buffer has a soft limit. When it fills, messages evict to recall/archival **and the agent can proactively move them**. This is the MemGPT innovation: the agent is the memory manager.

### 4e. Memory sub-agents
Background agents continuously summarize, compact, and consolidate memory — the closest thing in the industry to a "dream cycle" shipped in production.

## 5. Agent loop

### 5a. Two architectures shipped side-by-side
- **ReAct agent** — classic Reason→Act loop with tool calls, no long-term memory.
- **MemGPT agent** — ReAct + tiered memory + memory-editing tools.

### 5b. letta_v1_agent — 2026 rearchitecture
Letta rebuilt the agent loop ("Lessons from ReAct, MemGPT, and Claude Code"). Key changes:
- **Deprecated heartbeats** and the `send_message` tool.
- **Native reasoning + direct assistant messages** — no tool-call-forced message shape.
- **Any LLM works** — tool-calling support no longer required, enabling models that generate assistant messages natively.
- Significant latency + perf improvements for Claude Opus 4.5 / GPT 5.2 / Gemini 3.

### 5c. Tool architecture
- **Server-side tools**: sandboxed Python functions registered with the server; Letta runs them in isolation.
- **Client-side tools**: SDK-registered tools executed in the client process.
- **MCP tools**: schema ingested from MCP server; execution is external.
- Every action is a tool call (MemGPT lineage).

### 5d. Skills
Letta Code implements the **open Agent Skills standard** — same skill format as Cursor, Claude Code, VS Code agents. A dedicated **skills memory block** holds metadata; because memory blocks are always visible, the agent discovers and loads skills dynamically during execution. **Portable skills across agent platforms** is a unique claim.

### 5e. Subagents (Letta Code)
- **Seven built-in subagent types** (explore, code-reviewer, others — full list not public).
- Custom subagents authorable.
- **Subagent tool ("Task")**: main agent delegates; Letta Code spawns a new subprocess of Letta Code with its own system prompt, tools, and model.
- **Fresh by default** — not reused across invocations.
- Final message returned to main agent; main context stays clean.

## 6. Multi-agent coordination

Letta treats multi-agent as first-class:

- **Cross-agent message passing** via built-in tools.
- **Shared memory blocks** — attach one block to N agents.
- **Subagents** (Letta Code pattern) for task delegation with context isolation.
- **Conversations API** — shared memory across parallel user sessions.
- **Group-chat / brainstorming patterns** supported via free-form cross-agent messaging.

## 7. Model flexibility (best in cohort)

- **Model-agnostic**: OpenAI, Anthropic, Google, open-weight models (Llama, Mistral, DeepSeek, Qwen), local models via Ollama / vLLM / LM Studio.
- **State is portable across models**: an agent's state can survive swapping Claude Opus 4.5 → GPT 5.2 → Gemini 3 because state lives in the DB (blocks + recall + archival) not in the model or the CLI.
- **No tool-call requirement** in letta_v1_agent — any LLM works.
- **Reasoning effort / thinking tokens** passed through where the model supports it.

## 8. Planning & brainstorming

- **Planning is emergent** from the agent loop — no dedicated spec/plan artifact.
- **MemGPT-style reasoning** with memory-aware tool calls is the planning surface.
- **Group-chat patterns** (via cross-agent messaging) enable brainstorming — the free-form, multi-voice mode where agents debate a problem.
- **No EARS-style requirements files or PRD workflow** built in.
- Planning is more "agent thinks out loud while editing memory" than "human approves a plan document."

## 9. Integrations

- **MCP client** — first-class, local + remote.
- **Model providers** — OpenAI, Anthropic, Google, Groq, Together, Ollama, vLLM, LM Studio, Mistral.
- **Vector DBs** — pgvector (native); others via tool integration.
- **Observability** — LangSmith, LangFuse, Weights & Biases (via SDK hooks).
- **Agent skills** — shares the Agent Skills standard with Claude Code / Cursor / VS Code.
- **Weak on developer-tool integrations** — no first-party GitHub / Linear / Jira / Slack connectors. Users wire via MCP.

## 10. Deployment / pricing

- **Letta server**: Apache-2.0, free to self-host. Docker image `letta/letta`. External Postgres via `LETTA_PG_URI`.
- **Letta Cloud** (app.letta.com): hosted platform, pay for compute + storage.
- **Letta Code**: desktop + CLI, free with your own model API keys.
- **No published enterprise price sheet**.

## 11. Strengths

1. **Best-in-class persistent memory** — tiered, agent-editable, evictable, consolidatable. The memory-blocks abstraction is the industry reference.
2. **Fully open source (Apache-2.0)** with 22k+ GitHub stars and strong community.
3. **State portability** across LLM providers — the only platform where switching models doesn't lose agent state.
4. **ADE UI** provides unprecedented visibility into the agent's context + memory state.
5. **Multi-agent as first-class** — cross-agent messaging and shared blocks, not bolted on.
6. **Agent Skills standard adoption** — portable skills across Cursor / Claude Code / VS Code / Letta Code.
7. **Self-host + cloud + desktop + CLI** — every deployment model.
8. **Published research lineage** (MemGPT paper) gives academic credibility.

## 12. Weaknesses

1. **Framework-shaped, not product-shaped** — you build your agent, Letta provides primitives. No turnkey SDLC workflow (vs. Factory / 8090 / Kiro).
2. **Thin developer-tool integrations** — GitHub / Linear / Jira / Slack require MCP wiring.
3. **Self-host has real ops burden** — Postgres with pgvector, Docker, migrations, env config.
4. **Letta Code is newer and less polished** than the core framework — it's Anthropic's Claude Code with Letta memory grafted on (conceptually), competing against mature coding IDEs.
5. **No published enterprise GTM motion** at Factory's scale.
6. **Small company** (~$10M raised publicly) — execution risk vs. well-capitalized competitors.
7. **Documentation and onboarding** are improving but have a learning curve — agent memory concepts are not mainstream.

## 13. Recent news / changelog

- **2024 Sept:** Letta emerges from stealth; $10M seed at $70M post-money.
- **2025:** Core server GA; ADE UI; Agent Evals framework.
- **2025 H2:** letta_v1_agent architecture (native reasoning, dropped heartbeats).
- **2026 Q1:** Letta Code launch (desktop app + npm CLI); Conversations API; skills as first-class; Aurora / AWS integration guide; Context-Bench adding Skills benchmark.

## 14. Sources

- [Letta homepage](https://letta.com)
- [Letta GitHub (Apache-2.0)](https://github.com/letta-ai/letta)
- [Letta Docs — Core concepts](https://docs.letta.com/core-concepts/)
- [Letta Docs — Memory blocks](https://docs.letta.com/guides/agents/memory-blocks/)
- [Letta Docs — ReAct vs MemGPT](https://docs.letta.com/guides/agents/architectures/react)
- [Letta Docs — Multi-agent](https://docs.letta.com/guides/agents/multi-agent/)
- [Letta Docs — Letta Code Subagents](https://docs.letta.com/letta-code/subagents/)
- [Letta Docs — Skills](https://docs.letta.com/letta-code/skills/)
- [Letta Docs — Docker deployment](https://docs.letta.com/guides/docker/)
- [Docker Hub: letta/letta](https://hub.docker.com/r/letta/letta)
- [AWS Aurora + Letta production guide](https://aws.amazon.com/blogs/database/how-letta-builds-production-ready-ai-agents-with-amazon-aurora-postgresql/)
- [Letta blog — v1 agent loop](https://www.letta.com/blog/letta-v1-agent)
- [Letta blog — Memory blocks](https://www.letta.com/blog/memory-blocks)
- [Letta blog — Introducing Letta Code](https://www.letta.com/blog/introducing-the-letta-code-app)
- [Letta blog — Letta Code: memory-first](https://www.letta.com/blog/letta-code)
- [Felicis — Letta seed](https://www.felicis.com/blog/letta)
- [TechCrunch — Letta out of stealth](https://techcrunch.com/2024/09/23/letta-one-of-uc-berkeleys-most-anticipated-ai-startups-has-just-come-out-of-stealth/)
- [Mem0 vs Letta (Vectorize.io)](https://vectorize.io/articles/mem0-vs-letta)
