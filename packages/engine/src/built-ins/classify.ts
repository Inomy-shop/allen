import type { BuiltInFunction } from '../types.js';

/**
 * Simple keyword-based task classification.
 */
export const classifyTask: BuiltInFunction = async (_config, state) => {
  const task = String(state.task ?? '').toLowerCase();

  const categories: Array<{ label: string; keywords: string[] }> = [
    { label: 'bugfix', keywords: ['bug', 'fix', 'broken', 'error', 'crash', 'failing'] },
    { label: 'feature', keywords: ['add', 'feature', 'implement', 'create', 'build', 'new'] },
    { label: 'refactor', keywords: ['refactor', 'clean', 'improve', 'optimize', 'simplify'] },
    { label: 'test', keywords: ['test', 'coverage', 'spec', 'e2e'] },
    { label: 'docs', keywords: ['doc', 'readme', 'documentation', 'comment'] },
    { label: 'investigate', keywords: ['investigate', 'debug', 'why', 'root cause', 'analyze'] },
    { label: 'content', keywords: ['write', 'post', 'blog', 'article', 'linkedin'] },
  ];

  let bestMatch = 'general';
  let bestScore = 0;

  for (const cat of categories) {
    const score = cat.keywords.filter(kw => task.includes(kw)).length;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = cat.label;
    }
  }

  return { category: bestMatch, confidence: bestScore > 0 ? Math.min(bestScore / 3, 1) : 0 };
};
