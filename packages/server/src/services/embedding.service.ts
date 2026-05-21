/**
 * Re-export embedding service from @allen/engine.
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
} from '@allen/engine';
