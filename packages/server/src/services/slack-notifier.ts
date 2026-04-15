/**
 * Slack Notifier
 *
 * Posts Human Intervention Protocol (HIP) cards to Slack when a
 * workflow pauses for human input. Delivery policy per §9.3 of the
 * feature-and-bug-workflows plan:
 *
 *   1. DM the user who started the workflow run (resolved via
 *      users.lookupByEmail or a stored Slack user ID).
 *   2. If FLOWFORGE_SLACK_INTERVENTIONS_CHANNEL is set, also post
 *      to that channel.
 *   3. Neither is required — if both are missing, the intervention
 *      still surfaces in chat; Slack is additive.
 *
 * This module is separate from `slack.service.ts` so the event-
 * handling path (Slack → FlowForge) and the notification path
 * (FlowForge → Slack) can evolve independently. They share the same
 * bot token, resolved via the SecretService.
 */

import type { Db } from 'mongodb';
import { SecretService } from './secret.service.js';

const SLACK_API = 'https://slack.com/api';

/**
 * Minimal shape of an intervention envelope for rendering. Matches
 * the fields from `workflow_interventions` that the card needs. Kept
 * here so slack-notifier doesn't have to import the service type.
 */
export interface InterventionCardInput {
  intervention_id: string;
  workflow_run_id: string;
  workflow_name: string;
  stage: string;
  severity: 'question' | 'approval' | 'escalation';
  title: string;
  context_summary: string;
  question: string;
  options: Array<{ label: string; value: string; primary?: boolean; destructive?: boolean }>;
  docs: Array<{ label: string; url: string; kind?: string }>;
  round_info?: { current: number; max: number };
  user_request?: string;
}

export interface NotifierDeliveryResult {
  dm_sent: boolean;
  channel_sent: boolean;
  errors: string[];
}

export class SlackNotifier {
  private secrets: SecretService;

  constructor(db: Db) {
    this.secrets = new SecretService(db);
  }

  /**
   * Deliver a HIP card to Slack per the DM + channel policy.
   * Never throws — all failures are captured in the result's
   * `errors` array. Slack being down should not break the workflow.
   */
  async deliver(
    input: InterventionCardInput,
    opts: {
      recipientUserEmail?: string;
      recipientSlackUserId?: string;
      appBaseUrl?: string;
    } = {},
  ): Promise<NotifierDeliveryResult> {
    const result: NotifierDeliveryResult = {
      dm_sent: false,
      channel_sent: false,
      errors: [],
    };

    const token = await this.getBotToken();
    if (!token) {
      result.errors.push('bot_token_missing');
      return result;
    }

    const text = this.renderCardText(input, opts.appBaseUrl);
    const blocks = this.renderCardBlocks(input, opts.appBaseUrl);

    // 1. DM the starter (if we can resolve them).
    try {
      const slackUserId =
        opts.recipientSlackUserId ??
        (opts.recipientUserEmail ? await this.lookupUserByEmail(token, opts.recipientUserEmail) : null);
      if (slackUserId) {
        const dmChannel = await this.openDm(token, slackUserId);
        if (dmChannel) {
          await this.postMessage(token, dmChannel, text, blocks);
          result.dm_sent = true;
        }
      }
    } catch (err) {
      result.errors.push(`dm_failed:${(err as Error).message}`);
    }

    // 2. Channel post (if configured).
    try {
      const channelName = await this.getChannel();
      if (channelName) {
        await this.postMessage(token, channelName, text, blocks);
        result.channel_sent = true;
      }
    } catch (err) {
      result.errors.push(`channel_failed:${(err as Error).message}`);
    }

    return result;
  }

  // ── Secret lookups ─────────────────────────────────────────────────────

  private async getBotToken(): Promise<string | null> {
    return (
      (await this.secrets.get('FLOWFORGE_SLACK_BOT_TOKEN')) ??
      (await this.secrets.get('SLACK_BOT_TOKEN')) ??
      process.env.SLACK_BOT_TOKEN ??
      null
    );
  }

  private async getChannel(): Promise<string | null> {
    return (
      (await this.secrets.get('FLOWFORGE_SLACK_INTERVENTIONS_CHANNEL')) ??
      process.env.FLOWFORGE_SLACK_INTERVENTIONS_CHANNEL ??
      null
    );
  }

  // ── Slack Web API helpers ──────────────────────────────────────────────

  private async lookupUserByEmail(token: string, email: string): Promise<string | null> {
    const url = `${SLACK_API}/users.lookupByEmail?email=${encodeURIComponent(email)}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = (await resp.json()) as { ok: boolean; user?: { id: string } };
    return data.ok && data.user ? data.user.id : null;
  }

  private async openDm(token: string, userId: string): Promise<string | null> {
    const resp = await fetch(`${SLACK_API}/conversations.open`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ users: userId }),
    });
    const data = (await resp.json()) as { ok: boolean; channel?: { id: string }; error?: string };
    if (!data.ok) {
      throw new Error(`conversations.open failed: ${data.error}`);
    }
    return data.channel?.id ?? null;
  }

  private async postMessage(
    token: string,
    channel: string,
    text: string,
    blocks: unknown[],
  ): Promise<void> {
    const resp = await fetch(`${SLACK_API}/chat.postMessage`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        channel,
        text,
        blocks,
        unfurl_links: false,
        unfurl_media: false,
      }),
    });
    const data = (await resp.json()) as { ok: boolean; error?: string };
    if (!data.ok) {
      throw new Error(`chat.postMessage failed: ${data.error}`);
    }
  }

  // ── Card rendering ─────────────────────────────────────────────────────

  /**
   * Render the card to plain text — used as the fallback text for
   * Slack's `text` field and for notification previews.
   */
  private renderCardText(input: InterventionCardInput, appBaseUrl?: string): string {
    const emoji = this.severityEmoji(input.severity);
    const severityLabel = input.severity.toUpperCase();
    const round = input.round_info
      ? ` — round ${input.round_info.current} of ${input.round_info.max}`
      : '';

    const lines: string[] = [
      `${emoji} ${severityLabel} — ${input.title}${round}`,
      `Workflow: ${input.workflow_name} [${input.intervention_id}]`,
    ];
    if (input.user_request) {
      lines.push(`For: "${input.user_request.slice(0, 120)}"`);
    }
    lines.push('');
    lines.push('SUMMARY');
    lines.push(input.context_summary);
    lines.push('');
    lines.push('QUESTION');
    lines.push(input.question);
    lines.push('');
    lines.push('DOCS');
    if (input.docs.length === 0) {
      lines.push('(none)');
    } else {
      for (const d of input.docs) {
        lines.push(`• ${d.label}: ${d.url}`);
      }
    }
    lines.push('');
    lines.push('ACTION REQUIRED');
    const reviewUrl = appBaseUrl
      ? `${appBaseUrl}/interventions/${input.intervention_id}`
      : `/interventions/${input.intervention_id}`;
    lines.push(`Review in FlowForge → ${reviewUrl}`);
    return lines.join('\n');
  }

  /**
   * Slack Block Kit rendering for rich formatting. Best-effort —
   * falls back to the plain-text version if the caller's client
   * doesn't support blocks.
   */
  private renderCardBlocks(input: InterventionCardInput, appBaseUrl?: string): unknown[] {
    const emoji = this.severityEmoji(input.severity);
    const severityLabel = input.severity.toUpperCase();
    const round = input.round_info
      ? ` — round ${input.round_info.current} of ${input.round_info.max}`
      : '';
    const reviewUrl = appBaseUrl
      ? `${appBaseUrl}/interventions/${input.intervention_id}`
      : `/interventions/${input.intervention_id}`;

    const blocks: unknown[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${emoji} ${severityLabel} — ${input.title}${round}`.slice(0, 150),
          emoji: true,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `*Workflow:* \`${input.workflow_name}\`   *ID:* \`${input.intervention_id}\``,
          },
        ],
      },
    ];

    if (input.user_request) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*For:* _${input.user_request.slice(0, 200)}_` },
      });
    }

    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Summary*\n${input.context_summary}` },
    });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Question*\n${input.question}` },
    });

    if (input.docs.length > 0) {
      const docLines = input.docs.map(d => `• <${d.url}|${d.label}>`).join('\n');
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Docs*\n${docLines}` },
      });
    }

    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Review in FlowForge', emoji: true },
          url: reviewUrl,
          style: 'primary',
        },
      ],
    });

    return blocks;
  }

  private severityEmoji(severity: 'question' | 'approval' | 'escalation'): string {
    switch (severity) {
      case 'question': return '🟡';
      case 'approval': return '🟢';
      case 'escalation': return '🔴';
    }
  }
}
