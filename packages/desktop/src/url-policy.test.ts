import { describe, it, expect } from 'vitest';
import { isLoopbackHostname, isLocalPreviewUrl, isAllowedExternalUrl } from './url-policy.js';

describe('isLoopbackHostname', () => {
  it('returns true for "localhost"', () => expect(isLoopbackHostname('localhost')).toBe(true));
  it('returns true for "127.0.0.1"', () => expect(isLoopbackHostname('127.0.0.1')).toBe(true));
  it('returns true for "::1"', () => expect(isLoopbackHostname('::1')).toBe(true));
  it('returns true for *.localhost', () => expect(isLoopbackHostname('app.localhost')).toBe(true));
  it('returns false for "example.com"', () => expect(isLoopbackHostname('example.com')).toBe(false));
  it('returns false for "192.168.1.1"', () => expect(isLoopbackHostname('192.168.1.1')).toBe(false));
});

describe('isLocalPreviewUrl', () => {
  it('returns true for http://localhost:12000/', () => expect(isLocalPreviewUrl('http://localhost:12000/')).toBe(true));
  it('returns true for http://127.0.0.1:12001/', () => expect(isLocalPreviewUrl('http://127.0.0.1:12001/')).toBe(true));
  it('returns true for https://localhost:3000/', () => expect(isLocalPreviewUrl('https://localhost:3000/')).toBe(true));
  it('returns false for http://localhost/ (no explicit port)', () => expect(isLocalPreviewUrl('http://localhost/')).toBe(false));
  it('returns false for http://example.com:8080/', () => expect(isLocalPreviewUrl('http://example.com:8080/')).toBe(false));
  it('returns false for malformed string', () => expect(isLocalPreviewUrl('not-a-url')).toBe(false));
});

describe('isAllowedExternalUrl', () => {
  // External HTTPS — allowed
  it('allows https://example.com', () => expect(isAllowedExternalUrl('https://example.com')).toBe(true));
  it('allows https://askallen.build', () => expect(isAllowedExternalUrl('https://askallen.build')).toBe(true));

  // Local preview — allowed
  it('allows http://localhost:12000/', () => expect(isAllowedExternalUrl('http://localhost:12000/')).toBe(true));
  it('allows http://127.0.0.1:12001/', () => expect(isAllowedExternalUrl('http://127.0.0.1:12001/')).toBe(true));

  // Blocked
  it('blocks http://evil.com (non-loopback http)', () => expect(isAllowedExternalUrl('http://evil.com')).toBe(false));
  it('blocks http://localhost/ (no port)', () => expect(isAllowedExternalUrl('http://localhost/')).toBe(false));
  it('blocks empty string', () => expect(isAllowedExternalUrl('')).toBe(false));
  it('blocks malformed URL', () => expect(isAllowedExternalUrl('not a url')).toBe(false));
  it('blocks https://localhost (loopback https without port)', () => expect(isAllowedExternalUrl('https://localhost')).toBe(false));
});
