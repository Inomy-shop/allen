import { describe, expect, it } from 'vitest';
import { modelTierLabel } from './ModelRegistryPanel';

describe('modelTierLabel', () => {
  it('qualifies provider defaults by runtime usage', () => {
    expect(modelTierLabel({ tier: 'default', fullId: 'claude-opus' } as any, 'claude-opus')).toBe('Default · chat');
    expect(modelTierLabel({ tier: 'default', fullId: 'claude-sonnet' } as any, 'claude-opus')).toBe('Default · workflow');
  });
});
