import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  generateTempPassword,
} from './password.js';

describe('password: hashPassword + verifyPassword', () => {
  it('hashes and verifies a correct password', async () => {
    const hash = await hashPassword('Hunter2!xyz');
    expect(hash).not.toBe('Hunter2!xyz');
    expect(hash.length).toBeGreaterThan(40);
    expect(await verifyPassword('Hunter2!xyz', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('Correct-Horse-1!');
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('produces different hashes for the same input (salted)', async () => {
    const a = await hashPassword('SameInput-1!');
    const b = await hashPassword('SameInput-1!');
    expect(a).not.toBe(b);
  });
});

describe('password: validatePasswordStrength', () => {
  const cases: Array<[string, string, boolean]> = [
    ['Valid1!aA', 'valid password', true],
    ['Short1!', 'too short', false],
    ['alllowercase1!', 'missing uppercase', false],
    ['ALLUPPERCASE1!', 'missing lowercase', false],
    ['NoDigits!abc', 'missing number', false],
    ['NoSymbol123a', 'missing symbol', false],
    ['', 'empty string', false],
  ];

  for (const [pw, name, expected] of cases) {
    it(`${name}: ${expected ? 'accepts' : 'rejects'}`, () => {
      const res = validatePasswordStrength(pw);
      expect(res.valid).toBe(expected);
      if (!expected) expect(res.error).toBeTruthy();
    });
  }

  it('rejects non-string input', () => {
    // @ts-expect-error intentional
    expect(validatePasswordStrength(undefined).valid).toBe(false);
    // @ts-expect-error intentional
    expect(validatePasswordStrength(12345).valid).toBe(false);
  });
});

describe('password: generateTempPassword', () => {
  it('generates a 12-char password', () => {
    const pw = generateTempPassword();
    expect(pw.length).toBe(12);
  });

  it('always satisfies its own strength policy', () => {
    for (let i = 0; i < 200; i++) {
      const pw = generateTempPassword();
      const res = validatePasswordStrength(pw);
      expect(res.valid, `failed for: ${pw} — ${res.error}`).toBe(true);
    }
  });

  it('is non-deterministic across calls', () => {
    const set = new Set<string>();
    for (let i = 0; i < 50; i++) set.add(generateTempPassword());
    expect(set.size).toBeGreaterThan(45);
  });
});
