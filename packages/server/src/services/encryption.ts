/**
 * Encryption service for secret values at rest.
 *
 * Uses AES-256-GCM (authenticated encryption). Each value is encrypted with a random
 * 12-byte IV and stored together with its 16-byte auth tag, base64-encoded.
 *
 * Master key resolution order:
 *   1. ALLEN_MASTER_KEY env var (base64-encoded 32 bytes) — preferred for production
 *   2. ~/.allen/master.key file (auto-generated, mode 0600) — fallback for local dev
 *
 * Storage format: `enc:v1:<base64-iv>:<base64-authTag>:<base64-ciphertext>`
 * Values that don't start with `enc:v1:` are treated as legacy plaintext (for migration).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const ENC_PREFIX = 'enc:v1:';

let cachedKey: Buffer | null = null;

function loadMasterKey(): Buffer {
  if (cachedKey) return cachedKey;

  // 1. Environment variable (production)
  const envKey = process.env.ALLEN_MASTER_KEY;
  if (envKey) {
    const buf = Buffer.from(envKey, 'base64');
    if (buf.length !== KEY_LENGTH) {
      throw new Error(
        `ALLEN_MASTER_KEY must decode to ${KEY_LENGTH} bytes (base64), got ${buf.length}. ` +
          `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
      );
    }
    cachedKey = buf;
    console.log('[crypto] Loaded master key from ALLEN_MASTER_KEY env var');
    return buf;
  }

  // 2. File at ~/.allen/master.key (local dev)
  const dir = path.join(os.homedir(), '.allen');
  const file = path.join(dir, 'master.key');

  if (fs.existsSync(file)) {
    const buf = fs.readFileSync(file);
    if (buf.length !== KEY_LENGTH) {
      throw new Error(
        `Master key file at ${file} is corrupt (expected ${KEY_LENGTH} bytes, got ${buf.length}). ` +
          `Delete it to regenerate, but you will lose access to existing encrypted secrets.`,
      );
    }
    cachedKey = buf;
    console.log(`[crypto] Loaded master key from ${file}`);
    return buf;
  }

  // 3. Generate a new key, persist with restrictive permissions
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const newKey = crypto.randomBytes(KEY_LENGTH);
  fs.writeFileSync(file, newKey, { mode: 0o600 });
  console.warn(
    `[crypto] Generated new master key at ${file} (mode 0600).\n` +
      `[crypto] For production, set ALLEN_MASTER_KEY env var instead so secrets survive home-dir resets.\n` +
      `[crypto] To export this key for production: base64 < ${file}`,
  );
  cachedKey = newKey;
  return newKey;
}

/**
 * Returns true if the stored value is in our encrypted format.
 * Used to distinguish legacy plaintext secrets from encrypted ones during migration.
 */
export function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

export function encrypt(plaintext: string): string {
  const key = loadMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export function decrypt(value: string): string {
  // Legacy plaintext (pre-encryption) — return as-is so migration can re-encrypt it.
  if (!isEncrypted(value)) return value;

  const parts = value.slice(ENC_PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted value format (expected enc:v1:iv:tag:ciphertext)');
  }
  const [ivB64, authTagB64, ciphertextB64] = parts;
  const key = loadMasterKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}
