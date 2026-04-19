# Allen Chat Feature -- Design Plan

## Table of Contents

1. [Research Findings](#1-research-findings)
2. [Chat Architecture](#2-chat-architecture)
3. [@ Mention System](#3--mention-system)
4. [Context Injection](#4-context-injection)
5. [Action Execution from Chat](#5-action-execution-from-chat)
6. [Tool System](#6-tool-system)
7. [Chat Session Management](#7-chat-session-management)
8. [UI Design](#8-ui-design)
9. [Implementation Plan](#9-implementation-plan)
10. [Real-World Examples](#10-real-world-examples)
11. [Technical Decisions](#11-technical-decisions)

---

## 1. Research Findings

### 1.1 Cursor AI Chat

**How context is injected:** Cursor semantically indexes the entire codebase into a vector store using an encoder LLM at index time. When a user types `@codebase`, Cursor retrieves the most relevant files/symbols and includes them in the LLM context. Additional @-mentions include `@file` (specific file), `@folder` (directory scope), and `@docs` (framework documentation).

**How @mentions work:** Typing `@` triggers an autocomplete dropdown with codebase entities -- files, folders, symbols, docs. Each mention adds structured context to the prompt. `@codebase` is the most powerful, triggering full semantic search.

**How actions are triggered:** Cursor 2.0's Composer agent can execute multi-step plans -- editing files, running terminal commands, searching code -- using tool calls like `codebase_search`, `read_file`, `grep_search`, `file_search`, `web_search`.

**How long-running operations work:** Composer uses a streaming diff syntax for edits and shows progress inline. The agent runs in a loop, taking actions, observing results, and deciding next steps.

**Key takeaway for Allen:** The @mention autocomplete pattern is the gold standard. Index entities (workflows, repos, roles) and make them @-mentionable with structured context injection.

Sources: [How Cursor Works](https://blog.sshh.io/p/how-cursor-ai-ide-works), [Context Management Strategies](https://datalakehousehub.com/blog/2026-03-context-management-cursor/), [Cursor Features](https://cursor.com/features)

### 1.2 GitHub Copilot Chat

**How context is injected:** Three-layer architecture: (1) local extension captures prompt + identifies relevant code from workspace index, (2) proxy layer handles auth/rate-limiting/security, (3) LLM processes prompt + context. The @workspace directive builds a holistic response considering the entire project structure.

**How @mentions work:** Directives like `@workspace`, `@terminal`, `@vscode` route to specialized context providers. Each directive injects a different shape of context (project files, terminal output, editor state).

**Key takeaway for Allen:** The directive routing pattern -- `@workspace` maps to a context provider function -- is clean and extensible. We should have each @mention type map to a specific context loader.

Sources: [Copilot Chat Explained](https://devblogs.microsoft.com/all-things-azure/github-copilot-chat-explained-the-life-of-a-prompt/), [Copilot Features](https://docs.github.com/en/copilot/get-started/features)

### 1.3 Windsurf Cascade

**How context is injected:** Cascade operates as a persistent agent that reads the codebase, builds a mental model, and tracks everything the user does -- files edited, terminal commands, clipboard contents, conversation history. A shared "flow awareness" timeline infers intent.

**How multi-step tasks work:** A specialized planning agent continuously refines a long-term plan in the background while the selected model takes short-term actions. Cascade creates a Todo list within the conversation to track progress on complex tasks.

**How long-running operations work:** Iterative debugging loop -- write code, run it, analyze errors, fix, re-run -- all within the same chat context. If code fails, the agent self-corrects without user intervention.

**Key takeaway for Allen:** The background planning agent + foreground execution agent pattern is excellent for multi-step tasks. We should show a Todo/progress list in chat for workflow executions.

Sources: [Cascade Overview](https://windsurf.com/cascade), [Windsurf Docs](https://docs.windsurf.com/windsurf/cascade/cascade)

### 1.4 Claude Code CLI

**How context is injected:** Claude Code IS MCP -- every capability runs as a tool call through MCP servers. Custom slash commands, project memory via CLAUDE.md, and subagents provide layered context.

**How slash commands work:** Commands prefixed with `/` (e.g., `/clear`, `/simplify`) trigger specific behaviors. MCP tools extend capabilities by connecting to external services (databases, APIs, GitHub).

**How actions are triggered:** Tool use via function calling. Each MCP server exposes tools that Claude can call. Three transport types: stdio (local), HTTP (remote), SSE (legacy).

**Key takeaway for Allen:** Our chat agent should use the same MCP tool-calling pattern. Since Allen already uses Claude Code SDK, the chat agent is essentially a persistent Claude Code session with Allen-specific tools registered.

Sources: [Claude Code MCP Docs](https://code.claude.com/docs/en/mcp), [Claude Code Architecture](https://dev.to/shekharp1536/what-claude-codes-leaked-architecture-reveals-about-building-production-mcp-servers-2026-10on)

### 1.5 Vercel v0 / Bolt.new

**How chat-driven execution works:** Natural language prompts are converted into code generation tasks. v0 uses Claude optimized for code generation, focusing on component-level output. Bolt.new generates full-stack applications from prompts, with "Ultra Mode" for extended context and multi-step reasoning.

**Key takeaway for Allen:** The instant preview pattern -- user describes what they want, system builds it and shows a live preview -- should inspire how we show workflow execution results inline in chat.

Sources: [AI-Driven Prototyping Comparison](https://addyo.substack.com/p/ai-driven-prototyping-v0-bolt-and), [v0 Guide 2026](https://www.nxcode.io/resources/news/v0-by-vercel-complete-guide-2026)

### 1.6 n8n AI Agent Node

**How chat triggers workflows:** The Chat Trigger node serves as the entry point for conversational workflows. Every message executes the workflow. The Respond to Chat node sends responses back and can optionally wait for user replies, enabling multi-turn human-in-the-loop interactions within a single execution.

**How streaming works:** Real-time data streaming back to the user as the workflow processes, supported by AI agent nodes.

**Key takeaway for Allen:** The Chat Trigger -> Agent -> Respond to Chat pipeline is a clean model. Our chat messages should be able to trigger workflow executions and stream progress back.

Sources: [n8n Chat Trigger Docs](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.chattrigger/), [n8n AI Agent Docs](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/)

### 1.7 Linear AI Assistant

**How natural language actions work:** Linear Agent (launched March 2026) has full workspace context -- roadmap, backlog, issues, threads, customer feedback, linked repos. Users type natural language commands in a chat panel (`Cmd+J`): "create a sprint from these five customer requests" and the agent creates issues, projects, and documents.

**How it integrates:** Linear MCP server allows external AI tools (Claude, ChatGPT, Cursor) to query issues, create tasks, update statuses through natural conversation.

**Key takeaway for Allen:** The `Cmd+J` quick-open chat panel is the ideal UX for a command center. Full workspace context injection makes the AI useful without users needing to specify what context to load.

Sources: [Linear AI](https://linear.app/ai), [Linear Agent Launch](https://thehuman2ai.com/product/radar/linear-agent-launch)

### 1.8 Summary of Key Patterns

| Pattern | Who Does It Best | Our Approach |
|---------|-----------------|--------------|
| @mention autocomplete | Cursor | Index workflows, repos, roles as @-mentionable entities |
| Directive routing | GitHub Copilot | Each @mention type maps to a context loader function |
| Persistent agent with flow awareness | Windsurf | Chat agent maintains session context across messages |
| Tool-based actions via MCP | Claude Code | Register Allen tools (run_workflow, query_db, etc.) |
| Chat-triggered workflow execution | n8n | Messages can trigger workflows, stream progress back |
| Natural language command center | Linear Agent | `Cmd+K` quick panel, full workspace context |
| Inline progress/preview | v0 / Bolt.new | Show execution progress, results, diffs inline in chat |
| Background planning agent | Windsurf Cascade | Multi-step tasks get a plan shown as checklist |

---

## 2. Chat Architecture

### 2.1 Where the Chat Lives

The chat is a **resizable right-side panel** that can be toggled from any page, plus a **`Cmd+K` quick-open overlay** for fast commands.

```
+------------------+------------------------------------------+------------------+
|                  |                                          |                  |
|   Sidebar (nav)  |           Main Content                   |   Chat Panel     |
|                  |         (current page)                   |  (resizable,     |
|   - Dashboard    |                                          |   collapsible)   |
|   - Workflows    |                                          |                  |
|   - Repos        |  (Workflow builder, execution list,      |  [messages]      |
|   - Learnings    |   etc -- whatever page is open)          |  [messages]      |
|   - Executions   |                                          |  [live embed]    |
|   - Roles        |                                          |  [messages]      |
|   - Chat (full)  |                                          |                  |
|                  |                                          |  [input + @]     |
+------------------+------------------------------------------+------------------+
```

**Three modes:**

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Panel** | Click chat icon in header or sidebar | Right-side panel, 350-600px wide, resizable. Main content shrinks. |
| **Quick command** | `Cmd+K` | Centered overlay (like Linear's `Cmd+J`). Single input. Disappears after action. |
| **Full page** | Navigate to `/chat` or click "expand" in panel | Full-width chat page with session list sidebar. For complex conversations. |

**Why not floating bubble?** Allen is a power-user tool, not a customer support widget. A panel provides real estate for execution embeds, code blocks, and inline results.

### 2.2 Backend Connection

**SSE for streaming responses + REST for actions.** This reuses Allen's existing SSE infrastructure.

```
                          REST API
  UI (Chat Panel)  ────────────────►  Allen Server
        │                                    │
        │         SSE (chat stream)          │
        ◄────────────────────────────────────┘
        │                                    │
        │         SSE (execution stream)     │     Claude Code SDK
        ◄────────────────────────────────────┤────────────────────►  LLM
                                             │
                                             │     Tool calls
                                             │────────────────────►  MongoDB
                                             │────────────────────►  Workflows
                                             │────────────────────►  Linear MCP
```

**Message flow:**

1. User sends message via `POST /api/chat/sessions/:sessionId/messages`
2. Server creates a message record in MongoDB `chat_messages`
3. Server opens a Claude Code SDK session (or resumes existing one)
4. Server streams LLM response tokens back via SSE at `GET /api/chat/sessions/:sessionId/stream`
5. When the LLM makes tool calls, the server executes them and streams results
6. Final assistant message is persisted to `chat_messages`

**Why SSE over WebSocket?** Allen already uses SSE for execution streaming (`stream.service.ts`). SSE is simpler, unidirectional (server-to-client), and sufficient since client-to-server communication uses REST.

### 2.3 Conversation History Storage

**MongoDB collection: `chat_sessions`**

```typescript
interface ChatSession {
  _id: ObjectId;
  title: string;                    // Auto-generated or user-set
  status: 'active' | 'archived';
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
  lastMessageAt: Date;
  // Context snapshot -- what was loaded when session started
  contextSnapshot?: {
    repoIds?: string[];
    workflowIds?: string[];
  };
  // Claude session ID for resume capability
  claudeSessionId?: string;
  // Summary for context window management
  summary?: string;
  summarizedUpTo?: number;          // message index up to which summary covers
}
```

**MongoDB collection: `chat_messages`**

```typescript
interface ChatMessage {
  _id: ObjectId;
  sessionId: ObjectId;
  role: 'user' | 'assistant' | 'system' | 'tool_result';
  content: string;                  // Markdown content
  // Structured data for rich rendering
  attachments?: ChatAttachment[];
  // @mentions parsed from the message
  mentions?: ChatMention[];
  // Tool calls made during this message
  toolCalls?: ToolCallRecord[];
  // Execution embeds (live workflow progress)
  executionEmbeds?: ExecutionEmbed[];
  // Metadata
  model?: string;
  tokenCount?: number;
  costUsd?: number;
  durationMs?: number;
  createdAt: Date;
}

interface ChatMention {
  type: 'workflow' | 'repo' | 'role' | 'execution' | 'linear';
  id: string;
  name: string;
  startIndex: number;               // position in content string
  endIndex: number;
}

interface ChatAttachment {
  type: 'execution_embed' | 'ticket_card' | 'pr_card' | 'code_block'
      | 'table' | 'file_preview' | 'diff_view' | 'error_card';
  data: Record<string, unknown>;
}

interface ToolCallRecord {
  toolName: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  durationMs: number;
  status: 'success' | 'error';
}

interface ExecutionEmbed {
  executionId: string;
  workflowName: string;
  status: 'running' | 'completed' | 'failed' | 'waiting_for_input';
  progress?: {
    completedNodes: string[];
    currentNodes: string[];
    totalNodes: number;
  };
}
```

### 2.4 Message Rendering

Messages are rendered as Markdown with extensions:

| Content Type | Rendering |
|-------------|-----------|
| Plain text | Standard Markdown (bold, italic, lists, headers) |
| Code blocks | Syntax-highlighted with copy button (reuse Monaco or highlight.js) |
| Execution embeds | Live progress card with node status, expandable logs |
| Ticket cards | Linear ticket card with title, status, priority, link |
| PR cards | GitHub PR card with title, status, checks, link |
| Tables | Rendered HTML table for database query results |
| File previews | Collapsible file content with syntax highlighting |
| Diff views | Side-by-side or unified diff view |
| Error cards | Red-bordered card with error message and stack trace |

**Streaming:** Assistant messages stream token-by-token via SSE. The UI appends tokens to the current message in real time, rendering Markdown progressively. When a tool call starts, a "thinking" indicator shows the tool name. When the tool completes, its result renders inline.

---

## 3. @ Mention System

### 3.1 Mention Types

| Mention | Syntax | What It Injects | Example |
|---------|--------|----------------|---------|
| `@workflow` | `@workflow-name` | Workflow YAML definition, node list, edge list, context requirements | `@coding-agent` |
| `@repo` | `@repo-name` | Repo metadata (path, language, framework, tags, recent executions) | `@allen` |
| `@role` | `@role-name` | Role system prompt, model, tools, capabilities | `@developer` |
| `@execution` | `@exec-id` or `@latest` | Execution state, traces, logs, outputs, cost | `@latest` |
| `@linear` | `@linear` | Signals the chat to use Linear MCP for ticket operations | `@linear` |
| `@learning` | `@learnings` | Queries the learning system for relevant insights | `@learnings` |

### 3.2 How Each Mention Works

#### @workflow mentions

```
User: Run @coding-agent on @allen to fix the SSE disconnection bug

System resolves:
  @coding-agent -> workflow "coding-agent" (id: 6654abc...)
    Injects: { name, nodes, edges, input schema, description }
  @allen -> repo "allen" (path: /Users/shreemantkumar/allen)
    Injects: { path, language: TypeScript, framework: Express+React, detected info }

Action: Triggers coding-agent workflow execution with:
  input: { task: "fix the SSE disconnection bug", repo_path: "/Users/shreemantkumar/allen" }

Response: Shows live execution embed in chat:
  +--------------------------------------------------+
  | EXECUTION: coding-agent on allen              |
  | Status: RUNNING                                   |
  | [===========                    ] 3/8 nodes       |
  |                                                   |
  | [x] plan           (12.4s)  -> 5 subtasks        |
  | [x] create-branch  (1.2s)  -> feat/fix-sse       |
  | [>] implement       Running...                    |
  | [ ] test                                          |
  | [ ] review                                        |
  | [ ] create-pr                                     |
  |                                                   |
  | [View Full Execution] [Cancel]                    |
  +--------------------------------------------------+
```

#### @role mentions

```
User: @reviewer review this code snippet:
```typescript
const clients = [];
// No cleanup on disconnect
```

System resolves:
  @reviewer -> role "reviewer" (system prompt, model: sonnet)

Action: Spawns a one-shot Claude Code session with:
  - System prompt from reviewer role
  - User's message as the task prompt
  - No workflow execution -- direct agent call

Response: Inline review output:
  The code has a memory leak. When SSE clients disconnect, they are never
  removed from the `clients` array. Add a cleanup handler:

  ```typescript
  res.on('close', () => {
    const idx = clients.indexOf(client);
    if (idx !== -1) clients.splice(idx, 1);
  });
  ```

  **Severity:** High -- will cause memory exhaustion in production.
```

#### @repo mentions

```
User: What's the tech stack of @es-data-pipeline?

System resolves:
  @es-data-pipeline -> repo (path, detected: { language: TypeScript, framework: Express,
    packageManager: npm, defaultBranch: development, remoteUrl: github.com/Kalpai-poc/... })

Action: Injects repo metadata into context. LLM answers from metadata.

Response:
  **es-data-pipeline** is a TypeScript/Node.js project using:
  - **Runtime:** Node.js 18
  - **Framework:** Express.js
  - **Package Manager:** npm
  - **Default Branch:** development
  - **Monorepo Structure:** Pipeline services in `src/`, API server in `pipeline-api-server/`,
    React UI in `ui/`, Terraform in `infra/`
```

#### @linear mentions

```
User: @linear create a ticket: "SSE clients not cleaned up on disconnect" priority high, label bug

System resolves:
  @linear -> activates Linear MCP tools

Action: Calls Linear MCP `save_issue` tool with:
  { title: "SSE clients not cleaned up on disconnect", priority: 2, labelNames: ["bug"] }

Response: Inline ticket card:
  +--------------------------------------------------+
  | LINEAR TICKET: FLO-142                            |
  | SSE clients not cleaned up on disconnect          |
  | Priority: HIGH | Label: Bug | Status: Backlog     |
  | [Open in Linear ->]                               |
  +--------------------------------------------------+
```

#### @execution mentions

```
User: What went wrong with @latest?

System resolves:
  @latest -> most recent execution (id: abc-123, workflow: coding-agent, status: failed)
  Injects: execution state, traces for failed node, error logs

Action: LLM analyzes the execution data.

Response:
  The last execution of **coding-agent** failed at the `test` node after 3 retries.

  **Root cause:** The test command `npm test` failed because the test file
  `stream.service.test.ts` imported a module that doesn't exist (`../utils/sse-helper`).

  **Node trace:**
  - test attempt 1: `MODULE_NOT_FOUND: Cannot find module '../utils/sse-helper'`
  - test attempt 2: Same error (retry didn't help because it's a code issue, not transient)
  - test attempt 3: Same error

  **Suggestion:** The implement node created `sse-helper.ts` but placed it in `src/helpers/`
  instead of `src/utils/`. Fix the import path or move the file.
```

### 3.3 Mention Resolution Pipeline

```
User types "@" in chat input
  |
  v
UI shows autocomplete dropdown
  - Fetches entities from: GET /api/chat/mentions?q=<typed chars>
  - Server searches across: workflows, repos, roles, recent executions
  - Returns: [{ type, id, name, icon, description }]
  |
  v
User selects mention
  - Mention token inserted: @[workflow:coding-agent]
  - Visual badge shown in input (colored chip)
  |
  v
User sends message
  - POST /api/chat/sessions/:id/messages
  - Body includes raw content + parsed mentions array
  |
  v
Server resolves mentions
  - For each mention, loads full entity from MongoDB
  - Builds context injection payload
  - Appends to system message or tool context
  |
  v
LLM receives: user message + resolved mention context + available tools
```

### 3.4 Mention Search API

```
GET /api/chat/mentions?q=cod&types=workflow,repo,role

Response:
{
  "results": [
    { "type": "workflow", "id": "6654abc...", "name": "coding-agent",
      "description": "Full SDLC workflow", "icon": "git-branch" },
    { "type": "workflow", "id": "6654def...", "name": "coding-reviewer",
      "description": "Code review workflow", "icon": "git-branch" },
    { "type": "role", "id": "developer", "name": "developer",
      "description": "Software developer role", "icon": "user" }
  ]
}
```

The search is fuzzy -- "cod" matches "coding-agent", "coding-reviewer", "codex". Results are ranked by: exact prefix match > fuzzy match > recent usage frequency.

---

## 4. Context Injection

### 4.1 Context Sources

The chat agent has access to the full Allen data model. Context is injected into the LLM prompt based on mentions, conversation history, and automatic relevance detection.

| Source | Collection/Table | What Gets Injected | When |
|--------|-----------------|-------------------|------|
| Repo metadata | `repos` | name, path, language, framework, tags, detected info | @repo mention or when repo is referenced |
| Workflow definitions | `workflows` | parsed YAML, nodes, edges, input schema | @workflow mention |
| Role definitions | `roles` | system prompt, model, tools list | @role mention |
| Execution data | `executions` | status, traces, logs, outputs, cost, duration | @execution mention or "what happened" queries |
| Execution logs | `execution_logs` | timestamped log entries for an execution | debugging queries |
| Learnings | `learnings` | content, type, scope, confidence, tags | @learnings mention or pattern queries |
| Chat history | `chat_messages` | previous messages in current session | always (recent N messages) |
| Session summary | `chat_sessions` | compressed summary of older messages | when context window is tight |

### 4.2 Automatic Context Detection

Even without explicit @mentions, the chat agent detects what the user is likely referring to:

```
User: "Why did the last run fail?"
  -> Auto-detect: user wants execution info
  -> System fetches most recent execution with status=failed
  -> Injects traces and error logs into context

User: "How does the planner role work?"
  -> Auto-detect: user wants role info
  -> System fetches role "planner" from roles collection
  -> Injects system prompt and configuration

User: "What workflows use the developer role?"
  -> Auto-detect: cross-entity query
  -> System searches workflows collection for nodes with role=developer
  -> Injects matching workflow summaries
```

This is implemented via a **pre-processing step** before the LLM call. A lightweight classifier (could be rule-based initially, upgraded to LLM-based later) examines the user message and decides which context to load.

### 4.3 Context Budget Management

The LLM has a finite context window. Context injection must be budgeted:

```
Total context budget: ~150K tokens (Claude Sonnet)

Allocation:
  System prompt + tools:        ~5K tokens (fixed)
  Chat history (recent):        ~20K tokens (last 10-20 messages)
  Session summary (older):      ~3K tokens (compressed)
  Mention context:              ~15K tokens (resolved entities)
  Tool results:                 ~10K tokens (recent tool call outputs)
  Available for generation:     ~97K tokens

Overflow strategy:
  1. Summarize older messages (keep last 10 verbatim, summarize rest)
  2. Truncate large tool results (show first 2K + "... truncated, use get_full_result tool")
  3. Load mention context lazily (summary first, full on demand via tool)
```

### 4.4 System Prompt Structure

```
You are Allen Assistant, the command center for the Allen workflow
orchestration system. You help users:

- Run and monitor workflows
- Investigate execution failures
- Manage repos, roles, and workflows
- Create and manage Linear tickets
- Query learnings and patterns
- Perform one-shot tasks using roles

## Current Session Context
{dynamic: loaded repos, recent executions, active workflows}

## Available Tools
{tool descriptions -- see Section 6}

## Guidelines
- When the user wants to run a workflow, use the run_workflow tool
- When the user mentions @linear, use Linear MCP tools for ticket operations
- When investigating failures, always check execution traces first
- Show execution progress inline using execution embeds
- When spawning a role for a one-shot task, explain what you're doing
- Format code in fenced code blocks with language tags
- Keep responses concise -- expand only when asked
```

---

## 5. Action Execution from Chat

### 5.1 Action Categories

| Category | Trigger Pattern | What Happens |
|----------|----------------|--------------|
| **Run workflow** | "Run @coding-agent on @allen to fix X" | Creates execution, streams progress inline |
| **One-shot role** | "@reviewer review this code" | Spawns role as single-turn agent, shows output inline |
| **Create ticket** | "@linear create ticket: X" | Calls Linear MCP, shows ticket card |
| **Query data** | "How many executions failed this week?" | Queries MongoDB, shows result as table/number |
| **Investigate failure** | "Why did @latest fail?" | Loads execution traces/logs, analyzes with LLM |
| **View learning insights** | "What patterns have we learned about testing?" | Queries learnings DB, shows relevant entries |
| **Manage entities** | "Create a new role called QA-tester with..." | Calls create role API, confirms creation |
| **Explain system** | "How does the series extraction pipeline work?" | Pure Q&A from context -- no action taken |

### 5.2 Workflow Execution from Chat

When the user asks to run a workflow:

```
1. Chat agent calls tool: run_workflow({ workflow: "coding-agent", input: { task, repo_path } })

2. Tool handler:
   a. POST /api/executions (internal) -- creates execution
   b. Returns { executionId, status: "running" }
   c. Begins background workflow execution (existing engine.run())

3. Chat agent receives executionId, renders ExecutionEmbed attachment:
   { type: "execution_embed", data: { executionId, workflowName, status: "running" } }

4. UI subscribes to execution SSE stream (GET /api/executions/:id/stream)
   - Reuses existing SSE infrastructure
   - Updates ExecutionEmbed card in real-time

5. When execution completes/fails:
   - Tool: get_execution_result(executionId) -- fetches final state
   - Chat agent summarizes: "Workflow completed. PR created: https://github.com/..."
```

**Key point:** The execution runs asynchronously. The chat is not blocked. The user can continue chatting while the execution runs. The embed card updates live via SSE.

### 5.3 One-Shot Role Spawning

When a user @mentions a role (not a workflow), the chat agent spawns a single-turn agent:

```
1. Chat agent calls tool: spawn_role({ role: "reviewer", prompt: "Review this code: ..." })

2. Tool handler:
   a. Loads role definition (system prompt, model, tools)
   b. Creates a Claude Code SDK session with the role's system prompt
   c. Sends the prompt
   d. Streams response back

3. Chat agent renders the role's response as a regular assistant message
   with a badge: "[Reviewer Role]"

4. One-shot -- session is not persisted (unlike workflow agent nodes)
```

### 5.4 Linear Ticket Operations

```
User: @linear create ticket "Fix SSE memory leak" priority urgent label bug assign @shree

Tool call: create_linear_ticket({
  title: "Fix SSE memory leak",
  priority: 1,        // urgent
  labelNames: ["bug"],
  assigneeName: "shree"
})

-> Calls Linear MCP: save_issue(...)
-> Returns: { id: "FLO-142", url: "https://linear.app/allen/issue/FLO-142" }

Chat renders ticket card inline.
```

### 5.5 Database Queries

```
User: How many executions ran this week?

Tool call: query_database({
  collection: "executions",
  pipeline: [
    { $match: { startedAt: { $gte: <7 days ago> } } },
    { $group: { _id: "$status", count: { $sum: 1 } } }
  ]
})

Response:
| Status    | Count |
|-----------|-------|
| completed | 23    |
| failed    | 4     |
| cancelled | 1     |

Total: 28 executions this week. 85.7% success rate.
```

---

## 6. Tool System

### 6.1 Tool Registry

The chat agent has access to these tools, registered as function definitions for the Claude Code SDK:

#### Workflow Tools

| Tool | Parameters | Returns | Description |
|------|-----------|---------|-------------|
| `run_workflow` | `workflow_name: string, input: Record<string, unknown>` | `{ executionId, status }` | Starts a workflow execution |
| `list_workflows` | `filter?: { status? }` | `Workflow[]` | Lists available workflows |
| `get_workflow` | `name_or_id: string` | `Workflow` | Gets workflow definition |

#### Execution Tools

| Tool | Parameters | Returns | Description |
|------|-----------|---------|-------------|
| `get_execution` | `execution_id: string` | `Execution` | Gets execution state, status, outputs |
| `get_execution_logs` | `execution_id: string, node?: string, level?: string` | `Log[]` | Gets execution logs, optionally filtered |
| `get_execution_traces` | `execution_id: string, node?: string` | `Trace[]` | Gets node-level traces with I/O |
| `list_executions` | `filter?: { status?, workflow?, limit? }` | `Execution[]` | Lists recent executions |
| `cancel_execution` | `execution_id: string` | `void` | Cancels a running execution |
| `analyze_execution` | `execution_id: string` | `Analysis` | LLM analysis of execution results -- what went right/wrong |

#### Repo Tools

| Tool | Parameters | Returns | Description |
|------|-----------|---------|-------------|
| `list_repos` | none | `Repo[]` | Lists registered repos |
| `get_repo` | `name_or_id: string` | `Repo` | Gets repo metadata |
| `scan_repo` | `repo_id: string` | `ScanResult` | Re-scans a repo for updated metadata |

#### Role Tools

| Tool | Parameters | Returns | Description |
|------|-----------|---------|-------------|
| `list_roles` | none | `Role[]` | Lists available roles |
| `get_role` | `name: string` | `Role` | Gets role definition |
| `spawn_role` | `role_name: string, prompt: string, repo_path?: string` | `{ response: string }` | Spawns a one-shot agent with the role |

#### Learning Tools

| Tool | Parameters | Returns | Description |
|------|-----------|---------|-------------|
| `search_learnings` | `query: string, scope?: string, type?: string, limit?: number` | `Learning[]` | Searches learnings by keyword/scope |
| `get_learning_stats` | none | `Stats` | Learning system statistics |

#### Linear MCP Tools (proxied)

| Tool | Parameters | Returns | Description |
|------|-----------|---------|-------------|
| `create_linear_ticket` | `title, description?, priority?, labelNames?, assigneeName?` | `{ id, url }` | Creates a Linear issue |
| `list_linear_tickets` | `filter?: { state?, label?, priority? }` | `Ticket[]` | Lists Linear tickets |
| `get_linear_ticket` | `ticket_id: string` | `Ticket` | Gets ticket details |
| `update_linear_ticket` | `ticket_id: string, updates: Partial<Ticket>` | `Ticket` | Updates a ticket |

#### Database Tools (direct query -- advanced)

| Tool | Parameters | Returns | Description |
|------|-----------|---------|-------------|
| `query_database` | `collection: string, pipeline: object[], limit?: number` | `Document[]` | Runs MongoDB aggregation pipeline |
| `count_documents` | `collection: string, filter: object` | `{ count: number }` | Counts documents matching filter |

#### System Tools

| Tool | Parameters | Returns | Description |
|------|-----------|---------|-------------|
| `get_system_status` | none | `{ workflows, executions, repos, uptime }` | Overall system health |
| `get_dashboard_stats` | none | `DashboardStats` | Dashboard statistics |

### 6.2 Tool Implementation Pattern

Each tool is a simple async function that calls the existing Allen services:

```typescript
// tools/run-workflow.ts
export const runWorkflowTool = {
  name: 'run_workflow',
  description: 'Start a workflow execution. Returns executionId for tracking.',
  parameters: {
    type: 'object',
    properties: {
      workflow_name: { type: 'string', description: 'Name of the workflow to run' },
      input: { type: 'object', description: 'Input parameters for the workflow' },
    },
    required: ['workflow_name', 'input'],
  },
  handler: async (params: { workflow_name: string; input: Record<string, unknown> }) => {
    // Resolve workflow by name
    const workflow = await db.collection('workflows').findOne({ name: params.workflow_name });
    if (!workflow) throw new Error(`Workflow "${params.workflow_name}" not found`);

    // Use existing ExecutionService
    const result = await executionService.start(workflow._id.toString(), params.input);
    return result;
  },
};
```

### 6.3 Tool Call Flow

```
LLM decides to call a tool
  |
  v
Server receives tool_use block from Claude SDK
  |
  v
Server looks up tool in registry
  |
  v
Server executes tool handler (async)
  |
  v
Server streams "tool_thinking" SSE event to UI:
  { event: "tool_call", data: { tool: "run_workflow", status: "running" } }
  |
  v
Tool completes, server sends result back to LLM as tool_result
  |
  v
Server streams "tool_result" SSE event to UI:
  { event: "tool_result", data: { tool: "run_workflow", result: { executionId: "..." } } }
  |
  v
LLM processes tool result and generates next response
```

---

## 7. Chat Session Management

### 7.1 Session Lifecycle — 7-Day Resume Window

```
User opens chat → sends messages → closes app
  → Session saved in MongoDB: status 'active', claudeSessionId stored
  
User reopens app within 7 days:
  → Resume SAME Claude session: sdk.query({ resume: claudeSessionId })
  → Agent remembers ALL previous context — no re-injection needed
  → Conversation continues seamlessly
  
User reopens app after 7 days:
  → Session marked: status 'expired'
  → NEW Claude session created
  → All previous messages summarized via LLM
  → New session gets: "PREVIOUS CONVERSATION SUMMARY: ..."
  → Conversation continues with summarized context
  
User clicks [+ New Conversation]:
  → Fresh session, no prior context
  → Old session stays accessible in conversation list
```

### 7.2 Session Schema

```typescript
interface ChatSession {
  _id: ObjectId;
  title: string;                    // auto-generated after 3 messages
  status: 'active' | 'expired' | 'archived';
  claudeSessionId?: string;         // for SDK resume
  claudeSessionExpiresAt?: Date;    // created + 7 days
  summary?: string;                 // LLM-generated summary of all messages
  
  messageCount: number;
  lastMessageAt: Date;
  totalCostUsd: number;
  
  // Context
  repoId?: string;                  // if conversation is repo-scoped
  workflowName?: string;            // if conversation started from a workflow
  
  createdAt: Date;
  updatedAt: Date;
}

interface ChatMessage {
  _id: ObjectId;
  sessionId: ObjectId;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  
  // Tool calls
  toolCalls?: Array<{ name: string; args: any; result?: any }>;
  
  // Linked resources
  executionId?: string;             // if this message triggered an execution
  ticketId?: string;                // if this message created a ticket
  
  costUsd?: number;
  createdAt: Date;
}
```

### 7.3 Conversation List and Switching

```
┌─────────────────────────┐
│ Conversations     [+]   │
│                         │
│ ● Fix login bug         │  ← active, resumable (2h ago)
│   "Let me check the..." │
│                         │
│ ● PR #42 review        │  ← active, resumable (1d ago)
│   "The review found..."│
│                         │
│ ○ Pipeline analysis     │  ← expired (10d ago, will get summary)
│   "Analyzed 5 stages..."│
│                         │
│ ○ Schema migration      │  ← expired (15d ago)
│   "Migration plan for..."│
│                         │
│ [+ New Conversation]    │
└─────────────────────────┘

● = within 7 days — resumes same Claude session (agent remembers everything)
○ = older than 7 days — new session with summary of old messages
```

### 7.4 Resume Logic

```typescript
async function sendMessage(sessionId: string, content: string) {
  const session = await db.chat_sessions.findOne({ _id: sessionId });
  
  if (session.claudeSessionId && session.claudeSessionExpiresAt > new Date()) {
    // RESUME — within 7 days, same Claude session
    // Agent has full context from all previous turns
    return sdk.query({
      prompt: content,
      options: {
        resume: session.claudeSessionId,
        // No system prompt needed — session already has it
        // No context injection needed — agent remembers
      }
    });
  } else {
    // NEW SESSION — expired or first message
    // Summarize old messages if they exist
    let contextPrefix = '';
    if (session.messageCount > 0) {
      const summary = session.summary ?? await summarizeSession(sessionId);
      contextPrefix = `PREVIOUS CONVERSATION SUMMARY:\n${summary}\n\n`;
    }
    
    const response = sdk.query({
      prompt: contextPrefix + content,
      options: {
        customSystemPrompt: CHAT_SYSTEM_PROMPT,
        model: 'sonnet',
        tools: CHAT_TOOLS,
        maxTurns: 50,
      }
    });
    
    // Store new Claude session ID for future resume
    for await (const msg of response) {
      if (msg.session_id) {
        await db.chat_sessions.updateOne(
          { _id: sessionId },
          { $set: { 
            claudeSessionId: msg.session_id,
            claudeSessionExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          }}
        );
      }
    }
  }
}
```

### 7.5 Auto-Summarization

When a session expires (>7 days) and is opened:
1. Fetch all messages from the session
2. Call LLM: "Summarize this conversation. Include: what was discussed, what actions were taken, what outcomes/decisions were made, and any pending items."
3. Store summary on session document
4. Summary is injected into the new session's first prompt

This means the user never loses context — it's just compressed.

### 7.6 Context Window Management

| Situation | Strategy |
|-----------|----------|
| Within 7 days | Resume Claude session — full context preserved natively |
| After 7 days | New session with LLM-generated summary |
| < 20 messages in session | All included in context (via session resume) |
| 20+ messages | Session resume handles this automatically (SDK manages context window) |
| Large tool results | Truncated to 2K tokens in chat, full result via `get_full_result` tool |
| Multiple @mentions | Load summary context first, full on demand |

### 7.7 Concurrent Operations

Multiple operations can run simultaneously:
- Workflow execution A is running (live embed in message 5)
- User asks a question in message 8 (LLM responds with answer)
- Workflow execution B starts from message 10
- Execution A completes, embed in message 5 updates to "completed"

This works because:
- Each execution has its own SSE stream
- The chat SSE stream handles LLM responses
- The UI manages multiple SSE subscriptions independently

### 7.8 One-Shot Tasks in Execution History

When chat spawns a role for a one-shot task, it creates a REAL execution record:

```typescript
// User: "@coding-reviewer review PR #42"
const execution = await createExecution({
  workflowName: 'one-shot',
  input: { task: 'review PR #42', role: 'coding-reviewer' },
  source: 'chat',                    // identifies it came from chat
  chatSessionId: sessionId,          // links back to chat
  chatMessageId: messageId,          // links to specific message
});

// Spawn the role
const result = await executeAgentNode('review', { role: 'coding-reviewer', prompt: '...' }, state, sessions, deps);

// Save as execution trace
await saveTrace({ executionId: execution.id, node: 'review', ... });

// Update execution status
await updateExecution(execution.id, { status: 'completed', ... });
```

**Visible in executions page:**
```
┌───────────────────────────────────────────────────────────┐
│ Executions                                                │
│                                                           │
│ ✅ coding-agent    "Fix login bug"        12m    $0.82    │
│ ✅ one-shot        "Review PR #42"  💬    45s    $0.05    │  ← 💬 = from chat
│ ✅ coding-agent    "Add rate limiting"    8m     $0.65    │
│ 🔵 one-shot        "Analyze DB query" 💬  running...      │  ← 💬 = from chat
└───────────────────────────────────────────────────────────┘
```

- `source: 'chat'` adds a 💬 badge in execution list
- Clicking the badge navigates to the chat message that triggered it
- Full traces, logs, cost tracking — identical to workflow executions
- Chat message shows an embedded execution card with status/progress

---

## 8. UI Design

### 8.1 Component Hierarchy

```
ChatPanel/
  ChatHeader          -- session title, new/expand/close buttons
  MessageList/        -- scrollable message container
    UserMessage       -- user's message with mention badges
    AssistantMessage  -- streaming markdown + attachments
    ToolCallMessage   -- "thinking" indicator while tool runs
    SystemMessage     -- session events (started, archived)
  ExecutionEmbed      -- live workflow progress card (reusable)
  TicketCard          -- Linear ticket card (reusable)
  PRCard              -- GitHub PR card (reusable)
  TableView           -- database query results table
  ChatInput/          -- input area
    MentionInput      -- textarea with @mention autocomplete
    MentionDropdown   -- autocomplete popup
    SendButton        -- send or Cmd+Enter
    AttachButton      -- attach file/context (future)
```

### 8.2 Chat Input with @Mention Autocomplete

```
+-------------------------------------------------------------------+
| @coding-agent fix the login timeout in @allen                  |
|  ^^^^^^^^^^^^^                         ^^^^^^^^^                   |
|  [workflow chip]                       [repo chip]                 |
+-------------------------------------------------------------------+
| [Attach] [Send (Cmd+Enter)]                                       |
+-------------------------------------------------------------------+

When user types "@":
+-------------------------------------------------------------------+
| @cod                                                               |
+-------------------------------------------------------------------+
| +---------------------------------------------------------------+ |
| | WORKFLOWS                                                     | |
| |   coding-agent        Full SDLC workflow             [branch] | |
| |   coding-reviewer     Code review workflow           [branch] | |
| | ROLES                                                         | |
| |   developer           Software developer             [user]   | |
| | REPOS                                                         | |
| |   (no match)                                                  | |
| +---------------------------------------------------------------+ |
```

### 8.3 Message Types Visual Design

**User message:**
```
+-------------------------------------------------------------------+
| [User avatar]  You                              2 min ago          |
|                                                                    |
| Run @coding-agent on @allen to fix the SSE disconnection bug   |
|      ^^^^^^^^^^^^    ^^^^^^^^^                                     |
|      [blue chip]     [green chip]                                  |
+-------------------------------------------------------------------+
```

**Assistant message (streaming):**
```
+-------------------------------------------------------------------+
| [Bot avatar]  Allen                        just now            |
|                                                                    |
| Starting the **coding-agent** workflow on the **allen** repo.  |
|                                                                    |
| Task: "Fix the SSE disconnection bug"                              |
|                                                                    |
| +---------------------------------------------------------------+ |
| | EXECUTION: coding-agent                              RUNNING   | |
| | [========                            ] 2/8 nodes               | |
| |                                                                | |
| | [x] plan            12.4s   5 subtasks identified              | |
| | [>] create-branch   Running...                                 | |
| | [ ] implement                                                  | |
| | [ ] test                                                       | |
| | [ ] review                                                     | |
| | [ ] create-pr                                                  | |
| |                                                                | |
| | [View Details]  [Cancel]                                       | |
| +---------------------------------------------------------------+ |
|                                                                    |
| I'll monitor the execution and let you know when it completes.     |
| ___  (cursor blinking -- streaming)                                |
+-------------------------------------------------------------------+
```

**Tool call indicator:**
```
+-------------------------------------------------------------------+
| [Bot avatar]  Allen                                            |
|                                                                    |
|   [spinner] Calling run_workflow...                                 |
|   [spinner] Querying execution history...                          |
+-------------------------------------------------------------------+
```

**Ticket card:**
```
+-------------------------------------------------------------------+
| [Bot avatar]  Allen                                            |
|                                                                    |
| Created the ticket:                                                |
|                                                                    |
| +---------------------------------------------------------------+ |
| | [Linear icon]  FLO-142                                         | |
| | Fix SSE memory leak                                            | |
| | Priority: URGENT  |  Label: Bug  |  Status: Backlog            | |
| | Assigned to: Shree                                             | |
| | [Open in Linear ->]                                            | |
| +---------------------------------------------------------------+ |
+-------------------------------------------------------------------+
```

### 8.4 Cmd+K Quick Command

```
(dimmed overlay)
+---------------------------------------------------+
|  Allen Command                          Esc   |
|                                                    |
|  > Run coding-agent on allen to fix login_     |
|                                                    |
|  SUGGESTIONS:                                      |
|    Run @coding-agent on @allen                 |
|    Show recent executions                          |
|    Create Linear ticket                            |
+---------------------------------------------------+
```

The Cmd+K overlay is for quick fire-and-forget commands. For conversations, use the panel.

### 8.5 Responsive Design

| Viewport | Chat Behavior |
|----------|--------------|
| Desktop (1200px+) | Side panel mode, resizable 350-600px |
| Tablet (768-1199px) | Overlay panel, slides in from right, overlaps content |
| Mobile (< 768px) | Full-screen chat page, no panel mode |

---

## 9. Implementation Plan

### Phase 1: Basic Chat (Week 1-2)

**Goal:** Send a message, get an LLM response, persist history.

**Backend files:**
```
packages/server/src/
  routes/chat.routes.ts             -- POST /messages, GET /sessions, GET /stream
  services/chat.service.ts          -- Session CRUD, message persistence
  services/chat-agent.service.ts    -- Claude SDK session management, streaming
  types/chat.types.ts               -- ChatSession, ChatMessage interfaces
```

**Frontend files:**
```
packages/ui/src/
  pages/ChatPage.tsx                -- Full-page chat view
  components/chat/
    ChatPanel.tsx                   -- Resizable side panel wrapper
    ChatHeader.tsx                  -- Session title, controls
    MessageList.tsx                 -- Scrollable message container
    UserMessage.tsx                 -- User message bubble
    AssistantMessage.tsx            -- Streaming markdown message
    ChatInput.tsx                   -- Text input with send button
  hooks/useChat.ts                  -- Chat state management hook
  hooks/useChatStream.ts           -- SSE subscription hook
  services/chatService.ts          -- API client for chat endpoints
```

**API endpoints:**
```
POST /api/chat/sessions                      -- Create session
GET  /api/chat/sessions                      -- List sessions
GET  /api/chat/sessions/:id                  -- Get session
DEL  /api/chat/sessions/:id                  -- Delete session
POST /api/chat/sessions/:id/messages         -- Send message
GET  /api/chat/sessions/:id/messages         -- Get messages
GET  /api/chat/sessions/:id/stream           -- SSE stream
```

**Effort:** ~5 days backend, ~5 days frontend

### Phase 2: @Mention System (Week 3-4)

**Goal:** Type @, see autocomplete, select entities, inject context.

**Backend files:**
```
packages/server/src/
  services/mention-resolver.service.ts  -- Resolve @mentions to context
  routes/chat.routes.ts                 -- Add GET /api/chat/mentions
```

**Frontend files:**
```
packages/ui/src/
  components/chat/
    MentionInput.tsx                -- Textarea with @mention detection
    MentionDropdown.tsx             -- Autocomplete popup
    MentionChip.tsx                 -- Colored inline chip
```

**Effort:** ~3 days backend, ~4 days frontend

### Phase 3: Workflow Execution from Chat (Week 5-6)

**Goal:** Run workflows from chat, show live progress inline.

**Backend files:**
```
packages/server/src/
  services/chat-tools/
    run-workflow.tool.ts            -- run_workflow tool handler
    get-execution.tool.ts           -- get_execution, get_execution_logs tools
    list-executions.tool.ts         -- list_executions tool
  services/chat-agent.service.ts    -- Register tools with Claude SDK
```

**Frontend files:**
```
packages/ui/src/
  components/chat/
    ExecutionEmbed.tsx              -- Live execution progress card
    ToolCallIndicator.tsx           -- "Calling tool..." spinner
```

**Effort:** ~4 days backend, ~3 days frontend

### Phase 4: Role Spawning and One-Shot Tasks (Week 7)

**Goal:** @mention a role to spawn a single-turn agent directly in chat.

**Backend files:**
```
packages/server/src/
  services/chat-tools/
    spawn-role.tool.ts              -- spawn_role tool handler
    list-roles.tool.ts              -- list_roles, get_role tools
```

**Effort:** ~2 days backend, ~1 day frontend

### Phase 5: MCP Integration -- Linear, Databases (Week 8-9)

**Goal:** Create/query Linear tickets and run database queries from chat.

**Backend files:**
```
packages/server/src/
  services/chat-tools/
    linear.tool.ts                  -- create_linear_ticket, list_tickets, etc.
    database.tool.ts                -- query_database, count_documents
  services/mcp-bridge.service.ts    -- Bridge to Linear MCP server
```

**Frontend files:**
```
packages/ui/src/
  components/chat/
    TicketCard.tsx                   -- Linear ticket embed card
    TableView.tsx                    -- Database query results table
```

**Effort:** ~4 days backend, ~3 days frontend

### Phase 6: Investigation & Analysis (Week 10)

**Goal:** Deep failure investigation and execution analysis from chat.

**Backend files:**
```
packages/server/src/
  services/chat-tools/
    analyze-execution.tool.ts       -- LLM-powered execution analysis
    search-learnings.tool.ts        -- Learning system queries
```

**Frontend files:**
```
packages/ui/src/
  components/chat/
    ErrorCard.tsx                    -- Error/failure display card
    LearningCard.tsx                -- Learning insight card
```

**Effort:** ~3 days backend, ~2 days frontend

### Phase 7: Polish & Advanced Features (Week 11-12)

**Goal:** Cmd+K quick command, context summarization, multi-session UX.

**Features:**
- Cmd+K overlay component
- Auto-summarization of long sessions
- Session search
- Auto-title generation
- Mobile responsive layout
- Keyboard shortcuts (Cmd+Enter to send, Esc to close panel, etc.)

**Effort:** ~5 days frontend, ~2 days backend

### Total Estimated Effort

| Phase | Backend | Frontend | Total |
|-------|---------|----------|-------|
| 1. Basic Chat | 5d | 5d | 10d |
| 2. @Mentions | 3d | 4d | 7d |
| 3. Workflow Execution | 4d | 3d | 7d |
| 4. Role Spawning | 2d | 1d | 3d |
| 5. MCP Integration | 4d | 3d | 7d |
| 6. Investigation | 3d | 2d | 5d |
| 7. Polish | 2d | 5d | 7d |
| **Total** | **23d** | **23d** | **~46 days (9-10 weeks)** |

---

## 10. Real-World Examples

### Example 1: Feature Implementation Request

```
User: Run @coding-agent on @allen to add rate limiting to the
      execution API. Max 10 concurrent executions per workflow.

Assistant: [tool: run_workflow] Starting coding-agent on allen...

  Workflow completed successfully in 8 minutes.
  - Branch: feat/rate-limit-execution-api
  - PR: https://github.com/allen/allen/pull/87
  - Changed: execution.service.ts, execution.routes.ts, execution.test.ts
  - Tests: 12 passed, 0 failed
```

### Example 2: Bug Investigation

```
User: Why did @latest fail?

Assistant: [tool: get_execution] Fetching latest execution...
  [tool: get_execution_traces] Loading traces for failed node...

  The last execution of **coding-agent** failed at the **test** node.

  **Root cause:** The test file imported a module that does not exist:
  `Cannot find module '../utils/sse-helper'`

  The implement node created the file at `src/helpers/sse-helper.ts`
  but the test imports from `src/utils/sse-helper.ts`.

  **Fix:** Either move the file or update the import path.

User: Fix it. Run the workflow again.

Assistant: [tool: run_workflow] Starting coding-agent with context from the
  previous failure...
  Execution completed. All tests pass. PR updated.
```

### Example 3: PR Review

```
User: @reviewer review PR #42 on @allen

Assistant: [tool: spawn_role] Spawning reviewer role with PR #42 context...

  **Code Review: PR #42 - Add SSE heartbeat**

  Overall: APPROVED with minor suggestions

  Findings:
  1. (minor) heartbeat interval is hardcoded to 30s -- consider making
     it configurable via environment variable
  2. (style) Missing JSDoc on the new `startHeartbeat()` function
  3. (good) Proper cleanup on client disconnect -- no memory leak risk
```

### Example 4: Database Query and Analysis

```
User: How many executions ran this week? Break down by status.

Assistant: [tool: query_database] Querying executions from the last 7 days...

  | Status    | Count | Avg Duration |
  |-----------|-------|-------------|
  | completed | 23    | 4.2 min     |
  | failed    | 4     | 1.8 min     |
  | cancelled | 1     | 0.5 min     |

  **28 total executions** this week. **82% success rate.**
  The 4 failures were all on the coding-agent workflow, primarily
  failing at the test node.
```

### Example 5: Ticket Creation

```
User: @linear create ticket: Fix SSE memory leak when clients disconnect
      without closing connection. Priority high, label bug.

Assistant: [tool: create_linear_ticket] Creating Linear issue...

  +---------------------------------------------------------------+
  | LINEAR: FLO-142                                               |
  | Fix SSE memory leak when clients disconnect without closing   |
  | Priority: HIGH  |  Label: Bug  |  Status: Backlog            |
  | https://linear.app/allen/issue/FLO-142                    |
  +---------------------------------------------------------------+
```

### Example 6: Execution Monitoring and Debugging

```
User: Show me what the coding-agent is doing right now.

Assistant: [tool: list_executions] Checking running executions...

  There is 1 running execution:

  +---------------------------------------------------------------+
  | EXECUTION: coding-agent on es-data-pipeline        RUNNING    |
  | [================                  ] 4/8 nodes                |
  | Started 3 minutes ago                                         |
  |                                                               |
  | [x] plan            12.4s                                     |
  | [x] create-branch   1.2s                                      |
  | [x] implement       89.3s                                     |
  | [>] test            Running (22s)...                           |
  | [ ] review                                                    |
  | [ ] create-pr                                                 |
  +---------------------------------------------------------------+

User: Show me the implement node output.

Assistant: [tool: get_execution_traces] Loading traces for implement node...

  The implement node modified 3 files:
  - src/pricing-update/services/staleness-batch.ts (new file)
  - src/pricing-update/services/two-phase-update.ts (modified)
  - pipeline-api-server/src/routes/pricing-update.routes.ts (modified)
```

### Example 7: Cross-Repo Task

```
User: Compare the SSE implementation in @allen with @es-data-pipeline.
      Which one handles client cleanup better?

Assistant: [tool: get_repo] Loading allen metadata...
  [tool: get_repo] Loading es-data-pipeline metadata...

  Both repos use SSE for streaming, but with different patterns:

  **Allen** (packages/server/src/services/stream.service.ts):
  - Uses a flat array of SSE clients
  - Cleans up on both 'close' and 'error' events
  - Broadcasts by executionId with wildcard '*' support

  **ES Data Pipeline** (self-healing/src/server/services/stream.service.ts):
  - Uses a Map keyed by executionId for O(1) lookup
  - Also handles close/error cleanup
  - Has a keepalive heartbeat mechanism

  **Verdict:** ES Data Pipeline handles cleanup better due to the
  heartbeat mechanism that detects stale connections proactively.
  Allen should add a similar heartbeat.
```

### Example 8: Learning Insights Query

```
User: @learnings What patterns have we learned about test failures?

Assistant: [tool: search_learnings] Searching learnings for 'test failures'...

  Found 6 relevant learnings:

  1. **[Pattern, confidence: 0.92]** Test nodes fail most often due to
     import path mismatches when the implement node creates files in
     unexpected directories. Consider adding path validation.

  2. **[Mistake, confidence: 0.88]** The developer role sometimes writes
     tests that import from relative paths that work in the IDE but fail
     in the test runner due to CWD differences.

  3. **[Pattern, confidence: 0.85]** Tests that use network I/O have a
     30% higher failure rate than pure unit tests. Mock network calls.
```

### Example 9: Workflow Creation from Chat

```
User: I need a simple workflow that just plans and reviews code, no
      implementation. Two nodes: planner then reviewer.

Assistant: Here is a workflow YAML for that:

  ```yaml
  name: plan-and-review
  description: Plans a task and reviews the plan
  version: 1
  input:
    task: { type: string, required: true }
    repo_path: { type: string, required: true }
  nodes:
    plan:
      role: planner
      prompt: |
        Analyze the codebase and create a plan for: {{task}}
      outputs: [plan, affected_files]
    review:
      role: reviewer
      prompt: |
        Review this plan for completeness and risks:
        {{plan}}
      outputs: [verdict, suggestions]
  edges:
    - from: plan
      to: review
  ```

  Want me to save this as a new workflow?

User: Yes, save it.

Assistant: [tool: create_workflow] Saving plan-and-review workflow...
  Workflow **plan-and-review** saved successfully. You can run it from
  the Workflows page or by typing: Run @plan-and-review on @your-repo
```

### Example 10: Multi-Step Complex Task

```
User: I need to fix the pricing timeout issue in @es-data-pipeline.
      Create a Linear ticket, run the coding-agent to fix it,
      and post the PR link on the ticket when done.

Assistant: I will handle this in three steps:

  **Step 1: Create Linear ticket**
  [tool: create_linear_ticket] Creating ticket...
  Created FLO-156: 'Fix pricing update timeout'

  **Step 2: Run coding-agent**
  [tool: run_workflow] Starting coding-agent on es-data-pipeline...

  +---------------------------------------------------------------+
  | EXECUTION: coding-agent on es-data-pipeline        RUNNING    |
  | [>] plan    Running...                                         |
  +---------------------------------------------------------------+

  --- (execution completes after 10 minutes) ---

  Workflow completed. PR: https://github.com/.../pull/522

  **Step 3: Update Linear ticket with PR link**
  [tool: update_linear_ticket] Adding PR link to FLO-156...
  Ticket FLO-156 updated with PR link and moved to 'In Review'.

  All three steps complete:
  - Ticket: FLO-156
  - PR: #522
  - Status: In Review
```

---

## 11. Technical Decisions

### 11.1 Which LLM for the Chat Agent?

**Decision: Claude via Claude Code SDK (primary), with Codex as fallback for code-heavy one-shot tasks.**

Rationale:
- Allen already uses Claude Code SDK for workflow agent nodes
- Claude has native tool-use support with structured outputs
- Claude Sonnet provides a good balance of speed and quality for chat
- For one-shot role spawning with the Codex provider, use the existing codex-executor.ts
- No new API keys needed -- uses the existing Claude Code subscription

### 11.2 How to Handle Tool Calls?

**Decision: Native Claude function calling (tool_use blocks), NOT MCP for internal tools.**

Rationale:
- Internal tools (run_workflow, get_execution) are simple async functions
- No need for MCP overhead for internal service calls
- MCP is used ONLY for external integrations (Linear MCP, future GitHub MCP)
- Tool definitions are registered when the Claude session is created
- Tool results are returned as tool_result blocks in the conversation

Implementation:
```typescript
// Register tools when creating chat agent session
const session = await claudeSDK.createSession({
  systemPrompt: CHAT_SYSTEM_PROMPT,
  tools: [
    runWorkflowTool,
    getExecutionTool,
    listExecutionsTool,
    spawnRoleTool,
    searchLearningsTool,
    queryDatabaseTool,
    // ... all tools from Section 6
  ],
  mcpServers: [
    linearMCPConfig,  // External: Linear ticket management
  ],
});
```

### 11.3 How to Stream Responses?

**Decision: SSE from existing infrastructure, with a dedicated chat stream endpoint.**

Rationale:
- Allen already has SSE infrastructure in stream.service.ts
- The chat stream is separate from execution streams
- Chat SSE carries: text tokens, tool_call events, tool_result events, attachments
- Execution embeds subscribe to their own execution SSE streams independently

SSE event types for chat:
```
event: chat_token
data: { sessionId, content: 'partial text...' }

event: tool_call_start
data: { sessionId, toolName: 'run_workflow', toolInput: {...} }

event: tool_call_end
data: { sessionId, toolName: 'run_workflow', result: {...}, durationMs: 234 }

event: message_complete
data: { sessionId, messageId: '...', attachments: [...] }

event: error
data: { sessionId, error: 'Rate limit exceeded' }
```

### 11.4 Where to Store Chat History?

**Decision: MongoDB, two collections: chat_sessions and chat_messages.**

Rationale:
- MongoDB is already the primary datastore for Allen
- Flexible schema accommodates varying attachment types
- Messages can be large (tool results, code blocks) -- MongoDB handles well
- Indexing: sessionId + createdAt for message retrieval, text index on content for search

Indexes:
```typescript
// chat_sessions
db.collection('chat_sessions').createIndex({ updatedAt: -1 });
db.collection('chat_sessions').createIndex({ status: 1 });

// chat_messages
db.collection('chat_messages').createIndex({ sessionId: 1, createdAt: 1 });
db.collection('chat_messages').createIndex({ sessionId: 1, role: 1 });
db.collection('chat_messages').createIndex({ content: 'text' });
```

### 11.5 How to Handle Concurrent Operations?

**Decision: Each operation is independent. Chat is never blocked.**

- Workflow executions run in background (existing async pattern)
- Chat messages can be sent while executions run
- Execution embeds update via their own SSE streams
- Tool calls are awaited but streamed -- user sees 'Calling tool...' indicator
- Multiple executions can run simultaneously (existing concurrency support)

### 11.6 Rate Limiting for Expensive Operations?

**Decision: Per-session rate limits + confirmation for expensive operations.**

| Operation | Limit | Enforcement |
|-----------|-------|-------------|
| Chat messages | 30/min per session | Server-side counter |
| Workflow executions | 3 concurrent | Existing concurrency check |
| Linear ticket creation | 10/hour | Server-side counter |
| Database queries | 20/min | Server-side counter |
| Role spawning | 5/min | Server-side counter |

For workflow execution and ticket creation, the chat agent should ask for
confirmation before executing: 'I will start the coding-agent workflow on
allen. Proceed? [Yes/No]'. This prevents accidental expensive operations.

### 11.7 How to Inject System Context Without Bloating the Prompt?

**Decision: Tiered context injection -- summary first, details on demand via tools.**

The system prompt includes a lightweight context summary:
```
## System State Summary
- Registered repos: allen (TypeScript/Express+React), es-data-pipeline (TypeScript/Express)
- Available workflows: coding-agent, coding-reviewer, plan-and-review
- Active executions: 1 running (coding-agent on allen)
- Recent failures: 2 in last 24h (both test node failures)
- Learnings: 142 active (38 patterns, 22 mistakes, 82 domain knowledge)
```

When the LLM needs more detail, it calls tools:
- `get_workflow('coding-agent')` to get the full YAML definition
- `get_repo('allen')` to get full repo metadata
- `search_learnings('test failures')` to get relevant learnings

This keeps the base prompt under 5K tokens while giving the LLM access to
the full system state on demand.

### 11.8 Chat Agent vs Workflow Agent Distinction

| Aspect | Chat Agent | Workflow Agent Node |
|--------|-----------|-------------------|
| Session | Persistent across messages | Created per node execution |
| Tools | Allen system tools (20+) | filesystem, terminal, git (role-defined) |
| Purpose | Command center, orchestration | Execute a specific coding task |
| CWD | None (operates via tools/APIs) | Repo worktree path |
| Output | Markdown + attachments | Structured JSON (output_format) |
| Model | Claude Sonnet (fast, cheap) | Per-role config (Sonnet/Opus) |
| Resume | Yes (session persists) | Only if resume_on_retry: true |

The chat agent does NOT directly edit files or run terminal commands.
It orchestrates by calling tools that invoke workflows, roles, and APIs.
File editing is delegated to workflow agent nodes (developer role) that
run inside repo worktrees.

---

## Appendix: Sources

Research sources consulted for this design:

- [How Cursor AI IDE Works](https://blog.sshh.io/p/how-cursor-ai-ide-works)
- [Context Management Strategies for Cursor](https://datalakehousehub.com/blog/2026-03-context-management-cursor/)
- [Cursor Features](https://cursor.com/features)
- [GitHub Copilot Chat Explained: Life of a Prompt](https://devblogs.microsoft.com/all-things-azure/github-copilot-chat-explained-the-life-of-a-prompt/)
- [GitHub Copilot Features Docs](https://docs.github.com/en/copilot/get-started/features)
- [Windsurf Cascade Overview](https://windsurf.com/cascade)
- [Windsurf Cascade Docs](https://docs.windsurf.com/windsurf/cascade/cascade)
- [Claude Code MCP Docs](https://code.claude.com/docs/en/mcp)
- [Claude Code Architecture Analysis](https://dev.to/shekharp1536/what-claude-codes-leaked-architecture-reveals-about-building-production-mcp-servers-2026-10on)
- [AI-Driven Prototyping: v0, Bolt, Lovable Compared](https://addyo.substack.com/p/ai-driven-prototyping-v0-bolt-and)
- [v0 by Vercel Complete Guide 2026](https://www.nxcode.io/resources/news/v0-by-vercel-complete-guide-2026)
- [n8n Chat Trigger Node Docs](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.chattrigger/)
- [n8n AI Agent Node Docs](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/)
- [Linear AI Workflows](https://linear.app/ai)
- [Linear Agent Launch](https://thehuman2ai.com/product/radar/linear-agent-launch)
