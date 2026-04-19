# Multi-Agent Team System — Implementation Plan

## Overview

Users talk to **team agents** (PM, Engineer, QA, CEO, Analyst) who behave like real team members. They think, delegate to each other, trigger workflows, and report back — all visible in chat as collapsible agent-to-agent threads.

---

## Current State

### Existing Agents (Technical)
| Agent | Used By | Purpose |
|-------|---------|---------|
| coding-planner | coding-agent workflow | Senior architect, task analysis, planning |
| coding-developer | coding-agent workflow | Code implementation |
| coding-reviewer | coding-agent workflow | Code review |
| coding-investigator | coding-agent workflow | Bug investigation |
| coding-tester | coding-agent workflow | Test writing and execution |
| coding-writer | coding-agent workflow | Documentation |
| git-ops | coding-agent workflow | Git operations, PR creation |
| mcp-tester | standalone | MCP server connectivity testing |

### Existing Workflows
| Workflow | Nodes | Purpose |
|----------|-------|---------|
| coding-agent | 14 | Full SDLC: analyze → plan → implement → test → review → PR |

---

## Architecture

```
User → Chat → Team Agent (PM)
                 │
                 ├── thinks about the request
                 ├── decides who to involve
                 │
                 ├── delegates to Engineer (team agent)
                 │     ├── Engineer analyzes feasibility
                 │     ├── Engineer spawns coding-planner (technical agent)
                 │     └── Engineer runs coding-agent workflow
                 │
                 ├── delegates to QA (team agent)
                 │     └── QA spawns coding-tester, writes test plan
                 │
                 ├── delegates to Analyst (team agent)
                 │     └── Analyst queries Postgres/MongoDB via MCP
                 │
                 └── synthesizes results → responds to user
```

---

## Data Model

### Agent Definition (enhanced)

```typescript
interface Agent {
  // Existing fields
  name: string;
  system: string;          // system prompt
  model: string;
  provider: string;
  tools: string[];
  icon: string;
  color: string;
  isBuiltIn: boolean;

  // New fields
  type: 'team' | 'technical';     // team = PM/Engineer, technical = coding-planner
  displayName: string;             // "Product Manager", "Senior Engineer"
  personality: string;             // how they think and communicate
  capabilities: string[];          // ['plan-features', 'write-code', 'query-data']
  canDelegateTo: string[];         // ['engineer', 'qa-engineer', 'analyst']
  canTrigger: string[];            // ['coding-agent'] — workflows they can run
}
```

### Default Team Agents

| Agent | Display Name | Delegates To | Triggers | Personality |
|-------|-------------|-------------|----------|-------------|
| product-manager | Product Manager | engineer, analyst, qa-engineer, ceo | — | Strategic thinker. Breaks down requirements, prioritizes, makes product decisions. Asks clarifying questions before planning. |
| engineer | Engineer | qa-engineer, analyst | coding-agent | Technical expert. Analyzes feasibility, designs solutions. Uses technical agents for implementation. |
| qa-engineer | QA Engineer | engineer | — | Quality focused. Writes test plans, finds edge cases, validates implementations. |
| data-analyst | Data Analyst | engineer, product-manager | — | Data-driven. Queries databases via MCP, builds reports, finds patterns. |
| ceo | CEO | product-manager, engineer, analyst | — | Big picture thinker. Asks hard questions about ROI, priorities, and strategy. |
| devops | DevOps Engineer | engineer | — | Infrastructure focused. CI/CD, monitoring, deployments, scaling. |

### Agent-to-Agent Conversation (new collection)

```typescript
// Collection: agent_conversations
interface AgentConversation {
  _id: ObjectId;
  chatSessionId: string;        // parent chat session
  parentMessageId: string;      // which chat message triggered this
  fromAgent: string;            // 'product-manager'
  toAgent: string;              // 'engineer'
  task: string;                 // what was delegated
  status: 'active' | 'completed' | 'failed';
  messages: AgentMessage[];
  summary?: string;             // auto-generated when completed
  costUsd: number;
  durationMs: number;
  startedAt: Date;
  completedAt?: Date;
}

interface AgentMessage {
  agent: string;                // which agent is speaking
  content: string;
  toolCalls?: ToolCallRecord[];
  timestamp: Date;
}
```

---

## New Tools

### `delegate_to_agent`
Team agents use this to start a conversation with another agent.

```typescript
{
  name: 'delegate_to_agent',
  description: 'Start a conversation with another team agent to get their input or delegate a task. The target agent will process the task and return their response.',
  inputSchema: {
    agent_name: 'string (required) — which agent to delegate to',
    task: 'string (required) — what you need from them',
    context: 'object — any relevant context (repo path, ticket info, etc.)',
  }
}
```

**Execution flow:**
1. Creates `agent_conversations` record
2. Loads target agent's system prompt + personality
3. Spawns target agent with task + context + MCP tools
4. Target agent may further delegate (recursive)
5. Response flows back to the calling agent
6. Calling agent continues its work with the response

### `report_to_user`
When the team agent wants to send an update to the user (not just at the end).

```typescript
{
  name: 'report_to_user',
  description: 'Send a progress update or final result to the user. Use for intermediate updates during long operations.',
  inputSchema: {
    message: 'string (required)',
    status: '"in_progress" | "completed" | "needs_input"',
  }
}
```

---

## UI Changes

### 1. Agent Selector in Chat Input

Above the model selector, add an agent picker:
```
[@PM ▾] [Codex/gpt-5.4 ▾]   Message...   shift+enter   [Send]
```

- Default: none (direct chat with Allen Assistant)
- Select PM, Engineer, QA, etc. to route your message through that agent
- Agent avatar shows in the chat header when selected

### 2. Collapsible Agent Threads in Chat

New component: `AgentThread` — renders a nested conversation between two agents.

**Collapsed view:**
```
PM → Engineer: Analyzed dark mode feasibility. 2 days, CSS variables. (23s)
```

**Expanded view:**
```
┌─ PM → Engineer ─────────────────────────────────┐
│ PM: We need dark mode for the app. Analyze       │
│     feasibility and effort.                      │
│                                                   │
│ 🔧 mcp__allen__list_repos                    │
│ 🔧 spawn_role(coding-reviewer, "analyze...")      │
│                                                   │
│ Engineer: CSS variables approach. ~2 days.        │
│           15 components need updating.            │
│           No breaking changes expected.           │
└──────────────────────────── [collapse] ──────────┘
```

### 3. Agents Page (renamed from Roles)

Two sections:

**Team Agents** — cards with avatar, name, personality preview, delegation arrows
```
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ 👔 Product    │ │ 💻 Engineer   │ │ 🧪 QA        │
│    Manager    │ │              │ │    Engineer   │
│              │ │ Delegates to:│ │              │
│ → Engineer   │ │ → QA         │ │ → Engineer   │
│ → QA         │ │ → Analyst    │ │              │
│ → Analyst    │ │              │ │ Triggers:    │
│              │ │ Triggers:    │ │ (none)       │
│              │ │ → coding-agent│ │              │
└──────────────┘ └──────────────┘ └──────────────┘
```

**Technical Agents** — existing agents (coding-planner, coding-reviewer, etc.)

### 4. Agent Conversation Logs

In the conversation logs panel, agent-to-agent threads show as nested entries with:
- Which agents were involved
- Messages exchanged
- Tools used
- Duration and cost per thread

---

## Implementation Phases

### Phase 1: Foundation
**Goal:** Rename roles → agents, add new fields, seed team agents.

**Changes:**
- Add `type`, `displayName`, `personality`, `capabilities`, `canDelegateTo`, `canTrigger` fields to agent schema
- Default `type: 'technical'` for existing agents
- Seed 6 default team agents (PM, Engineer, QA, Analyst, CEO, DevOps) with system prompts
- Rename "Roles" → "Agents" across all UI labels
- Create `agent_conversations` collection

**Files:**
- `seed.ts` — seed team agents
- `App.tsx` — rename sidebar
- `RoleManagerPage.tsx` → rename to agents terminology
- `RoleDialog.tsx` — add new fields
- `chat.service.ts` — update system prompt text
- `ChatMessageList.tsx` — tool labels

### Phase 2: Delegation Engine
**Goal:** Build the `delegate_to_agent` tool and agent-to-agent conversation flow.

**Changes:**
- New tool: `delegate_to_agent` in `chat-tools.ts`
- New tool: `report_to_user` in `chat-tools.ts`
- Add both to Allen MCP server
- Agent conversation creation and tracking
- Recursive delegation support (Engineer → QA)
- Max delegation depth limit (configurable, default 3)
- SSE events: `agent_thread_start`, `agent_thread_message`, `agent_thread_complete`

**Files:**
- `chat-tools.ts` — new tools
- `allen-mcp-server.ts` — expose new tools
- `chat.service.ts` — handle agent thread SSE events
- New: `agent-conversation.service.ts` — manage agent conversations

### Phase 3: Chat UI for Agent Threads
**Goal:** Show agent-to-agent conversations as collapsible threads in chat.

**Changes:**
- Agent selector in chat input (dropdown next to model selector)
- `AgentThread` component — collapsible nested conversation
- Agent avatars in threads
- Thread summary when collapsed
- SSE handling for live agent thread updates

**Files:**
- `ChatInput.tsx` — agent selector
- New: `AgentThread.tsx` — nested conversation component
- `ChatMessageList.tsx` — render agent threads inline
- `useChat.ts` — handle agent thread SSE events

### Phase 4: Agent Management UI
**Goal:** Enhanced agents page with team + technical sections.

**Changes:**
- Agents page with two sections
- Team agent cards showing delegation graph
- Create/edit team agent with personality, delegation rules
- Visual: who-delegates-to-whom connections

**Files:**
- `RoleManagerPage.tsx` — rename + two sections
- `RoleDialog.tsx` — new fields for team agents

### Phase 5: Intelligence & Memory
**Goal:** Agents learn from conversations and share knowledge.

**Changes:**
- PM remembers past feature decisions
- Engineer remembers codebase patterns from reviews
- Cross-agent memory sharing (PM's learning available to Engineer)
- Uses existing embedding-based learning system
- New learning scope: `agent` level (per agent memory)

**Files:**
- `learning-manager.ts` — agent-scoped learnings
- `chat-tools.ts` — `save_learning` includes agent context

---

## Team Agent System Prompts

### Product Manager
```
You are a Product Manager. You think strategically about features, user needs, and business impact.

When a user describes a feature or request:
1. Ask clarifying questions if the requirement is vague
2. Break it down into clear requirements
3. Assess priority and impact
4. Delegate technical analysis to Engineer
5. Delegate data analysis to Analyst if needed
6. Synthesize findings into a clear plan

You can delegate to: engineer, qa-engineer, data-analyst, ceo
You NEVER write code yourself. You delegate technical work.
```

### Engineer
```
You are a Senior Engineer. You design systems, analyze codebases, and lead implementation.

When given a technical task:
1. Analyze the codebase and feasibility
2. Design the solution architecture
3. Estimate effort and identify risks
4. Run coding-agent workflow for implementation
5. Delegate to QA for test planning

You can delegate to: qa-engineer, data-analyst
You can trigger: coding-agent workflow
You can spawn: coding-planner, coding-reviewer, coding-investigator (technical agents)
```

### QA Engineer
```
You are a QA Engineer. You ensure quality through thorough testing.

When given code or a feature to validate:
1. Write a comprehensive test plan
2. Identify edge cases and failure modes
3. Run test workflows if available
4. Report findings with severity levels

You can delegate to: engineer (for fixes)
```

### Data Analyst
```
You are a Data Analyst. You query databases, analyze patterns, and build reports.

When asked for data or analysis:
1. Query PostgreSQL and MongoDB via MCP tools
2. Analyze the results
3. Build clear reports with numbers
4. Identify trends and anomalies

You have direct access to: PostgreSQL MCP, MongoDB MCP, Linear MCP
```

### CEO
```
You are the CEO. You think about the big picture — strategy, ROI, priorities.

When reviewing plans or decisions:
1. Ask about business impact and ROI
2. Challenge assumptions
3. Ensure alignment with company goals
4. Make strategic priority decisions

You can delegate to: product-manager, engineer, data-analyst
```

---

## Configuration

### Max delegation depth: 3
PM → Engineer → QA (depth 3, OK)
PM → Engineer → QA → Engineer (depth 4, blocked — returns summary of what's available)

### Agent conversation timeout: 120 seconds per delegation
If a delegated agent doesn't respond in 120s, the calling agent gets a timeout error and decides how to proceed.

### User interruption: Yes
User can send a message while agents are communicating. The current agent-to-agent conversation is paused, user input is processed, and the agent can decide to continue or change course.

---

## Answers to Open Questions

1. **Sequential or parallel delegation?** Agent decides. PM can ask Engineer and Analyst in parallel if tasks are independent, or sequentially if one depends on the other.

2. **Max delegation depth?** 3 levels. PM → Engineer → QA is the max chain.

3. **Can user interrupt?** Yes. Current delegation pauses immediately, user message is processed, agent decides whether to resume or change direction.

4. **Real-time visibility?** Collapsed by default — user sees "PM → Engineer: working..." and can expand to watch live. Full thread visible after completion.

5. **Agent selection?** User explicitly selects from dropdown in chat input. No auto-routing.

6. **Agent memory?** Own memory (per agent) + shared team memory. Uses existing embedding-based learning system with agent-scoped and global-scoped learnings.

7. **Implementation order:** Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5
