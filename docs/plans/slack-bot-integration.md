# Slack Bot Integration for Allen

## Context

Allen needs a Slack bot so users can interact with Allen agents directly from Slack. When someone mentions `@allen` in a Slack thread, the server creates (or continues) a chat session, runs the agent, and posts the response back to the thread. This enables controlling Allen from Slack without opening the UI.

**Key design decisions:**
- **Reuse existing chat pipeline** — add a thin `sendMessageForSlack()` method on `ChatService` that uses the same `runLLM()` pipeline but returns a Promise instead of streaming via SSE.
- **Conversations visible in UI** — Slack-originated sessions appear in the normal chat list. Users can open them in the UI to see the full conversation, tool calls, and streaming progress (via the existing `/sessions/:id/stream` endpoint).
- **UI is read-only for Slack sessions** — Users cannot send messages from the UI for Slack-originated conversations. All interaction happens via Slack. The session is marked with `source: 'slack'` to enforce this.

---

## Implementation Steps

### Step 1: Create Slack Service

**New file:** `packages/server/src/services/slack.service.ts`

```
SlackService class:
  - handleEvent(payload)     → entry point, dispatches app_mention events
  - handleNewThread(...)     → first mention: fetch thread, create session, process
  - handleFollowUp(...)      → subsequent mention: continue existing session
  - processAndReply(...)     → call sendMessageForSlack, post result to Slack
  - fetchThreadMessages(...) → Slack API: conversations.replies
  - postToSlack(...)         → Slack API: chat.postMessage (with message splitting for >4000 chars)
  - addReaction(...)         → add emoji reaction (hourglass while processing)
  - removeReaction(...)      → remove emoji reaction
```

**Calling the agent without a real HTTP response:**

Add a lightweight `sendMessageForSlack()` method to `ChatService` that:
- Reuses the same internal `runLLM()` pipeline
- Creates an `ActiveQuery` entry with an empty `listeners` Set (no SSE subscribers, but UI can still subscribe via the existing `/stream` endpoint)
- Returns a Promise that resolves when `runLLM()` completes
- Reads the final assistant message from DB to get `{ text, costUsd, durationMs }`

```typescript
async sendMessageForSlack(sessionId: string, content: string, agent?: string): Promise<{ text: string; costUsd: number; durationMs: number }> {
  const session = await this.sessions.findOne({ _id: new ObjectId(sessionId) });
  if (!session) throw new Error('Session not found');
  if (activeQueries.has(sessionId)) throw new Error('Session busy');

  const now = new Date();
  await this.messages.insertOne({ sessionId, role: 'user', content, status: 'completed', createdAt: now, completedAt: now });
  const assistantResult = await this.messages.insertOne({ sessionId, role: 'assistant', content: '', status: 'streaming', createdAt: new Date() });
  const assistantMsgId = assistantResult.insertedId.toString();

  await this.sessions.updateOne(
    { _id: new ObjectId(sessionId) },
    { $set: { lastMessageAt: new Date(), updatedAt: new Date() }, $inc: { messageCount: 2 } },
  );

  // Create ActiveQuery with no listeners — UI can still subscribe via GET /stream
  const entry: ActiveQuery = { sessionId, messageId: assistantMsgId, currentText: '', toolCalls: [], listeners: new Set(), aborted: false };
  activeQueries.set(sessionId, entry);

  await this.runLLM(sessionId, assistantMsgId, content, entry, agent);

  // Read final result from DB
  const msg = await this.messages.findOne({ _id: new ObjectId(assistantMsgId) });
  return {
    text: (msg?.content as string) ?? '',
    costUsd: (msg?.costUsd as number) ?? 0,
    durationMs: (msg?.durationMs as number) ?? 0,
  };
}
```

This is better than mocking an Express `Response` because:
- No fragile coupling to SSE event format parsing
- `runLLM()` already handles errors, retries, and DB updates internally
- UI users can still watch progress by subscribing to `/sessions/:id/stream`
- The `activeQueries` entry is real, so concurrency protection works correctly
- If `runLLM()` throws, the error propagates naturally to `processAndReply()`

**Flow for new thread (first `@allen` mention):**
1. Check idempotency via `slack_processed_events` collection
2. Fetch all thread messages via Slack `conversations.replies` API
3. Combine thread context + user's message into a single string:
   ```
   Here is the Slack thread context:
   [Message 1]: <text>
   [Message 2]: <text>
   ...
   User's request: <the @allen message with mention stripped>
   ```
4. Create new chat session via `chatService.createSession()` with `source: 'slack'` and `slackContext`
5. Save mapping in `slack_thread_mappings { slackTeamId, slackChannelId, slackThreadTs → chatSessionId }`
6. Add hourglass reaction to the Slack message
7. Call `chatService.sendMessageForSlack(sessionId, combinedMessage)` — agent runs, conversation visible in UI via stream endpoint
8. Await result → post response to Slack thread via `chat.postMessage`
9. Swap hourglass for checkmark reaction

**Flow for follow-up (subsequent mention in same thread):**
1. Look up existing mapping by `(teamId, channelId, threadTs)`
2. Strip bot mention from message text
3. Call `chatService.sendMessageForSlack(sessionId, message)`
4. Await result → post response to Slack thread
5. Update `lastActivityAt` on the mapping

### Step 2: Create Slack Routes

**New file:** `packages/server/src/routes/slack.routes.ts`

Single endpoint: `POST /api/slack/events`

Handles:
- **URL verification challenge** (`type: 'url_verification'`) → echo `challenge` back
- **Event callbacks** (`type: 'event_callback'`) → respond 200 immediately (within 3 seconds), then process async via `slackService.handleEvent()` fire-and-forget
- **Request signature verification** using `SLACK_SIGNING_SECRET` + HMAC-SHA256 + `x-slack-request-timestamp` header

**Raw body for signature verification:** Mount this route with `express.raw({ type: 'application/json' })` BEFORE the global `express.json()` middleware in `app.ts`. The handler parses the JSON manually after signature verification.

```typescript
function verifySlackSignature(secret: string, timestamp: string, body: Buffer, expected: string): boolean {
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) return false; // replay protection
  const sigBase = `v0:${timestamp}:${body.toString()}`;
  const computed = 'v0=' + crypto.createHmac('sha256', secret).update(sigBase).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(expected));
}
```

### Step 3: Add Database Indexes

**File:** `packages/server/src/database/indexes.ts`

Add indexes for two new collections:

```
slack_thread_mappings:
  - { slackTeamId: 1, slackChannelId: 1, slackThreadTs: 1 } (unique)  — lookup by thread
  - { chatSessionId: 1 }  — reverse lookup

slack_processed_events:
  - { eventId: 1 } (unique)  — idempotency
  - { processedAt: 1 } (TTL: 24 hours)  — auto-cleanup
```

### Step 4: Mark Slack Sessions in ChatService

**File:** `packages/server/src/services/chat.service.ts`

Two changes:

**a) Update `ChatSession` interface** — add optional `source` and `slackContext` fields:
```typescript
export interface ChatSession {
  // ... existing fields ...
  source?: 'ui' | 'slack';     // NEW
  slackContext?: {              // NEW — stored for posting replies
    channelId: string;
    threadTs: string;
    teamId: string;
  };
}
```

**b) Update `createSession()` method** — accept optional `source` and `slackContext`:
```typescript
async createSession(
  provider: ChatProvider = 'codex',
  model?: string,
  source?: 'ui' | 'slack',
  slackContext?: { channelId: string; threadTs: string; teamId: string }
): Promise<ChatSession>
```

Store `source: 'slack'` and `slackContext` on sessions created by the Slack integration. This allows:
- UI to show a Slack icon on these sessions
- UI to disable the message input for Slack-originated sessions
- Future: filter sessions by source

### Step 5: Mount Routes in App

**File:** `packages/server/src/app.ts`

Mount slack routes BEFORE `express.json()` middleware (raw body needed for signature verification):

```typescript
import { slackRoutes } from './routes/slack.routes.js';

// After cors(), BEFORE express.json():
app.use('/api/slack', slackRoutes(db));
```

### Step 6: UI — Read-only for Slack Sessions

**Files:**
- `packages/ui/src/hooks/useChat.ts` — add `source` and `slackContext` to the `ChatSession` interface (line 4-15)
- `packages/ui/src/components/chat/ChatInput.tsx` — accept a `disabled` prop and a `disabledReason` message
- The page that uses ChatInput (e.g. ChatPage) — pass `disabled={session.source === 'slack'}` and `disabledReason="This conversation is managed via Slack"`

When session has `source: 'slack'`, disable the message input and show a note like "This conversation is managed via Slack". Users can still:
- View the conversation and all messages
- See tool calls, streaming progress, cost
- View agent activity in real-time

---

## Environment Variables

```
SLACK_BOT_TOKEN=xoxb-...        # Bot User OAuth Token
SLACK_SIGNING_SECRET=...         # App Signing Secret
```

## Slack App Configuration (api.slack.com)

**Bot Token Scopes (OAuth & Permissions):**
- `app_mentions:read` — receive @mention events
- `channels:history` — read thread messages in public channels
- `groups:history` — read thread messages in private channels
- `chat:write` — post responses
- `reactions:write` — add/remove emoji reactions

**Event Subscriptions:**
- Request URL: `https://<your-domain>/api/slack/events`
- Bot Events: `app_mention`

## Database Schemas

**Collection: `slack_thread_mappings`**
```typescript
interface SlackThreadMapping {
  _id?: ObjectId;
  slackTeamId: string;       // Slack workspace ID
  slackChannelId: string;    // Channel where the mention happened
  slackThreadTs: string;     // Thread timestamp (unique thread identifier)
  chatSessionId: string;     // Allen chat_sessions._id
  createdAt: Date;
  lastActivityAt: Date;
}
```

**Collection: `slack_processed_events`**
```typescript
interface SlackProcessedEvent {
  _id?: ObjectId;
  eventId: string;           // Slack's event_id from the envelope
  processedAt: Date;
}
```

## Edge Cases Handled

| Case | Solution |
|------|----------|
| Duplicate Slack events / retries | `slack_processed_events` with unique index, insert-or-ignore |
| 3-second Slack timeout | Return 200 immediately, process async |
| Agent takes hours | Natural async flow; hourglass reaction shows processing. Visible in UI. |
| Long responses (>4000 chars) | Split into multiple Slack messages at paragraph boundaries |
| Bot's own messages triggering events | Only subscribe to `app_mention`, not `message` — no infinite loop |
| Top-level mention (no thread) | Use `event.ts` as `thread_ts`, response creates a new thread |
| Concurrent mentions in same session | `sendMessageForSlack()` throws "Session busy" → Slack service catches it, posts "I'm still working on the previous request" to Slack thread, drops the message (user can re-mention after current task completes) |
| No Slack env vars configured | Routes return 503, server starts normally without Slack |
| User tries to chat from UI | Input disabled for `source: 'slack'` sessions |

## Files Modified/Created

| File | Action |
|------|--------|
| `packages/server/src/services/slack.service.ts` | **New** — Slack event handling, thread mapping, Slack API calls |
| `packages/server/src/routes/slack.routes.ts` | **New** — Webhook endpoint with signature verification |
| `packages/server/src/services/chat.service.ts` | Add `source`+`slackContext` to `ChatSession`, update `createSession()`, add `sendMessageForSlack()` method |
| `packages/server/src/database/indexes.ts` | Add indexes for 2 new collections |
| `packages/server/src/app.ts` | Import and mount slack routes before JSON middleware |
| `packages/ui/src/hooks/useChat.ts` | Add `source`+`slackContext` to `ChatSession` interface |
| `packages/ui/src/components/chat/ChatInput.tsx` | Accept `disabled` + `disabledReason` props for Slack-sourced sessions |

## No New Dependencies

Uses Node.js native `fetch` (Node 18+) and `crypto`. No npm packages needed.

## Verification

1. Start server → `GET /api/health` still works
2. Set Slack app Event Subscription URL → `POST /api/slack/events` passes URL verification challenge
3. Mention `@allen` in a Slack channel → creates chat session (visible in UI), adds hourglass reaction
4. Agent processes → conversation streams in UI in real-time
5. Agent completes → posts reply in Slack thread, swaps hourglass for checkmark
6. Open session in UI → full conversation visible, input disabled with "Managed via Slack" note
7. Reply in same Slack thread with `@allen` → continues same session
8. New thread mention → creates new session
9. Check `slack_thread_mappings` collection for correct entries
