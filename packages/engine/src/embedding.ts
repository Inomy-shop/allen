/**
 * Embedding Service (shared between engine and server)
 * Swappable provider interface for text embeddings.
 * Default: local model via @xenova/transformers (no API key needed).
 * Embeddings stored in MongoDB for persistence across restarts.
 * In-memory cache for fast cosine similarity search.
 */

import type { Db, ObjectId } from 'mongodb';

// ── Provider Interface ──

export interface EmbeddingProvider {
  name: string;
  dimensions: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

// ── Cosine Similarity ──

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Local Provider (Xenova/Transformers) ──

let localPipeline: any = null;
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';

async function getLocalPipeline(): Promise<any> {
  if (localPipeline) return localPipeline;
  console.log('\x1b[35m[embedding]\x1b[0m Loading local model (first time may download ~23MB)...');
  const { pipeline } = await import('@xenova/transformers');
  localPipeline = await pipeline('feature-extraction', MODEL_NAME);
  console.log('\x1b[35m[embedding]\x1b[0m Model loaded: all-MiniLM-L6-v2 (384-dim)');
  return localPipeline;
}

const localProvider: EmbeddingProvider = {
  name: 'all-MiniLM-L6-v2',
  dimensions: 384,

  async embed(text: string): Promise<number[]> {
    const pipe = await getLocalPipeline();
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data as Float32Array);
  },

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) results.push(await this.embed(text));
    return results;
  },
};

// ── Provider Registry ──

const providers: Record<string, EmbeddingProvider> = { local: localProvider };
let activeProvider: EmbeddingProvider = localProvider;

export function setEmbeddingProvider(name: string): void {
  const p = providers[name];
  if (!p) throw new Error(`Unknown embedding provider: ${name}. Available: ${Object.keys(providers).join(', ')}`);
  activeProvider = p;
}

export function registerEmbeddingProvider(provider: EmbeddingProvider): void {
  providers[provider.name] = provider;
}

export function getActiveProvider(): EmbeddingProvider { return activeProvider; }

// ── In-Memory Cache ──

interface CachedLearning {
  _id: string;
  content: string;
  type: string;
  embedding: number[];
}

let cache: CachedLearning[] | null = null;

export function invalidateEmbeddingCache(): void { cache = null; }

async function loadCache(db: Db): Promise<CachedLearning[]> {
  if (cache) return cache;
  const learnings = await db.collection('learnings')
    .find({ status: 'active', embedding: { $exists: true, $ne: null } })
    .project({ content: 1, type: 1, embedding: 1 })
    .limit(1000)
    .toArray();

  cache = learnings.map(l => ({
    _id: l._id.toString(),
    content: l.content as string,
    type: l.type as string,
    embedding: l.embedding as number[],
  }));
  return cache;
}

// ── Public API ──

/** Generate embedding for a text string. */
export async function embed(text: string): Promise<number[]> {
  return activeProvider.embed(text);
}

/** Generate embedding and save it to a learning document. */
export async function embedAndSave(db: Db, learningId: string, content: string): Promise<void> {
  const embedding = await activeProvider.embed(content);
  const { ObjectId } = await import('mongodb');
  await db.collection('learnings').updateOne(
    { _id: new ObjectId(learningId) },
    { $set: { embedding, embeddingModel: activeProvider.name } },
  );
  invalidateEmbeddingCache();
}

/** Search learnings by semantic similarity. */
export async function searchSimilarLearnings(
  db: Db,
  query: string,
  opts: { limit?: number; threshold?: number; tags?: string[] } = {},
): Promise<Array<{ content: string; type: string; score: number }>> {
  const limit = opts.limit ?? 10;
  const threshold = opts.threshold ?? 0.25;

  const cached = await loadCache(db);
  if (cached.length === 0) return [];

  const queryEmbedding = await activeProvider.embed(query);

  return cached
    .map(l => ({ content: l.content, type: l.type, score: cosineSimilarity(queryEmbedding, l.embedding) }))
    .filter(l => l.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Backfill embeddings for learnings that don't have them. */
export async function backfillEmbeddings(db: Db): Promise<number> {
  const missing = await db.collection('learnings')
    .find({ status: 'active', $or: [{ embedding: { $exists: false } }, { embedding: null }] })
    .project({ content: 1 })
    .limit(100)
    .toArray();

  if (missing.length === 0) return 0;
  console.log(`\x1b[35m[embedding]\x1b[0m Backfilling ${missing.length} learnings...`);

  for (const doc of missing) {
    const embedding = await activeProvider.embed(doc.content as string);
    await db.collection('learnings').updateOne(
      { _id: doc._id },
      { $set: { embedding, embeddingModel: activeProvider.name } },
    );
  }

  invalidateEmbeddingCache();
  return missing.length;
}
