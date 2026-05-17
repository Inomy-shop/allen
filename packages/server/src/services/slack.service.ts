/**
 * Slack Service
 * Bridges Slack Events API with Allen ChatService.
 *
 * When a user mentions @allen in a Slack thread:
 *  - First mention: fetch the entire thread, combine into one message, create a new chat session,
 *    run the agent, and post the response back to the thread.
 *  - Follow-up mentions in the same thread: continue the same chat session.
 *
 * Slack-originated sessions are marked with `source: 'slack'` so the UI can show them
 * read-only (interaction happens via Slack only).
 */

import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { ChatService, type ChatEventHandler, type ChatMessageSender } from './chat.service.js';
import type { ChatProvider } from './chat-providers.js';
import type { ReasoningEffort } from './agent-settings.js';

// ── Types ──

interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  url_private: string;
  size: number;
}

interface SlackEvent {
  type: string;
  text: string;
  user?: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
  files?: SlackFile[];
}

interface SlackEventEnvelope {
  type: 'event_callback';
  event_id: string;
  team_id: string;
  event: SlackEvent;
}

interface SlackMessage {
  text?: string;
  user?: string;
  bot_id?: string;
  ts: string;
  subtype?: string;
  files?: SlackFile[];
}

interface SlackThreadMapping {
  slackTeamId: string;
  slackChannelId: string;
  slackThreadTs: string;
  chatSessionId: string;
  createdAt: Date;
  lastActivityAt: Date;
}

// Strip <@U12345> bot mentions from text
const MENTION_REGEX = /<@[A-Z0-9]+>/g;

const SLACK_API = 'https://slack.com/api';
const SLACK_PROGRESS_MIN_MS = 5000;
const SLACK_DEFAULT_PROVIDER: ChatProvider = 'codex';
const SLACK_DEFAULT_MODEL = 'gpt-5.5';

// ── File attachment constants ──
const UPLOADS_DIR = process.env.UPLOADS_DIR ?? join(process.cwd(), '..', '..', 'uploads');
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

const MAX_SLACK_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
const MAX_FILES_PER_MENTION = 10;

// ── Service ──

export class SlackService {
  private db: Db;
  private chatService: ChatService;

  constructor(db: Db) {
    this.db = db;
    this.chatService = new ChatService(db);
  }

  /**
   * Look up Slack credentials. Read from `.env`. The unprefixed
   * `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` names are still honored as
   * fallbacks for backward compatibility.
   */
  async getBotToken(): Promise<string | null> {
    return process.env.ALLEN_SLACK_BOT_TOKEN
      ?? process.env.SLACK_BOT_TOKEN
      ?? null;
  }

  async getSigningSecret(): Promise<string | null> {
    return process.env.ALLEN_SLACK_SIGNING_SECRET
      ?? process.env.SLACK_SIGNING_SECRET
      ?? null;
  }

  async isConfigured(): Promise<boolean> {
    const [token, secret] = await Promise.all([this.getBotToken(), this.getSigningSecret()]);
    return Boolean(token && secret);
  }

  private resolveSlackDefaults(text: string): {
    provider: ChatProvider;
    model: string;
    reasoningEffort?: ReasoningEffort;
  } {
    const provider = SLACK_DEFAULT_PROVIDER;
    const model = SLACK_DEFAULT_MODEL;
    const rawEffort = process.env.ALLEN_SLACK_REASONING_EFFORT?.trim() as ReasoningEffort | undefined;
    const reasoningEffort = rawEffort || 'high';

    return { provider, model, reasoningEffort };
  }

  /**
   * Entry point for Slack event_callback payloads.
   * Already responded 200 to Slack — runs async, errors are logged.
   */
  async handleEvent(payload: SlackEventEnvelope): Promise<void> {
    const event = payload.event;

    // Only handle app_mention events. Ignore message edits, bot messages, etc.
    if (event.type !== 'app_mention') return;
    if (event.bot_id) return; // never react to bot messages (defensive)

    // Idempotency: insert event_id; duplicate key = already processed
    try {
      await this.db.collection('slack_processed_events').insertOne({
        eventId: payload.event_id,
        processedAt: new Date(),
      });
    } catch (err: any) {
      if (err?.code === 11000) {
        console.log(`[slack] Skipping duplicate event ${payload.event_id}`);
        return;
      }
      throw err;
    }

    const teamId = payload.team_id;
    const channelId = event.channel;
    // If reply in a thread, use thread_ts. If top-level mention, use the message's own ts.
    const threadTs = event.thread_ts ?? event.ts;

    const mapping = await this.db.collection<SlackThreadMapping>('slack_thread_mappings').findOne({
      slackTeamId: teamId,
      slackChannelId: channelId,
      slackThreadTs: threadTs,
    });

    try {
      if (mapping) {
        await this.handleFollowUp(mapping.chatSessionId, event, channelId, threadTs);
      } else {
        await this.handleNewThread(teamId, channelId, threadTs, event);
      }
    } catch (err) {
      console.error('[slack] Failed to handle event:', err);
      try {
        await this.postToSlack(
          channelId,
          threadTs,
          `Sorry, I hit an error processing your request: ${(err as Error).message}`,
        );
      } catch {}
    }
  }

  // ── First mention in a thread ──

  private async handleNewThread(
    teamId: string,
    channelId: string,
    threadTs: string,
    event: SlackEvent,
  ): Promise<void> {
    const cleanedText = event.text.replace(MENTION_REGEX, '').trim();

    // If the mention IS a reply in an existing thread, fetch the thread context.
    // If the mention is the top-level message, there's no prior context.
    let combinedMessage: string;
    let threadMessages: { text: string; author?: string; files?: SlackFile[] }[] = [];
    if (event.thread_ts && event.thread_ts !== event.ts) {
      threadMessages = await this.fetchThreadMessages(channelId, threadTs, event.ts);
      if (threadMessages.length > 0) {
        const context = threadMessages
          .map((m, i) => `[Message ${i + 1}${m.author ? ` from ${m.author}` : ''}]: ${m.text}`)
          .join('\n');
        combinedMessage = `Here is the Slack thread context:\n${context}\n\nUser's request: ${cleanedText}`;
      } else {
        combinedMessage = cleanedText;
      }
    } else {
      combinedMessage = cleanedText;
    }

    // ── Collect and download file attachments ──
    // De-duplicate files by Slack file id across event.files and thread message files.
    const seenFileIds = new Set<string>();
    const allFiles: SlackFile[] = [];
    for (const f of (event.files ?? [])) {
      if (!seenFileIds.has(f.id)) {
        seenFileIds.add(f.id);
        allFiles.push(f);
      }
    }
    for (const msg of threadMessages) {
      for (const f of (msg.files ?? [])) {
        if (!seenFileIds.has(f.id)) {
          seenFileIds.add(f.id);
          allFiles.push(f);
        }
      }
    }
    combinedMessage = await this.appendFileLinks(combinedMessage, allFiles);

    const defaults = this.resolveSlackDefaults(cleanedText);

    // Create a new chat session marked as Slack-sourced. Slack always uses
    // Codex 5.5; message text cannot switch Slack sessions to Claude CLI.
    const session = await this.chatService.createSession(
      defaults.provider,
      defaults.model,
      'slack',
      { channelId, threadTs, teamId },
      { reasoningEffort: defaults.reasoningEffort },
    );
    const sessionId = session._id!.toString();

    // Save the thread mapping BEFORE processing so concurrent events find it
    await this.db.collection<SlackThreadMapping>('slack_thread_mappings').insertOne({
      slackTeamId: teamId,
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      chatSessionId: sessionId,
      createdAt: new Date(),
      lastActivityAt: new Date(),
    });

    await this.processAndReply(sessionId, combinedMessage, channelId, threadTs, event.ts, this.senderFromSlackEvent(event));
  }

  // ── Follow-up mention in same thread ──

  private async handleFollowUp(
    sessionId: string,
    event: SlackEvent,
    channelId: string,
    threadTs: string,
  ): Promise<void> {
    const cleanedText = event.text.replace(MENTION_REGEX, '').trim();

    await this.db.collection('slack_thread_mappings').updateOne(
      { chatSessionId: sessionId },
      { $set: { lastActivityAt: new Date() } },
    );

    // Collect files from the event mention, de-duplicate, and append markdown links.
    const seenFileIds = new Set<string>();
    const allFiles: SlackFile[] = [];
    for (const f of (event.files ?? [])) {
      if (!seenFileIds.has(f.id)) {
        seenFileIds.add(f.id);
        allFiles.push(f);
      }
    }
    const content = await this.appendFileLinks(cleanedText, allFiles);

    await this.processAndReply(sessionId, content, channelId, threadTs, event.ts, this.senderFromSlackEvent(event));
  }

  // ── File attachment helpers ──

  /**
   * Download a Slack private file to the shared uploads directory.
   *
   * Security notes:
   *   - Only image/* and application/pdf are accepted (allowlist).
   *   - Files larger than 25 MB are rejected before any HTTP call.
   *   - The bot token is NEVER logged — only a warning without the token value
   *     is emitted on failure.
   *
   * @returns Public URL `/api/files/<uuid><ext>` on success, `null` on any error.
   */
  private async downloadSlackFileToUploads(file: SlackFile, botToken: string): Promise<string | null> {
    try {
      // Mimetype allowlist
      if (!file.mimetype.startsWith('image/') && file.mimetype !== 'application/pdf') {
        return null;
      }
      // Size cap
      if (file.size > MAX_SLACK_FILE_SIZE) {
        return null;
      }

      const resp = await fetch(file.url_private, {
        headers: { Authorization: `Bearer ${botToken}` },
      });
      if (!resp.ok) {
        console.warn(`[slack] Failed to download file "${file.name}": HTTP ${resp.status}`);
        return null;
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      const ext = extname(file.name) || '.bin';
      const uuid = randomUUID();
      const storedName = `${uuid}${ext}`;
      const fullPath = join(UPLOADS_DIR, storedName);

      await writeFile(fullPath, buffer);

      return `/api/files/${storedName}`;
    } catch (err) {
      console.warn(`[slack] Error downloading file "${file.name}":`, (err as Error).message);
      return null;
    }
  }

  /**
   * Download all qualifying files (up to MAX_FILES_PER_MENTION) and append
   * Markdown image/file links to `message`. Returns the (possibly extended) message.
   */
  private async appendFileLinks(message: string, files: SlackFile[]): Promise<string> {
    if (files.length === 0) return message;

    const botToken = await this.getBotToken();
    if (!botToken) {
      console.warn('[slack] Bot token not available; skipping file downloads');
      return message;
    }

    const filesToProcess = files.slice(0, MAX_FILES_PER_MENTION);
    const urls = await Promise.all(
      filesToProcess.map(f => this.downloadSlackFileToUploads(f, botToken)),
    );

    const links = urls
      .map((url, i) => (url ? `[${filesToProcess[i].name}](${url})` : null))
      .filter((link): link is string => link !== null);

    if (links.length === 0) return message;
    return `${message}\n\n${links.join('\n')}`;
  }

  // ── Run agent and post reply ──

  private senderFromSlackEvent(event: SlackEvent): ChatMessageSender {
    return {
      userId: event.user,
      name: event.user,
      source: 'slack',
    };
  }

  private async processAndReply(
    sessionId: string,
    content: string,
    channelId: string,
    threadTs: string,
    reactionTs: string,
    sender?: ChatMessageSender,
  ): Promise<void> {
    // Acknowledge with hourglass reaction
    await this.addReaction(channelId, reactionTs, 'hourglass_flowing_sand').catch(() => {});
    const onProgress = this.createProgressHandler(channelId, threadTs);

    try {
      const result = await this.chatService.sendMessageForSlack(sessionId, content, undefined, sender, onProgress);

      await this.removeReaction(channelId, reactionTs, 'hourglass_flowing_sand').catch(() => {});
      await this.addReaction(channelId, reactionTs, 'white_check_mark').catch(() => {});

      const text = result.text?.trim() || '_(No response from agent.)_';
      await this.postToSlack(channelId, threadTs, text);
    } catch (err) {
      const errMsg = (err as Error).message ?? String(err);
      await this.removeReaction(channelId, reactionTs, 'hourglass_flowing_sand').catch(() => {});

      if (errMsg === 'Session busy') {
        // The session already has an active response — tell the user politely.
        await this.postToSlack(
          channelId,
          threadTs,
          "I'm still working on the previous request in this thread. Please wait for it to finish, then mention me again.",
        );
        return;
      }

      await this.addReaction(channelId, reactionTs, 'x').catch(() => {});
      await this.postToSlack(channelId, threadTs, `Sorry, something went wrong: ${errMsg}`);
    }
  }

  private createProgressHandler(channelId: string, threadTs: string): ChatEventHandler {
    const postedKeys = new Set<string>();
    let lastPostAt = 0;

    return (event, data) => {
      const now = Date.now();
      const payload = (data ?? {}) as Record<string, unknown>;
      let key = '';
      let message = '';

      if (event === 'agent_report') {
        const report = typeof payload.message === 'string' ? payload.message.trim() : '';
        if (!report) return;
        key = `report:${report}`;
        message = report;
      } else if (event === 'tool_start') {
        const tool = typeof payload.tool === 'string' ? payload.tool : 'tool';
        key = `tool:${tool}`;
        message = `Working on it: ${toolProgressLabel(tool)}`;
      } else if (event === 'error') {
        const err = typeof payload.error === 'string' ? payload.error : 'unknown error';
        key = `error:${err}`;
        message = `I hit an error while working: ${err}`;
      } else {
        return;
      }

      if (postedKeys.has(key) && now - lastPostAt < 30_000) return;
      if (event === 'tool_start' && now - lastPostAt < SLACK_PROGRESS_MIN_MS) return;
      postedKeys.add(key);
      lastPostAt = now;
      this.postToSlack(channelId, threadTs, message).catch((err) => {
        console.error('[slack] progress post failed:', err);
      });
    };
  }

  // ── Slack Web API helpers ──

  /**
   * Fetch messages from a Slack thread, excluding only the triggering mention and
   * genuinely empty messages (no text and no file attachments). Bot and app messages
   * (those carrying bot_id or subtype: 'bot_message') are intentionally included so
   * that integrations such as PagerDuty, GitHub, or Slack workflow posts are visible
   * to the LLM as context. Returns up to ~50 messages.
   */
  private async fetchThreadMessages(
    channelId: string,
    threadTs: string,
    excludeTs: string,
  ): Promise<{ text: string; author?: string; files?: SlackFile[] }[]> {
    const token = await this.getBotToken();
    if (!token) throw new Error('SLACK_BOT_TOKEN not configured');
    const url = `${SLACK_API}/conversations.replies?channel=${encodeURIComponent(channelId)}&ts=${encodeURIComponent(threadTs)}&limit=50`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = (await resp.json()) as { ok: boolean; error?: string; messages?: SlackMessage[] };
    if (!data.ok) {
      throw new Error(`Slack conversations.replies failed: ${data.error}`);
    }
    return (data.messages ?? [])
      .filter(m => m.ts !== excludeTs && (m.text || (m.files && m.files.length > 0)))
      .map(m => ({
        text: (m.text ?? '').replace(MENTION_REGEX, '').trim(),
        author: m.user,
        files: m.files,
      }))
      .filter(m => m.text.length > 0 || (m.files && m.files.length > 0));
  }

  /**
   * Post a message to a Slack thread. The agent's response is GitHub-flavored
   * markdown — we convert it to Slack mrkdwn first so bold/italic/links/code/
   * tables/etc. render properly. Long messages are split into chunks (Slack
   * limit ~40k chars, we use 3500 as a comfortable boundary).
   */
  private async postToSlack(channelId: string, threadTs: string, text: string): Promise<void> {
    const token = await this.getBotToken();
    if (!token) throw new Error('SLACK_BOT_TOKEN not configured');
    const slackText = markdownToSlack(text);
    const chunks = splitMessage(slackText, 3500);
    for (const chunk of chunks) {
      const resp = await fetch(`${SLACK_API}/chat.postMessage`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          channel: channelId,
          thread_ts: threadTs,
          text: chunk,
          unfurl_links: false,
          unfurl_media: false,
        }),
      });
      const data = (await resp.json()) as { ok: boolean; error?: string };
      if (!data.ok) {
        console.error(`[slack] chat.postMessage failed: ${data.error}`);
      }
    }
  }

  private async addReaction(channelId: string, ts: string, name: string): Promise<void> {
    const token = await this.getBotToken();
    if (!token) return;
    await fetch(`${SLACK_API}/reactions.add`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel: channelId, timestamp: ts, name }),
    });
  }

  private async removeReaction(channelId: string, ts: string, name: string): Promise<void> {
    const token = await this.getBotToken();
    if (!token) return;
    await fetch(`${SLACK_API}/reactions.remove`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel: channelId, timestamp: ts, name }),
    });
  }
}

// ── Helpers ──

/**
 * Split long text into chunks that fit within Slack's message limit.
 * Tries to split at paragraph boundaries first, then line boundaries.
 */
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n\n', maxLen);
    if (splitAt < maxLen / 2) splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen / 2) splitAt = remaining.lastIndexOf(' ', maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen;

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function toolProgressLabel(tool: string): string {
  const normalized = tool
    .replace(/^mcp__allen__/, '')
    .replace(/^mcp__/, '')
    .replace(/__/g, ' ')
    .replace(/_/g, ' ');
  if (tool.includes('list_workflows')) return 'checking available workflows';
  if (tool.includes('run_workflow')) return 'starting a workflow';
  if (tool.includes('wait_for_execution')) return 'waiting for execution progress';
  if (tool.includes('spawn_agent')) return 'assigning an agent';
  if (tool.includes('wait_for_delegation')) return 'waiting for the agent';
  if (tool.includes('list_repos')) return 'checking repositories';
  if (tool.includes('linear')) return 'checking Linear';
  return normalized;
}

/**
 * Convert GitHub-flavored markdown (what the agent emits) to Slack mrkdwn
 * (what Slack actually renders). The two dialects disagree on bold, italic,
 * links, headers, and tables — without this conversion you see literal `**`s
 * and broken layouts in Slack threads.
 *
 * Conversions:
 *   **bold** / __bold__   → *bold*           (Slack uses single asterisks)
 *   *italic* / _italic_   → _italic_         (Slack uses underscores)
 *   # / ## / ### headers  → *bold*           (Slack has no native heading)
 *   [text](url)           → <url|text>       (Slack link syntax)
 *   <https://...>         → <https://...>    (auto-links work in both)
 *   ~~strike~~            → ~strike~         (single tilde)
 *   - item / * item       → • item           (bullet character)
 *   `inline`              → `inline`         (preserved)
 *   ```lang code ```      → ``` code ```     (language hint stripped)
 *   GFM tables            → ``` block ```    (monospace preserves alignment)
 *
 * Also escapes literal `<`, `>`, `&` outside protected segments so the agent's
 * `if x < 5` doesn't get parsed as a malformed tag by Slack.
 */
function markdownToSlack(input: string): string {
  // ── 1. Tables → monospace code blocks (do BEFORE link conversion since
  //       table cells contain pipes that would confuse the link regex) ──
  let text = input.replace(
    /(^|\n)(\|[^\n]+\|)\n(\|[\s\-:|]+\|)\n((?:\|[^\n]+\|(?:\n|$))+)/g,
    (_full, lead, header, _align, rows) =>
      `${lead}\`\`\`\n${header}\n${(rows as string).trimEnd()}\n\`\`\``,
  );

  // ── 2. Protect fenced code blocks (strip optional language hint) ──
  const codeBlocks: string[] = [];
  text = text.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_m, code) => {
    codeBlocks.push('```\n' + (code as string).replace(/^\n+|\n+$/g, '') + '\n```');
    return `\u0000CB${codeBlocks.length - 1}\u0000`;
  });

  // ── 3. Protect inline code ──
  const inlineCode: string[] = [];
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => {
    inlineCode.push('`' + code + '`');
    return `\u0000IC${inlineCode.length - 1}\u0000`;
  });

  // ── 4. Headers: # / ## / ### / ... → *bold line* ──
  text = text.replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, '*$1*');

  // ── 5. Links: [text](url) → <url|text>. Strip optional "title" attribute. ──
  text = text.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    '<$2|$1>',
  );

  // ── 6. Protect Slack-style tags so the escape pass below doesn't mangle them.
  //       Covers: <https://url>, <https://url|text>, <@U…>, <#C…>, <!cmd> ──
  const slackTags: string[] = [];
  text = text.replace(
    /<(?:https?:\/\/[^|>\s]+(?:\|[^>\n]+)?|[@#!][^>\s]+)>/g,
    (m) => {
      slackTags.push(m);
      return `\u0000ST${slackTags.length - 1}\u0000`;
    },
  );

  // ── 7. Bold: stash **…** and __…__ first, so the italic regex below can't
  //       eat their asterisks. ──
  const bolds: string[] = [];
  text = text.replace(/\*\*([^*\n]+)\*\*/g, (_m, t) => {
    bolds.push(`*${t}*`);
    return `\u0000BD${bolds.length - 1}\u0000`;
  });
  text = text.replace(/__([^_\n]+)__/g, (_m, t) => {
    bolds.push(`*${t}*`);
    return `\u0000BD${bolds.length - 1}\u0000`;
  });

  // ── 8. Italic: single *text* → _text_ — only when delimited by non-word
  //       chars on both sides, so `5 * 3` and `a*b*c` aren't false-positives. ──
  text = text.replace(
    /(^|[\s(])\*([^*\n]+?)\*($|[\s).,;:!?])/g,
    '$1_$2_$3',
  );

  // ── 9. Restore bolds ──
  text = text.replace(/\u0000BD(\d+)\u0000/g, (_m, idx) => bolds[parseInt(idx, 10)]);

  // ── 10. Strikethrough: ~~text~~ → ~text~ ──
  text = text.replace(/~~([^~\n]+)~~/g, '~$1~');

  // ── 11. Bullet lists: leading "- " / "* " → "• " (preserves indentation) ──
  text = text.replace(/^([ \t]*)[-*][ \t]+/gm, '$1• ');

  // ── 12. Escape Slack special chars in plain text. Placeholders use \u0000
  //       and contain none of <>&, so they're untouched. & must come first
  //       to avoid double-escaping. ──
  text = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // ── 13. Restore protected segments in reverse order ──
  text = text.replace(/\u0000ST(\d+)\u0000/g, (_m, idx) => slackTags[parseInt(idx, 10)]);
  text = text.replace(/\u0000IC(\d+)\u0000/g, (_m, idx) => inlineCode[parseInt(idx, 10)]);
  text = text.replace(/\u0000CB(\d+)\u0000/g, (_m, idx) => codeBlocks[parseInt(idx, 10)]);

  return text;
}
