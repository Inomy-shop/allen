#!/usr/bin/env -S npx tsx
/**
 * e2e-preauth.ts — prepares auth state BEFORE playwright starts.
 *
 * Runs as the first step of `npm run test:e2e`. Connects directly to the
 * same MongoDB the server will use, creates a dedicated e2e-runner admin
 * user (alongside whatever real admin already exists — does NOT touch
 * theirs), then mints a JWT access + refresh token pair locally using the
 * secrets from .env. The tokens are valid against the running server
 * because it signs with the same secrets.
 *
 * Writes two files that playwright.config.ts reads at config load:
 *   e2e/.auth/storageState.json  → browser localStorage for page fixtures
 *   e2e/.auth/accessToken.txt    → Authorization header for request fixtures
 *
 * Result: every existing e2e spec that uses `page` or `request` is
 * automatically authenticated without needing any per-spec edits.
 */
import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
import bcrypt from 'bcrypt';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const AUTH_DIR = resolve(REPO_ROOT, 'e2e/.auth');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/flowforge';
const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

if (!JWT_ACCESS_SECRET || !JWT_REFRESH_SECRET) {
  console.error(
    'e2e-preauth: JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be set in .env',
  );
  process.exit(1);
}

const RUNNER_EMAIL = 'e2e-runner@internal.local';
const RUNNER_PW = 'E2eRunner!2345';
const UI_PORT = process.env.UI_PORT || '5173';
const UI_ORIGIN = `http://localhost:${UI_PORT}`;

async function main(): Promise<void> {
  mkdirSync(AUTH_DIR, { recursive: true });

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db();
  try {
    // 1. Upsert the e2e runner user (keeps dev admin intact).
    const now = new Date();
    const passwordHash = await bcrypt.hash(RUNNER_PW, 12);
    const users = db.collection('users');

    const existing = await users.findOne({ email: RUNNER_EMAIL });
    let userId: ObjectId;
    if (existing) {
      userId = existing._id;
      await users.updateOne(
        { _id: userId },
        {
          $set: {
            passwordHash,
            role: 'admin',
            mustResetPassword: false,
            updatedAt: now,
          },
        },
      );
    } else {
      userId = new ObjectId();
      await users.insertOne({
        _id: userId,
        email: RUNNER_EMAIL,
        passwordHash,
        name: 'E2E Runner',
        role: 'admin',
        mustResetPassword: false,
        createdBy: 'system',
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null,
      });
    }

    // 2. Wipe any old refresh tokens for this user (re-running preauth).
    const refreshTokens = db.collection('refresh_tokens');
    await refreshTokens.deleteMany({ userId });

    // 3. Mint access token — same payload shape the server produces.
    const accessPayload = {
      sub: userId.toHexString(),
      email: RUNNER_EMAIL,
      role: 'admin' as const,
      mustResetPassword: false,
    };
    const accessToken = jwt.sign(accessPayload, JWT_ACCESS_SECRET!, {
      expiresIn: process.env.ACCESS_TOKEN_TTL ?? '1d',
    } as SignOptions);

    // 4. Mint refresh token + insert DB row so /auth/refresh works too.
    const jti = randomBytes(16).toString('hex');
    const refreshToken = jwt.sign({ sub: userId.toHexString(), jti }, JWT_REFRESH_SECRET!, {
      expiresIn: process.env.REFRESH_TOKEN_TTL ?? '7d',
    } as SignOptions);
    const decoded = jwt.decode(refreshToken) as { exp: number };
    const tokenHash = createHash('sha256').update(refreshToken).digest('hex');

    await refreshTokens.insertOne({
      _id: new ObjectId(),
      userId,
      jti,
      tokenHash,
      expiresAt: new Date(decoded.exp * 1000),
      revokedAt: null,
      createdAt: now,
      userAgent: 'e2e-preauth',
    });

    // 5. Build storageState for browser contexts.
    const publicUser = {
      id: userId.toHexString(),
      email: RUNNER_EMAIL,
      name: 'E2E Runner',
      role: 'admin',
      mustResetPassword: false,
      createdAt: now.toISOString(),
      lastLoginAt: null,
    };
    const storageState = {
      cookies: [],
      origins: [
        {
          origin: UI_ORIGIN,
          localStorage: [
            {
              name: 'flowforge.auth.v1',
              value: JSON.stringify({ accessToken, refreshToken, user: publicUser }),
            },
          ],
        },
      ],
    };

    writeFileSync(
      resolve(AUTH_DIR, 'storageState.json'),
      JSON.stringify(storageState, null, 2),
    );
    writeFileSync(resolve(AUTH_DIR, 'accessToken.txt'), accessToken);

    console.log(`[e2e-preauth] ✓ ${RUNNER_EMAIL} (${userId.toHexString()})`);
    console.log(`[e2e-preauth] ✓ storageState.json + accessToken.txt written to e2e/.auth/`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('[e2e-preauth] failed:', err);
  process.exit(1);
});
