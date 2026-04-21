import { describe, it, expect } from 'vitest';
import { evaluateCondition, validateCondition } from './condition-parser.js';

describe('condition-parser', () => {
  describe('basic boolean expressions', () => {
    it('evaluates a bare truthy identifier', () => {
      expect(evaluateCondition('validation_passed', { validation_passed: true })).toBe(true);
    });

    it('evaluates a bare falsy identifier', () => {
      expect(evaluateCondition('validation_passed', { validation_passed: false })).toBe(false);
    });

    it('negates a truthy identifier with NOT', () => {
      expect(evaluateCondition('NOT validation_passed', { validation_passed: true })).toBe(false);
    });

    it('negates a falsy identifier with NOT', () => {
      expect(evaluateCondition('NOT validation_passed', { validation_passed: false })).toBe(true);
    });
  });

  describe('regression: missing identifiers must not evaluate both `x` and `NOT x` to true', () => {
    // Root cause: filtrex returns an UnknownPropertyError object (not throws)
    // when an identifier is missing from state. `!!errorObject` is true, so
    // without the fix both `validation_passed` and `NOT validation_passed`
    // evaluated to true, making retry and pass edges fire simultaneously.
    it('treats missing identifier as false for positive check', () => {
      expect(evaluateCondition('validation_passed', {})).toBe(false);
    });

    it('treats missing identifier as true for NOT check', () => {
      expect(evaluateCondition('NOT validation_passed', {})).toBe(true);
    });

    it('treats undefined value as false', () => {
      expect(evaluateCondition('x', { x: undefined })).toBe(false);
      expect(evaluateCondition('NOT x', { x: undefined })).toBe(true);
    });

    it('treats null value as false', () => {
      expect(evaluateCondition('x', { x: null })).toBe(false);
      expect(evaluateCondition('NOT x', { x: null })).toBe(true);
    });
  });

  describe('null / undefined literals in expressions', () => {
    it('x != null is true when x has a string value', () => {
      expect(evaluateCondition('repo_path != null', { repo_path: '/some/path' })).toBe(true);
    });

    it('x != null is false when x is null in state', () => {
      expect(evaluateCondition('repo_path != null', { repo_path: null })).toBe(false);
    });

    it('x != null is false when x is missing from state', () => {
      expect(evaluateCondition('repo_path != null', {})).toBe(false);
    });

    it('x == null is true when x is missing', () => {
      expect(evaluateCondition('repo_path == null', {})).toBe(true);
    });

    it('x == null is false when x has a value', () => {
      expect(evaluateCondition('repo_path == null', { repo_path: '/path' })).toBe(false);
    });

    it('compound condition with null check and string check', () => {
      // The exact condition from the workflow bug report
      expect(
        evaluateCondition(
          'needs_clarification != true AND repo_path != null AND repo_path != ""',
          { needs_clarification: false, repo_path: '/some/repo' },
        ),
      ).toBe(true);
    });

    it('alternative branch with null check evaluates correctly', () => {
      expect(
        evaluateCondition(
          'needs_clarification != true AND (repo_path == null OR repo_path == "")',
          { needs_clarification: false, repo_path: '/some/repo' },
        ),
      ).toBe(false);
    });

    it('x != undefined behaves like x != null', () => {
      expect(evaluateCondition('x != undefined', { x: 'hello' })).toBe(true);
      expect(evaluateCondition('x != undefined', {})).toBe(false);
    });
  });

  describe('logical operators', () => {
    it('AND of two truthies', () => {
      expect(evaluateCondition('a AND b', { a: true, b: true })).toBe(true);
    });

    it('AND with one falsy', () => {
      expect(evaluateCondition('a AND b', { a: true, b: false })).toBe(false);
    });

    it('OR of one truthy and one missing', () => {
      expect(evaluateCondition('a OR b', { a: true })).toBe(true);
    });

    it('chained ANDs with negation', () => {
      // regression shape from coding-workflow.yml:
      // "NOT validation_passed AND has_backend_changes AND has_frontend_changes"
      expect(
        evaluateCondition('NOT validation_passed AND has_backend_changes AND has_frontend_changes', {
          validation_passed: false,
          has_backend_changes: true,
          has_frontend_changes: true,
        }),
      ).toBe(true);
      expect(
        evaluateCondition('NOT validation_passed AND has_backend_changes AND has_frontend_changes', {
          validation_passed: true,
          has_backend_changes: true,
          has_frontend_changes: true,
        }),
      ).toBe(false);
    });

    it('handles lowercase and/or/not as well', () => {
      expect(evaluateCondition('a and b', { a: true, b: true })).toBe(true);
      expect(evaluateCondition('not a', { a: false })).toBe(true);
    });
  });

  describe('string comparison', () => {
    it('equality with single quotes', () => {
      expect(evaluateCondition("status == 'passed'", { status: 'passed' })).toBe(true);
      expect(evaluateCondition("status == 'passed'", { status: 'failed' })).toBe(false);
    });

    it('inequality with single quotes', () => {
      expect(evaluateCondition("open_questions != 'none'", { open_questions: 'what?' })).toBe(true);
      expect(evaluateCondition("open_questions != 'none'", { open_questions: 'none' })).toBe(false);
    });

    it('enum-style comparisons from coding-workflow', () => {
      expect(
        evaluateCondition("completeness == 'fully_complete'", { completeness: 'fully_complete' }),
      ).toBe(true);
      expect(
        evaluateCondition("security_verdict == 'REQUEST_CHANGES'", {
          security_verdict: 'REQUEST_CHANGES',
        }),
      ).toBe(true);
    });
  });

  describe('validateCondition', () => {
    it('does not throw on valid expressions', () => {
      expect(() => validateCondition('a AND b')).not.toThrow();
      expect(() => validateCondition("status == 'foo'")).not.toThrow();
      expect(() => validateCondition('NOT x AND y OR z')).not.toThrow();
    });

    it('throws on invalid expressions', () => {
      expect(() => validateCondition('a AND AND b')).toThrow();
    });
  });
});
