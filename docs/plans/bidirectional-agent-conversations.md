# Bidirectional Agent Conversations — Implementation Plan v3

## Goal

1. Every pair of agents communicates through ONE conversation thread with real back-and-forth
2. Questions escalate naturally up the chain: QA → Engineer → PM → User
3. Complete real-time visibility — user sees everything happening across all threads

---

## Design Decisions

- **Keep existing async model** — `delegate_to_agent` starts, `get_delegation_result` waits. Already works with MCP timeout.
- **Add `ask_caller`** as the new feature — enables bidirectional conversation within existing threads.
- **No parallel delegations** — agents delegate serially. PM talks to Engineer, waits for result, then talks to QA. Simpler, debuggable, matches how real teams work (one meeting at a time).
- **Keep `fromAgent`/`toAgent`** — caller is always `fromAgent`, target is always `toAgent`. Either can send messages within the thread.
- **Thread auto-completes** when the target agent's final response arrives and no `pendingQuestion` is active.

---

## How It Works

### Normal delegation (no questions)

```
PM calls delegate_to_agent(engineer, "Analyze theming")
  → creates conversation (PM→Engineer), spawns Engineer in background
  → returns { conversation_id: "abc", status: "started" }

PM calls get_delegation_result("abc")
  → blocks up to 90s
  → Engineer finishes → returns { status: "completed", response: "..." }

PM synthesizes and responds to user.
```

Same as today. No change.

### Delegation with question (NEW)

```
PM calls delegate_to_agent(engineer, "Analyze theming")
  → spawns Engineer in background
  → returns { conversation_id: "abc", status: "started" }

PM calls get_delegation_result("abc")
  → blocks...
  → Engineer delegates to QA internally
  → QA calls ask_caller("Which files for MVP?")
    → QA pauses
    → conversation Engineer↔QA status → "waiting_for_answer"
    → Engineer's get_delegation_result sees the question
    → Engineer knows the answer → calls answer_question("abc-qa", "Canvas.tsx")
    → QA resumes, finishes
    → Engineer↔QA thread completes
  → Engineer finishes
  → PM's get_delegation_result returns { status: "completed", response: "..." }
```

### Escalation to user (NEW)

```
PM calls delegate_to_agent(engineer, "Analyze theming")
PM calls get_delegation_result("abc")
  → blocks...
  → Engineer can't answer QA's question
  → Engineer calls ask_caller("PM, what's the MVP priority?")
    → Engineer pauses
    → conversation PM↔Engineer status → "waiting_for_answer"
  → PM's get_delegation_result returns { status: "question", question: "What's the MVP priority?" }

PM can't answer either → calls ask_user("What's the MVP priority?")
  → PM pauses
  → SSE event: user_question
  → UI shows question prompt to user
  → User types answer, submits via API
  → ask_user unblocks, returns user's answer to PM

PM calls answer_question("abc", "Settings + app shell only")
  → answer saved to PM↔Engineer thread
  → Engineer resumes
  → Engineer answers QA
  → QA finishes → Engineer finishes

PM calls get_delegation_result("abc")
  → { status: "completed", response: "..." }
```

---

## New Conversation Statuses

```
active              → target agent is working
waiting_for_answer  → target agent asked a question via ask_caller, waiting for caller to answer
completed           → conversation finished, response available
failed              → error occurred
```

---

## Tools (Changes)

### `delegate_to_agent` — MINIMAL CHANGE

Keep current behavior. Only change: if an active/waiting_for_answer conversation already exists between caller and target in this session, reuse it instead of creating a new one.

```
delegate_to_agent(agent_name, message, conversation_id?)
  → if conversation_id provided: send follow-up message in existing thread
  → else if active conversation exists with this agent: reuse it, send message
  → else: create new conversation, spawn agent
  → returns { conversation_id, status: "started" }
```

### `get_delegation_result` — ENHANCED

Add handling for `waiting_for_answer` status:

```
get_delegation_result(conversation_id)
  → polls conversation status (current 90s chunked long-poll)
  → if active: keep waiting
  → if completed: return { status: "completed", response }
  → if failed: return { status: "failed", error }
  → if waiting_for_answer: return immediately with:
      { status: "question", question: "...", from_agent: "qa-engineer", conversation_id }
```

When caller gets `status: "question"`, it must call `answer_question` then `get_delegation_result` again.

### `ask_caller` — NEW

Available to any delegated agent. Pauses execution, sends question to caller.

```
ask_caller(question)
  → saves question message to conversation (type: "question")
  → sets pendingQuestion on conversation
  → sets conversation status to "waiting_for_answer"
  → emits SSE: thread_question
  → BLOCKS: polls pendingQuestion.status until "answered"
  → returns the answer text
```

### `answer_question` — NEW

Used by the caller to answer a pending question from the target agent.

```
answer_question(conversation_id, answer)
  → saves answer message to conversation (type: "answer")
  → sets pendingQuestion.status = "answered", pendingQuestion.answer = answer
  → sets conversation status back to "active"
  → emits SSE: thread_answer
  → returns { answered: true }
```

### `ask_user` — NEW

Only for the top-level team agent (PM). Shows question to user, waits for answer.

```
ask_user(question)
  → saves pending user question to chat session
  → emits SSE: user_question
  → BLOCKS: polls session for user's answer
  → returns the answer text
```

### `spawn_agent` — NO CHANGE

Keep as-is. Technical agents are one-shot executions, not conversations.

### `get_execution` — NO CHANGE

Keep as-is.

---

## Data Model Changes

### `agent_conversations` — add fields

```typescript
// NEW fields (added to existing schema)
{
  // Existing fields stay as-is: fromAgent, toAgent, messages, etc.

  pendingQuestion?: {
    fromAgent: string;       // who asked (the target agent)
    question: string;
    status: 'pending' | 'answered';
    answer?: string;
    askedAt: Date;
    answeredAt?: Date;
  };

  // Sessions for BOTH agents (not just target)
  sessions: {
    [agentName: string]: string;  // agent → CLI session/thread ID
  };
}
```

### `AgentMessage.type` — expand

```typescript
type: 'message' | 'question' | 'answer' | 'status'
// message  = normal conversation message
// question = ask_caller question (shown with ❓)
// answer   = answer_question response (shown with ✅)
// status   = status update ("spawning coding-investigator...", etc.)
```

### `chat_sessions` — add field for ask_user

```typescript
{
  // Existing fields...

  pendingUserQuestion?: {
    question: string;
    fromAgent: string;
    status: 'pending' | 'answered';
    answer?: string;
    askedAt: Date;
    answeredAt?: Date;
  };
}
```

---

## SSE Events

| Event | When | Data |
|-------|------|------|
| `thread_created` | New conversation between two agents | `{ conversationId, fromAgent, toAgent, depth, parentConversationId }` |
| `thread_message` | Any message in any thread | `{ conversationId, agent, type, content }` |
| `thread_status` | Thread status changes | `{ conversationId, status }` |
| `thread_question` | Agent asks caller via ask_caller | `{ conversationId, fromAgent, question }` |
| `thread_answer` | Caller answers via answer_question | `{ conversationId, fromAgent, answer }` |
| `thread_spawn` | Agent spawns technical agent | `{ conversationId, agent, executionId, targetAgent, prompt }` |
| `thread_spawn_update` | Spawned agent progress (text, tool) | `{ conversationId, executionId, type, content }` |
| `thread_spawn_complete` | Spawned agent finishes | `{ conversationId, executionId, response, cost, duration }` |
| `thread_completed` | Thread conversation finishes | `{ conversationId, summary, cost, duration }` |
| `user_question` | PM asks user something | `{ question, fromAgent }` |
| `user_answer` | User answers | `{ answer }` |

---

## UI

### Thread Component (revised)

```
┌─ 💬 PM ↔ Engineer ─────────────────────── ⏳ active ─────┐
│                                                            │
│  👔 PM                                                    │
│  Analyze the theming architecture and propose...           │
│                                                            │
│  💻 Engineer                                              │
│  Let me investigate...                                     │
│  ┌ 🔧 coding-investigator ── ⏳ running ─────────────┐   │
│  │  🧠 Analyzing CSS custom properties...              │   │
│  │  🔧 Read packages/ui/src/index.css                 │   │
│  │  🔧 Grep for darkMode                              │   │
│  └──────────────────────────────────── ✅ 45s $0.38 ──┘   │
│                                                            │
│  💻 Engineer                                              │
│  Based on the analysis: Tailwind + CSS custom props...     │
│                                                            │
│  ┌─ 💬 Engineer ↔ QA ──────────── ⏳ active ──────┐      │
│  │                                                  │      │
│  │  💻 Engineer                                    │      │
│  │  Review from QA perspective...                   │      │
│  │                                                  │      │
│  │  🛡️ QA                                          │      │
│  │  Found blockers.                                 │      │
│  │  ❓ Which files specifically need tokens?         │      │
│  │                                                  │      │
│  │  💻 Engineer                                    │      │
│  │  ✅ Canvas.tsx and index.css                     │      │
│  │                                                  │      │
│  │  🛡️ QA                                          │      │
│  │  ❓ What's the priority for MVP?                  │      │
│  │                                                  │      │
│  │  💻 Engineer                                    │      │
│  │  ⏳ Checking with PM...                          │      │
│  │                                                  │      │
│  └──────────────────────── ⏳ waiting ──────────────┘      │
│                                                            │
│  💻 Engineer                                              │
│  ❓ PM, what's the MVP priority for light theme?           │
│                                                            │
└─────────────────────────── ⏳ waiting_for_answer ──────────┘

┌──────────────────────────────────────────────────────────────┐
│  🤔 Product Manager is asking you:                          │
│  "What's the MVP priority for light theme? Settings only     │
│   or full app shell?"                                        │
│                                                              │
│  [Settings + app shell, defer canvas & editor ...]  [Reply]  │
└──────────────────────────────────────────────────────────────┘
```

### Message Type Styling

| Type | Icon | Background | Label |
|------|------|------------|-------|
| `message` | Agent icon | Normal | Agent name |
| `question` | ❓ | Yellow-tinted | "Agent is asking:" |
| `answer` | ✅ | Green-tinted | "Answered:" |
| `status` | ⏳ | Gray, italic | No label |

### Spawn Card (within a message)

```
┌ 🔧 coding-investigator ── ⏳ running ─────────────────────┐
│  🧠 Analyzing the theming architecture...                   │
│  🔧 Read packages/ui/src/index.css                ✅ 120ms │
│  🔧 Grep "darkMode" across /packages/ui          ✅ 89ms  │
│  🔧 Read packages/ui/tailwind.config.js           ✅ 45ms  │
│  • Found 6 dark themes, light tokens exist...               │
└────────────────────────────────── ✅ completed 45s $0.38 ──┘
```

Collapsible. Shows live activity while running, summary when done.

### User Question Prompt

Appears inline in the chat (not a modal). Has:
- Agent icon + "is asking you:"
- Question text
- Text input (auto-focused)
- Reply button
- Disappears after reply, replaced by the answer message

---

## Implementation Phases

### Phase 1: Data model + ask_caller + answer_question

**Files:** `agent-conversation.service.ts`, `chat-tools.ts`, `flowforge-mcp-server.ts`

1. Add `pendingQuestion` field to `AgentConversation` interface and service
2. Add `waiting_for_answer` status
3. Add `sessions` map (track both agents' sessions)
4. Add service methods: `askQuestion()`, `answerQuestion()`, `findActiveConversation()`
5. Implement `ask_caller` tool — block, poll for answer
6. Implement `answer_question` tool — write answer, set status back to active
7. Update `get_delegation_result` — when `waiting_for_answer`, return `{ status: "question", question }`
8. Update `delegate_to_agent` — auto-find existing conversation
9. Add tools to MCP server
10. Add `AgentMessage.type` field

### Phase 2: ask_user + user answer API

**Files:** `chat-tools.ts`, `chat.service.ts`, `chat.routes.ts`, `flowforge-mcp-server.ts`

1. Add `pendingUserQuestion` to chat session model
2. Implement `ask_user` tool — emit SSE, block until answered
3. Add `POST /api/chat/sessions/:id/agent-answer` endpoint
4. Add tool to MCP server

### Phase 3: SSE events for visibility

**Files:** `chat-tools.ts` (emit events), `runAgentTurn`, `runSpawnInBackground`

1. Emit `thread_created`, `thread_message`, `thread_status` from delegate/ask/answer tools
2. Emit `thread_question`, `thread_answer` from ask_caller/answer_question
3. Emit `thread_spawn`, `thread_spawn_update`, `thread_spawn_complete` from spawn paths
4. Emit `thread_completed` when conversation finishes
5. Emit `user_question`, `user_answer` from ask_user path

### Phase 4: UI — thread rendering

**Files:** `useChat.ts`, `AgentThread.tsx`, `ChatMessageList.tsx`

1. Update `useChat` to handle all new SSE events
2. Update `AgentThread` to render bidirectional messages with type styling (question/answer/status)
3. Show spawn cards within messages (collapsible, live activity)
4. Nested threads render inline
5. Auto-expand active, collapse completed
6. Load historical threads on page load (already works)

### Phase 5: UI — user question prompt

**Files:** `AgentQuestionPrompt.tsx` (new), `ChatMessageList.tsx`, `useChat.ts`, `api.ts`

1. Create `AgentQuestionPrompt` component
2. Handle `user_question` SSE event in useChat
3. Render prompt inline in chat
4. Submit answer via API
5. Handle `user_answer` SSE to dismiss prompt

### Phase 6: Agent prompts

**Files:** `agents.yml`, `chat-tools.ts` (buildDelegationPrompt), `chat.service.ts` (buildAgentSystemPrompt)

1. Tell all team agents about `ask_caller` — "use it when you need clarification"
2. Tell PM about `ask_user` — "use it when you need info from the user"
3. Tell all agents about `answer_question` — "when get_delegation_result returns a question, answer it"
4. Update `buildDelegationPrompt` to include ask_caller guidance
5. Remove references to creating new conversations for questions

---

## Files Summary

### New
| File | Purpose |
|------|---------|
| `AgentQuestionPrompt.tsx` | Inline user question prompt in chat |

### Modified
| File | Change |
|------|--------|
| `agent-conversation.service.ts` | Add pendingQuestion, waiting_for_answer, sessions map, findActiveConversation |
| `chat-tools.ts` | Add ask_caller, answer_question, ask_user. Enhance get_delegation_result, delegate_to_agent |
| `flowforge-mcp-server.ts` | Add 3 new tools + MCP handlers |
| `chat.routes.ts` | Add POST /sessions/:id/agent-answer |
| `chat.service.ts` | Add pendingUserQuestion handling |
| `useChat.ts` | Handle new SSE events, pending user questions |
| `ChatMessageList.tsx` | Render AgentQuestionPrompt, pass thread data |
| `AgentThread.tsx` | Message type styling (question/answer), spawn cards |
| `ThreadDetailPanel.tsx` | Same enhancements as AgentThread |
| `agents.yml` | Prompt updates for all team agents |
| `api.ts` | Add chat.answerQuestion() |

---

## What's NOT Changing

- `spawn_agent` — stays as-is (one-shot technical agents)
- `get_execution` — stays as-is
- `runSpawnInBackground` — stays as-is
- `report_to_user` — stays as-is
- Async start + polling pattern — stays (works with MCP timeout)
- Auto-retry on CLI timeout — stays
- `llmSessionId` early save — stays
- Agent selector lock per session — stays
