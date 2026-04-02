import type { Collection, Db } from 'mongodb';

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
    await this.col.updateOne(
      { key },
      { $set: { key, value, updatedAt: new Date() } },
      { upsert: true },
    );
  }

  async get(key: string): Promise<string | null> {
    const doc = await this.col.findOne({ key });
    return doc ? (doc.value as string) : null;
  }

  async delete(key: string): Promise<void> {
    await this.col.deleteOne({ key });
  }
}
