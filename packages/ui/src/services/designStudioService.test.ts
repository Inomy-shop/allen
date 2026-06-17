import { describe, it, expect } from 'vitest';
import { pickPrototypeArtifact, type ChatArtifact } from './designStudioService';

const a = (filename: string, createdAt: string): ChatArtifact => ({ id: filename + createdAt, filename, createdAt });

describe('pickPrototypeArtifact', () => {
  it('returns null when there are no HTML artifacts', () => {
    expect(pickPrototypeArtifact([a('plan.md', '1'), a('data.json', '2')])).toBeNull();
  });

  it('prefers the newest index.html', () => {
    const picked = pickPrototypeArtifact([
      a('index.html', '2024-01-01'),
      a('pricing.html', '2024-03-01'),
      a('index.html', '2024-02-01'),
    ]);
    expect(picked?.filename).toBe('index.html');
    expect(picked?.createdAt).toBe('2024-02-01'); // newest index.html, not the newer pricing.html
  });

  it('falls back to the newest html when there is no index.html', () => {
    const picked = pickPrototypeArtifact([a('login.html', '2024-01-01'), a('signup.html', '2024-05-01')]);
    expect(picked?.filename).toBe('signup.html');
  });
});
