import type { Collection, Db } from 'mongodb';
import { encrypt, decrypt, isEncrypted } from './encryption.js';

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
