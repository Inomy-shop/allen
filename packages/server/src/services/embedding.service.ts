/**
 * Re-export embedding service from @flowforge/engine.
 * Single source of truth — engine and server use the same implementation.
 */
export {
  embed,
  embedAndSave,
  searchSimilarLearnings as searchSimilar,
  backfillEmbeddings,
  invalidateEmbeddingCache as invalidateCache,
  cosineSimilarity,
  registerEmbeddingProvider,
  setEmbeddingProvider,
  getActiveProvider,
  type EmbeddingProvider,
} from '@flowforge/engine';
