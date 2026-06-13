/**
 * Tests for soft-delete helpers used by agents, workflows, teams, and skills.
 *
 * Covers:
 *   - notDeletedFilter constant
 *   - softDeleteSet() shape
 *   - restoreSet() shape
 */
import { describe, it, expect } from 'vitest';
import { notDeletedFilter, softDeleteSet, restoreSet } from './soft-delete.js';

describe('notDeletedFilter', () => {
  it('excludes documents where isDeleted is true', () => {
    expect(notDeletedFilter).toEqual({ isDeleted: { $ne: true } });
  });
});

describe('softDeleteSet', () => {
  it('returns $set with isDeleted=true and Date-valued deletedAt/updatedAt', () => {
    const result = softDeleteSet();
    expect(result).toHaveProperty('$set');
    const s = result.$set as Record<string, unknown>;
    expect(s.isDeleted).toBe(true);
    expect(s.deletedAt).toBeInstanceOf(Date);
    expect(s.updatedAt).toBeInstanceOf(Date);
    // No userId passed → deletedBy should not be set
    expect(s).not.toHaveProperty('deletedBy');
  });

  it('includes deletedBy when currentUserId is provided', () => {
    const result = softDeleteSet('user-42');
    const s = result.$set as Record<string, unknown>;
    expect(s.deletedBy).toBe('user-42');
  });

  it('produces a fresh Date each call', async () => {
    const a = softDeleteSet();
    await new Promise((r) => setTimeout(r, 5));
    const b = softDeleteSet();
    const aAt = (a.$set as Record<string, unknown>).deletedAt as Date;
    const bAt = (b.$set as Record<string, unknown>).deletedAt as Date;
    expect(bAt.getTime()).toBeGreaterThan(aAt.getTime());
  });
});

describe('restoreSet', () => {
  it('returns $set with isDeleted=false, deletedAt=null, restoredAt and $unset for deletedBy/deletedReason', () => {
    const now = new Date('2026-06-11T00:00:00.000Z');
    const payload = { name: 'test', description: 'restored' };
    const result = restoreSet(payload);

    // Verify $set
    expect(result).toHaveProperty('$set');
    const s = result.$set as Record<string, unknown>;
    expect(s.isDeleted).toBe(false);
    expect(s.deletedAt).toBeNull();
    expect(s.restoredAt).toBeInstanceOf(Date);
    expect(s.updatedAt).toBeInstanceOf(Date);
    // Original payload merged in
    expect(s.name).toBe('test');
    expect(s.description).toBe('restored');

    // Verify $unset
    expect(result).toHaveProperty('$unset');
    const u = result.$unset as Record<string, unknown>;
    expect(u).toHaveProperty('deletedBy');
    expect(u).toHaveProperty('deletedReason');
  });

  it('merges arbitrary new payload fields into $set', () => {
    const payload = { displayName: 'Foo', teamName: 'bar', isBuiltIn: false };
    const result = restoreSet(payload);
    const s = result.$set as Record<string, unknown>;
    expect(s.displayName).toBe('Foo');
    expect(s.teamName).toBe('bar');
    expect(s.isBuiltIn).toBe(false);
  });

  it('overwrites isDeleted even if payload contains isDeleted true', () => {
    const payload = { isDeleted: true };
    const result = restoreSet(payload);
    const s = result.$set as Record<string, unknown>;
    // restoreSet's own isDeleted: false must win
    expect(s.isDeleted).toBe(false);
  });
});
