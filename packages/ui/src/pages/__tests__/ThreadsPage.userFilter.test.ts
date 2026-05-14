import { describe, it, expect } from 'vitest';
import { deriveUserLabel, resolveFilterKey } from '../ThreadsPage';

describe('deriveUserLabel', () => {
  it('returns currentUserName for ui source', () => {
    expect(deriveUserLabel('ui', 'Alice')).toBe('Alice');
  });
  it('returns "UI" when source is ui but no user', () => {
    expect(deriveUserLabel('ui', null)).toBe('UI');
  });
  it('returns "Slack" for slack source', () => {
    expect(deriveUserLabel('slack', 'Alice')).toBe('Slack');
  });
  it('returns "Automation" for automation source', () => {
    expect(deriveUserLabel('automation', 'Alice')).toBe('Automation');
  });
  it('returns "Unknown" for undefined source', () => {
    expect(deriveUserLabel(undefined, 'Alice')).toBe('Unknown');
  });
  it('returns "Unknown" for unrecognised source string', () => {
    expect(deriveUserLabel('api', 'Alice')).toBe('Unknown');
  });
});

describe('resolveFilterKey', () => {
  it('maps "ui" to itself', () => {
    expect(resolveFilterKey('ui')).toBe('ui');
  });
  it('maps "slack" to itself', () => {
    expect(resolveFilterKey('slack')).toBe('slack');
  });
  it('maps "automation" to itself', () => {
    expect(resolveFilterKey('automation')).toBe('automation');
  });
  it('maps undefined to "unknown"', () => {
    expect(resolveFilterKey(undefined)).toBe('unknown');
  });
  it('maps unrecognised string to "unknown"', () => {
    expect(resolveFilterKey('api')).toBe('unknown');
  });
});
