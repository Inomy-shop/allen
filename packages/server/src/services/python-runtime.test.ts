import { afterEach, describe, expect, it } from 'vitest';
import { resolveAllenPython } from './python-runtime.js';

const originalAllenPython = process.env.ALLEN_PYTHON;
const originalPython = process.env.PYTHON;
const originalHome = process.env.HOME;

describe('resolveAllenPython', () => {
  afterEach(() => {
    if (originalAllenPython === undefined) delete process.env.ALLEN_PYTHON;
    else process.env.ALLEN_PYTHON = originalAllenPython;
    if (originalPython === undefined) delete process.env.PYTHON;
    else process.env.PYTHON = originalPython;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('prefers ALLEN_PYTHON for Allen-owned Python sidecars', () => {
    process.env.ALLEN_PYTHON = '/tmp/allen-python';
    process.env.PYTHON = '/tmp/generic-python';

    expect(resolveAllenPython()).toBe('/tmp/allen-python');
  });

  it('falls back to PYTHON when ALLEN_PYTHON is not set', () => {
    delete process.env.ALLEN_PYTHON;
    process.env.PYTHON = '/tmp/generic-python';

    expect(resolveAllenPython()).toBe('/tmp/generic-python');
  });

  it('ignores blank overrides', () => {
    process.env.ALLEN_PYTHON = '   ';
    process.env.PYTHON = '/tmp/generic-python';

    expect(resolveAllenPython()).toBe('/tmp/generic-python');
  });

  it('expands shell-style HOME prefixes from .env values', () => {
    process.env.HOME = '/Users/tester';
    process.env.ALLEN_PYTHON = '$HOME/.allen/python/context-eval/bin/python';

    expect(resolveAllenPython()).toBe('/Users/tester/.allen/python/context-eval/bin/python');
  });

  it('expands braced and tilde home prefixes from .env values', () => {
    process.env.HOME = '/Users/tester';
    process.env.ALLEN_PYTHON = '${HOME}/.allen/python/context-eval/bin/python';
    expect(resolveAllenPython()).toBe('/Users/tester/.allen/python/context-eval/bin/python');

    process.env.ALLEN_PYTHON = '~/.allen/python/context-eval/bin/python';
    expect(resolveAllenPython()).toBe('/Users/tester/.allen/python/context-eval/bin/python');
  });

  it('falls back to python3 when no override is set', () => {
    delete process.env.ALLEN_PYTHON;
    delete process.env.PYTHON;

    expect(resolveAllenPython()).toBe('python3');
  });
});
