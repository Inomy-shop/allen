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

import type { Db } from 'mongodb';
import { ChatService } from './chat.service.js';

// ── Types ──

interface SlackEvent {
  type: string;
  text: string;
  user?: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
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
    if (event.thread_ts && event.thread_ts !== event.ts) {
      const threadMessages = await this.fetchThreadMessages(channelId, threadTs, event.ts);
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

    // Create a new chat session marked as Slack-sourced. Default the Slack
    // entry point to Claude Opus with medium reasoning effort — Slack traffic
    // is usually short-form Q&A from non-technical users, so we want better
    // reasoning than Codex default but not max-effort token burn on every
    // @mention. Users can still override per-session via the UI if needed.
    const session = await this.chatService.createSession(
      'claude-cli',
      'opus',
      'slack',
      { channelId, threadTs, teamId },
      { reasoningEffort: 'medium' },
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

    await this.processAndReply(sessionId, combinedMessage, channelId, threadTs, event.ts);
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

    await this.processAndReply(sessionId, cleanedText, channelId, threadTs, event.ts);
  }

  // ── Run agent and post reply ──

  private async processAndReply(
    sessionId: string,
    content: string,
    channelId: string,
    threadTs: string,
    reactionTs: string,
  ): Promise<void> {
    // Acknowledge with hourglass reaction
    await this.addReaction(channelId, reactionTs, 'hourglass_flowing_sand').catch(() => {});

    try {
      const result = await this.chatService.sendMessageForSlack(sessionId, content);

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

  // ── Slack Web API helpers ──

  /**
   * Fetch messages from a Slack thread, excluding bot messages and the triggering mention.
   * Returns up to ~50 messages of context.
   */
  private async fetchThreadMessages(
    channelId: string,
    threadTs: string,
    excludeTs: string,
  ): Promise<{ text: string; author?: string }[]> {
    const token = await this.getBotToken();
    if (!token) throw new Error('SLACK_BOT_TOKEN not configured');
    const url = `${SLACK_API}/conversations.replies?channel=${encodeURIComponent(channelId)}&ts=${encodeURIComponent(threadTs)}&limit=50`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = (await resp.json()) as { ok: boolean; error?: string; messages?: SlackMessage[] };
    if (!data.ok) {
      throw new Error(`Slack conversations.replies failed: ${data.error}`);
    }
    return (data.messages ?? [])
      .filter(m => !m.bot_id && !m.subtype && m.ts !== excludeTs && m.text)
      .map(m => ({
        text: (m.text ?? '').replace(MENTION_REGEX, '').trim(),
        author: m.user,
      }))
      .filter(m => m.text.length > 0);
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
