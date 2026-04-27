# About Allen

## What Allen is

Allen is an **AI agent orchestration platform for software engineering work**. It coordinates teams of specialized AI agents — each one a long-running coding assistant with its own role, memory, and skills — to plan features, implement them, fix bugs, review pull requests, and operate the resulting code in production.

Where most coding assistants are a single chat box talking to a single model, Allen is closer to a small engineering organisation. Agents are grouped into teams. A workflow engine wires them into repeatable pipelines. They work inside real, isolated copies of your codebase so they can edit, build, test, and push without colliding with each other or with you. A control plane (chat, Slack, scheduled triggers) lets humans drop work in and get pull requests back.

If you have used a standalone coding agent like Claude Code or Codex CLI, Allen is the layer above them: it runs those agents as workers, gives them a single shared surface to act on (your repos, your workflows, each other, your data), and remembers everything so work survives restarts and can be handed off.

---

## The mental model in one paragraph

A request comes in — from chat, from Slack, from a scheduled trigger. It lands on a **chat session** owned by a particular agent. That agent is given a working environment, the tools it is allowed to use, and a memory of past relevant work. As the agent thinks, it can take actions: run a workflow, ask another agent for help, work inside a copy of a repository, query historical data, ask the human a question. Every action is recorded and streamed live to whoever is watching, and every result is durable, so a long task can pause for a human answer or survive a restart and pick up where it left off. When the agent is done, the result flows back to the originator — a chat reply, a Slack thread response, a pull request, a workflow execution report.

---

## How a single request flows

This is the path to hold in your head; almost everything else is a variation on it.

1. **A request arrives.** A user types in the chat UI, mentions Allen in a Slack thread, or a scheduled trigger fires. Each of these maps to a chat session.
2. **An agent is chosen.** Either the user picked one explicitly, or a default orchestrator is used. The agent has a role, a personality (system prompt), a list of tools it is allowed to use, and the model it should run on.
3. **The agent starts working.** It receives the request along with relevant context: prior messages in the session, learnings from past similar work, the current state of any repos or pull requests it might touch.
4. **The agent takes actions.** It can run workflows, ask other agents for help, edit code in an isolated workspace, run commands, query historical data, or ask the human a question and wait. Every action is captured as a step in the session's trace.
5. **Results stream back live.** The UI shows the agent's thinking, the actions it takes, and the results of those actions in real time. Costs, durations, and tool calls are recorded.
6. **The session is durable.** Even after the agent finishes, the entire conversation, every action, every result, every cost number is preserved. The next time the same agent is asked something related, it can be told to resume the same session and continue from where it left off — without re-reading the entire history.

That same pattern — *route a request to an agent, let it act on the system, persist everything, stream it live* — is reused for direct chat, for delegation between agents, for workflow steps, and for Slack threads.

---

## Agents and teams

### What an agent is
An agent in Allen is a configured worker, not just a system prompt. It has:

- A **role and personality** — what it is good at and how it should behave.
- A **provider and model** — which underlying coding agent powers it (see the provider section below) and which size of model it should use.
- A **toolset** — the specific actions it is allowed to take. A reviewer agent might be allowed to read code and post comments but not push. A builder agent might be allowed to do everything.
- A **team and a role within that team** — for example, "lead of the Backend team."
- A **delegation graph** — the explicit list of other agents it is allowed to ask for help. This is the spine of safe collaboration: you can build deep delegation hierarchies without worrying that the wrong agent will be pulled in.

### Why teams exist
Teams are the organisational unit. Out of the box Allen ships with teams modelled on a real engineering org — Architecture, Backend, Frontend, QA, Platform, DevOps, Design, Product, Admin, plus a Meta team that builds and maintains other agents. Teams can nest. Each team has a lead (the orchestrator who receives requests and parcels them out) and members (the specialists). You can edit any of them or build your own from scratch.

### How delegation actually works
When one agent asks another for help, the request does **not** block. Instead:

1. A delegation conversation is opened between the two agents.
2. The asked-for agent starts working in the background, in its own session, with its own toolset and model.
3. The asking agent is free to keep doing other things, or to wait.
4. If the asked-for agent needs more information, it can ask the asker — and that question can in turn be bubbled all the way up to the human who started the chain.
5. When the asked-for agent finishes, its full reply (and a summary, and a cost, and a duration) is returned.

The whole tree — from the original human request, through every layer of delegation — is reconstructable. The UI renders it as a tree so you can inspect what each agent was asked, what it did, what it cost, and what it returned. Because state is durable, even very deep, very long delegations survive a server restart.

---

## Workflows

Workflows are the deterministic counterpart to free-form chat. A workflow is a defined sequence of steps — written in a structured, human-readable format — that mixes AI agent steps with predictable building blocks. They are the right answer when you want the same outcome every time (a feature gets planned, implemented, tested, and shipped through the same gate every time, not "whatever the agent felt like doing today").

### What a workflow looks like
A workflow is a graph of steps with edges (which step runs after which) and conditions (which path to take). Each step is one of:

- **An agent step** — runs a specific agent against a prepared prompt, with the inputs of earlier steps available to it.
- **A built-in step** — a predictable building block: create a branch, commit, push, open a pull request, run the build, run the tests, classify a task, persist a design document, create a workspace, prompt the user for input.
- **A human step** — the workflow pauses and waits for a human to answer something. The pause is durable: it can sit there for hours or days. When the human answers (from the UI, from Slack, anywhere), the workflow picks up exactly where it stopped.
- **A nested workflow step** — runs another workflow as part of this one. Bounded so a workflow cannot recursively run itself into the ground.
- **A condition step** — branches the flow based on the data so far.

### What an execution does
When a workflow runs:

- An execution record is created. From that moment on, every step, every input, every output, every cost is recorded against it.
- Independent steps run in parallel; dependent ones wait. The engine figures this out from the graph.
- Outputs from each step flow into a shared state that later steps can read. So the "plan" produced by a planning step is automatically available to the implementation step.
- A live log of the execution streams to the UI. You can watch a workflow run end-to-end, see the model's thinking on each step, and see the outputs as they accrue.
- If a step fails, the engine records why. Some steps can retry; others halt the execution for a human to look at.
- When a human-input step is hit, the engine writes the state to disk and returns. There is no timer ticking down — the workflow is paused indefinitely until input arrives.

### What ships out of the box
Reference workflows for common engineering loops are included: a general coding workflow, a feature plan-and-implement workflow, a bug investigate-and-fix workflow, a workflow for resolving pull-request review comments, and a workflow for understanding an unfamiliar area of code and producing a plan. They are starting points; they are meant to be edited.

---

## The agent's working surface

Every agent in Allen sees the same unified set of capabilities. Conceptually, an agent can:

- **Run, inspect, and create workflows.** Including waiting for one to finish, cancelling one, submitting input to a paused step, reading the trace of any single step.
- **Discover, create, edit, and spawn agents and teams.** Agents that build other agents are first-class — there is a Meta team specifically for this.
- **Delegate to other agents.** Open a conversation, send a task, wait for the answer, ask follow-up questions, answer questions sent up to it.
- **Ask the human.** Either a quick question routed to whoever started the chain, or a structured report.
- **Work with repositories, pull requests, and workspaces.** Find which repository owns a pull request, get the context of a repository, create an isolated working copy of a repo for a task, link work to an existing pull request.
- **Inspect itself and its history.** What did I do in this session? What was my last delegation? What did the user say earlier? This is what makes long-running and resumed work coherent.
- **Read historical data.** Read-only access to Allen's own data store so the agent can answer questions about past executions, prior decisions, and patterns.
- **Save artifacts.** Design documents, plans, structured data files — preserved separately from the chat trace so they can be shared and referenced later.

This unified surface is the most important property of Allen. The same agent can plan a feature, run the workflow that implements it, ask another agent to review the resulting pull request, and report back to the human — without having to learn a different way of doing each of those things.

---

## Workspaces: real isolated copies of your code

Allen does not run agents against your live working tree. For every task that needs to touch code, an **isolated workspace** is created.

- A workspace is a real, complete copy of the repository on a fresh branch, sitting on the server in its own directory. Multiple agents can work on the same repo at the same time without colliding with each other.
- Each workspace gets its own port range, so an agent can start a dev server inside the workspace and it will not clash with another workspace's dev server.
- A live preview is available: the workspace's running dev server is reachable through a per-workspace URL, so the agent (or you) can actually see the change in a browser before it is shipped.
- A real terminal is exposed in the UI for any workspace. A human can drop in mid-task, run commands, inspect what the agent did, and either help it along or take over.
- File changes are visible live. As the agent edits, the UI updates.
- Workspaces are linked to chat sessions and pull requests, so the trail from "request" → "workspace" → "branch" → "PR" is always recoverable.
- Cleanup is opt-in. The underlying repository copy is cached and reused, so the next task starts fast.

The multi-tab and multi-human story is taken care of: if a human in one browser tab answers a question the agent asked, every other open tab notices and dismisses the same prompt, so two people do not end up answering twice.

---

## Scheduled work

Anything an agent or workflow can do can also be put on a schedule.

- A scheduled job points at an agent or a workflow with a specific input, and a schedule (recurring, like cron, or one-off).
- When the schedule fires, the job runs through exactly the same path as a human-triggered run — same logging, same trace, same UI surface. There is no "second-class scheduled mode" that behaves differently from interactive use.
- Each job tracks its own history: when it last ran, how long it took, what it produced, whether it succeeded.
- If the server crashes mid-run, the run is recovered on the next boot — no orphaned ghost jobs.
- A handful of built-in maintenance jobs ship by default: keeping repositories in sync, syncing pull-request state, and housekeeping.

---

## Slack as a first-class surface

A Slack thread in your workspace can be a live conversation with Allen.

- When Allen is mentioned in a thread, a chat session is created and the entire thread history up to that point is fed in as context.
- Subsequent messages in the same thread continue the same session. The thread *is* the conversation.
- Replies post back into the same thread.
- The same agent capabilities are available — running workflows, delegating, working in workspaces, asking questions — exactly as they would be in the UI. A Slack thread can therefore drive a real piece of work all the way from "hey can you look at this bug" to a posted pull request, without anyone leaving Slack.
- In the Allen UI these sessions show up alongside web sessions but are read-only, so a human in the UI cannot accidentally double-reply on top of Slack.

---

## Issue tracking integration

Allen integrates with issue trackers (Linear shipping today) on two levels:

- **Read** — agents can list issues, projects, teams, comments, filtered by status; they can use this context when planning or fixing.
- **Act** — agents can update tickets, close them, add comments; the same surface a human would use.

This means a workflow can start from a ticket, do the work, link a pull request, and update the ticket — without humans copying and pasting between systems.

---

## Memory and learnings

Allen has a memory system that is **separate from chat history**.

- After a piece of work finishes, the trace is scanned for things worth remembering: explicit user preferences ("always use staging for this"), recurring failures, decisions that should not be re-litigated next time.
- Each becomes a **learning**: a small, structured note labelled with what kind of thing it is (a preference, a fact, a pattern, a warning).
- When a new request comes in, the system finds learnings that look relevant and quietly hands them to the agent as additional context, so it does not need to be told the same thing twice.
- Learnings can be reviewed, edited, or removed. They are not a black box.

This is what makes Allen feel like it is getting better the more you use it: not because the model is being trained, but because the system is accumulating real, inspectable institutional knowledge.

---

## How a human stays in control

A platform that lets agents push code is only useful if the human can intervene cleanly. Allen builds this in:

- **Ask-the-human is a first-class action.** Any agent can pause and ask. The question shows up in the UI and Slack, the answer flows back, the agent continues.
- **Workflows can pause indefinitely on human steps.** A multi-day approval flow with a step gated on a human is not awkward — it is the intended pattern.
- **Every action is traced.** What the agent did, what arguments it used, what came back, how long it took, how much it cost — all visible per message and per workflow step.
- **Live terminals on workspaces.** A human can drop into the agent's working environment at any time.
- **Multi-tab safety.** Two humans in two tabs cannot accidentally answer the same prompt twice.
- **The Meta team.** Agents that themselves build and maintain other agents — useful, but their delegation graph is gated, so a runaway agent cannot silently rewrite the rest of the org.

---

## Provider matrix

Allen is **multi-provider**. Each agent picks which underlying coding agent powers it.

| Provider | What it is | Models | Streaming | Resumable | Status |
|---|---|---|---|---|---|
| **Claude Code** | Anthropic's standalone coding agent | Haiku, Sonnet, Opus (4.x family) | Yes | Yes | First-class, default |
| **Codex CLI** | OpenAI's standalone coding agent | gpt-5.x, o3, o4-mini, codex-mini | No | Yes | Supported |

There is no direct integration with any model provider's raw API. Every model call goes through one of the two coding agents above. The trade-off is intentional: Allen inherits each one's tool-calling loop, streaming, and session-resume behaviour automatically, and adding a new provider is a matter of teaching Allen how to talk to that one coding agent — not how to talk to that whole model family.

Per-agent, the provider and model are independently configurable. An Opus orchestrator can delegate to Haiku workers. A Claude planner can hand off to a Codex implementer. You can run a single team across both providers if you want a second opinion on every decision.

---

## What is NOT in Allen yet

The honest list — things people might assume are present but are not, or are partial.

**Provider coverage**
- Only the two coding agents above. No direct support for raw model providers, no local models, no third coding agent (yet).
- No per-agent cost caps or usage budgeting beyond what each underlying provider already enforces.

**Multi-tenancy**
- Single-tenant by design today. There is no organisation or workspace boundary above the user.
- Auth is invite-only with role flags. No single-sign-on, no enterprise identity sync, no audit-log export.

**Sharing**
- Agents, teams, and workflows are local to each install. There is no public registry, no "share an agent by link," no marketplace.
- An importer for external coding-agent specs exists but is narrow.

**Observability**
- Full execution traces with a UI viewer, but no export to external monitoring systems and no out-of-the-box dashboards or alerting on agent failure, cost, or latency.

**Sandboxing**
- Agents run in real environments on the host. There is no per-agent container or virtual-machine isolation. The trust boundary is "you trust the agents you install."

**Scaling limits**
- The scheduler is in-process. Fine for thousands of jobs; not for tens of thousands.
- The memory system uses an in-process similarity search. Fine for a moderate corpus; not for a corpus the size of a large company's institutional knowledge.
- Delegation waits are based on polling rather than persistent connections. Works well at the scale Allen is designed for; would need rework at very large scale.

**Integrations**
- Shipped: Slack, Linear, GitHub, Claude Code, Codex CLI.
- Not yet: Jira, GitLab, Bitbucket, Notion, Discord, paging tools, error trackers, generic outbound webhooks.

**Deployment**
- One blessed deployment target today (AWS). No managed-cloud option, no one-click installer.
- Local development is well-trodden; production deployment assumes that one target.

**Mobile and public API**
- No mobile app.
- An HTTP API exists but is not versioned or documented as a public surface; it is intended for the UI.

**Operational housekeeping**
- The encryption master key for stored secrets must be rotated by hand. There is no built-in rotation flow.
- Spawned agents have access to the secrets they need at runtime — agents you do not trust should not be installed.

---

## Where Allen fits

- **vs. a single coding agent on its own.** Allen runs them as workers and adds team structure, memory, persistence, workflows, scheduling, and a shared action surface. If you only need one chat with one model on your own laptop, you do not need Allen.
- **vs. a generic workflow tool.** Allen has a workflow engine, but each step is an AI agent first, not a generic API call. Use a generic workflow tool if your steps are mostly deterministic; use Allen if your steps are mostly "have an agent figure this out."
- **vs. a hosted autonomous-agent product.** Allen is self-hosted, multi-agent, and exposes its orchestration primitives (teams, delegation, workflows, scheduling) as first-class objects you can edit and own. It is a platform, not a finished product.
