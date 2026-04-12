import type { Collection, Db } from 'mongodb';
import { encrypt, decrypt, isEncrypted } from './encryption.js';

/** Prefix applied to all MCP-referenced secrets. */
export const FLOWFORGE_SECRET_PREFIX = 'FLOWFORGE_';

/** Keys that should never be renamed (system-level vars). */
const DO_NOT_RENAME = new Set(['FLOWFORGE_MASTER_KEY']);

/** Keys that should be renamed to FLOWFORGE_<key> on migration. */
const KEYS_TO_PREFIX = [
  'GITHUB_PERSONAL_ACCESS_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'LINEAR_ACCESS_TOKEN',
  'POSTGRES_CONNECTION_STRING',
  'MONGODB_CONNECTION_STRING',
  'SLACK_BOT_TOKEN',
  'SLACK_TEAM_ID',
  'SLACK_SIGNING_SECRET',
];

/**
 * Secret storage with at-rest AES-256-GCM encryption.
 *
 * - `set()` encrypts the value before writing to MongoDB.
 * - `get()` decrypts on read. Returns plaintext only to in-process callers.
 * - `list()` returns key names only — values are NEVER exposed via the HTTP API.
 * - Legacy plaintext values (written before encryption was added) are auto-detected
 *   and migrated by `migrateLegacyPlaintext()` on startup.
 */
export class SecretService {
  private col: Collection;

  constructor(db: Db) {
    this.col = db.collection('secrets');
  }

  async list(): Promise<string[]> {
    const docs = await this.col.find({}, { projection: { key: 1 } }).toArray();
    return docs.map(d => d.key as string);
  }

  async set(key: string, value: string): Promise<void> {
    const encryptedValue = encrypt(value);
    await this.col.updateOne(
      { key },
      { $set: { key, value: encryptedValue, updatedAt: new Date() } },
      { upsert: true },
    );
  }

  /**
   * Returns the decrypted plaintext value. Server-side use only — never expose
   * the return value over an HTTP response.
   */
  async get(key: string): Promise<string | null> {
    const doc = await this.col.findOne({ key });
    if (!doc) return null;
    const stored = doc.value as string;
    return decrypt(stored);
  }

  async delete(key: string): Promise<void> {
    await this.col.deleteOne({ key });
  }

  /**
   * One-shot migration: re-encrypt any legacy plaintext values left over from
   * the pre-encryption era. Safe to call on every startup — no-op once all
   * values are encrypted.
   */
  /**
   * One-shot migration: rename known non-prefixed secret keys to their
   * FLOWFORGE_-prefixed form. Also rewrites any @secret:OLD references in
   * the mcp_servers collection so existing MCP server configs keep working.
   * Idempotent — no-op once migration is complete.
   */
  async migrateToFlowforgePrefix(db: Db): Promise<number> {
    let migrated = 0;
    for (const oldKey of KEYS_TO_PREFIX) {
      if (DO_NOT_RENAME.has(oldKey)) continue;
      const newKey = FLOWFORGE_SECRET_PREFIX + oldKey;

      const oldDoc = await this.col.findOne({ key: oldKey });
      if (!oldDoc) continue;

      // Copy old → new if new doesn't exist
      const newDoc = await this.col.findOne({ key: newKey });
      if (!newDoc) {
        await this.col.updateOne(
          { key: newKey },
          { $set: { key: newKey, value: oldDoc.value, updatedAt: new Date() } },
          { upsert: true },
        );
      }

      // Rewrite all @secret:oldKey references in mcp_servers
      const mcpCol = db.collection('mcp_servers');
      const servers = await mcpCol.find({}).toArray();
      for (const srv of servers) {
        let changed = false;
        const env = { ...(srv.env as Record<string, string> | undefined ?? {}) };
        for (const [k, v] of Object.entries(env)) {
          if (typeof v === 'string' && v === `@secret:${oldKey}`) {
            env[k] = `@secret:${newKey}`;
            changed = true;
          }
        }
        const args = ((srv.args as string[] | undefined) ?? []).map(a => {
          if (typeof a === 'string' && a === `@secret:${oldKey}`) {
            changed = true;
            return `@secret:${newKey}`;
          }
          return a;
        });
        if (changed) {
          await mcpCol.updateOne({ _id: srv._id }, { $set: { env, args, updatedAt: new Date() } });
        }
      }

      // Delete the old key
      await this.col.deleteOne({ key: oldKey });
      migrated++;
      console.log(`[secrets] Migrated ${oldKey} → ${newKey}`);
    }
    if (migrated > 0) {
      console.log(`[secrets] Renamed ${migrated} secret(s) to FLOWFORGE_ prefix`);
    }
    return migrated;
  }

  async migrateLegacyPlaintext(): Promise<number> {
    const docs = await this.col.find({}).toArray();
    let migrated = 0;
    for (const doc of docs) {
      const value = doc.value as string | undefined;
      if (typeof value !== 'string') continue;
      if (isEncrypted(value)) continue;
      const reencrypted = encrypt(value);
      await this.col.updateOne(
        { _id: doc._id },
        { $set: { value: reencrypted, updatedAt: new Date() } },
      );
      migrated++;
    }
    if (migrated > 0) {
      console.log(`[secrets] Encrypted ${migrated} legacy plaintext secret(s) at rest`);
    }
    return migrated;
  }
}
