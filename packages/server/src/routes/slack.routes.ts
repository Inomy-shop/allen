/**
 * Slack Routes
 * Webhook endpoint for Slack Events API.
 *
 * Mounted with express.raw() in app.ts BEFORE the global express.json() middleware,
 * because Slack signature verification requires the raw request body.
 */

import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import type { Db } from 'mongodb';
import { SlackService } from '../services/slack.service.js';

export function slackRoutes(db: Db): Router {
  const router = Router();
  const slackService = new SlackService(db);

  router.post('/events', async (req: Request, res: Response) => {
    const [signingSecret, botToken] = await Promise.all([
      slackService.getSigningSecret(),
      slackService.getBotToken(),
    ]);

    if (!signingSecret || !botToken) {
      console.warn('[slack] SLACK_SIGNING_SECRET or SLACK_BOT_TOKEN not configured (set via /api/secrets or .env)');
      return res.status(503).json({ error: 'Slack integration not configured' });
    }

    // req.body is a Buffer because the route is mounted with express.raw()
    const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const timestamp = req.headers['x-slack-request-timestamp'] as string | undefined;
    const slackSignature = req.headers['x-slack-signature'] as string | undefined;

    if (!timestamp || !slackSignature) {
      return res.status(401).json({ error: 'Missing Slack signature headers' });
    }

    if (!verifySlackSignature(signingSecret, timestamp, rawBody, slackSignature)) {
      return res.status(401).json({ error: 'Invalid Slack signature' });
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    // 1. URL verification challenge — sent once when Event Subscriptions URL is configured
    if (payload.type === 'url_verification') {
      return res.status(200).json({ challenge: payload.challenge });
    }

    // 2. Event callback — process async, return 200 immediately (Slack 3-second requirement)
    if (payload.type === 'event_callback') {
      res.status(200).send();
      // Fire-and-forget: errors are logged inside SlackService
      slackService.handleEvent(payload).catch(err => {
        console.error('[slack] handleEvent error:', err);
      });
      return;
    }

    return res.status(400).json({ error: `Unknown payload type: ${payload.type}` });
  });

  return router;
}

/**
 * Verify a Slack request signature.
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */
function verifySlackSignature(
  secret: string,
  timestamp: string,
  body: Buffer,
  expected: string,
): boolean {
  // Reject requests older than 5 minutes (replay protection)
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const sigBase = `v0:${timestamp}:${body.toString('utf8')}`;
  const computed = 'v0=' + crypto.createHmac('sha256', secret).update(sigBase).digest('hex');

  // Length check before timingSafeEqual to avoid throw
  if (computed.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(expected));
  } catch {
    return false;
  }
}
