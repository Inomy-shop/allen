/**
 * Unit tests for the api.ts `createSession` function extended to accept
 * workspaceId as the 5th positional parameter (AC-13, AC-18).
 *
 * api.ts imports `useAuthStore` (zustand) which is not installed in node_modules.
 * We mock the store before importing the module under test.
 *
 * Network calls are intercepted via `globalThis.fetch = vi.fn(...)`.
 *
 * Covered acceptance criteria:
 *   AC-13 – First message creates and links a session to the workspace;
 *            createSession() must include workspaceId in the POST body.
 *   AC-18 – Normal non-workspace createSession() calls do NOT include
 *            workspaceId in the POST body.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock zustand-backed stores BEFORE importing api.ts.
// authStore is the only transitive dependency that would fail.
// ---------------------------------------------------------------------------
vi.mock('../stores/authStore', () => ({
  useAuthStore: {
    getState: vi.fn(() => ({
      accessToken: 'test-access-token',
      refreshToken: null,
      user: null,
      clear: vi.fn(),
      setSession: vi.fn(),
    })),
  },
}));

// Import after mocks
import { chat as chatApi } from './api.js';

// ---------------------------------------------------------------------------
// Helper: build a mock fetch that returns a successful response.
// ---------------------------------------------------------------------------

function mockOkFetch(responseBody: unknown = { _id: 'sess-new-1' }) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(responseBody),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('chatApi.createSession — workspaceId parameter (AC-13)', () => {
  it('AC-13: POST body contains workspaceId when provided as 5th argument', async () => {
    const mockFetch = mockOkFetch({ _id: 'sess-ws-1' });
    globalThis.fetch = mockFetch;

    await chatApi.createSession('claude', 'claude-3-5-sonnet-20241022', undefined, undefined, 'ws-123');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/chat/sessions');
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string);
    expect(body).toHaveProperty('workspaceId', 'ws-123');
  });

  it('AC-13: POST body contains provider + model + workspaceId together', async () => {
    const mockFetch = mockOkFetch({ _id: 'sess-ws-2' });
    globalThis.fetch = mockFetch;

    await chatApi.createSession('codex', 'gpt-4o', undefined, undefined, 'ws-xyz');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.provider).toBe('codex');
    expect(body.model).toBe('gpt-4o');
    expect(body.workspaceId).toBe('ws-xyz');
  });

  it('AC-13: POST body contains agentOverrides alongside workspaceId', async () => {
    const mockFetch = mockOkFetch({ _id: 'sess-ws-3' });
    globalThis.fetch = mockFetch;

    const overrides = { reasoningEffort: 'high' };
    await chatApi.createSession('claude', 'claude-3-5-sonnet-20241022', overrides, undefined, 'ws-override');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.workspaceId).toBe('ws-override');
    expect(body.agentOverrides).toEqual(overrides);
  });
});

describe('chatApi.createSession — no workspaceId (AC-18)', () => {
  it('AC-18: POST body does NOT contain workspaceId when omitted', async () => {
    const mockFetch = mockOkFetch({ _id: 'sess-normal-1' });
    globalThis.fetch = mockFetch;

    await chatApi.createSession('claude', 'claude-3-5-sonnet-20241022');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty('workspaceId');
  });

  it('AC-18: POST body does NOT contain workspaceId when explicitly undefined', async () => {
    const mockFetch = mockOkFetch({ _id: 'sess-normal-2' });
    globalThis.fetch = mockFetch;

    await chatApi.createSession('claude', undefined, undefined, undefined, undefined);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty('workspaceId');
  });

  it('AC-18: no repoId in body when repoId is omitted', async () => {
    const mockFetch = mockOkFetch({ _id: 'sess-normal-3' });
    globalThis.fetch = mockFetch;

    await chatApi.createSession('codex');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty('repoId');
    expect(body).not.toHaveProperty('workspaceId');
  });

  it('AC-18: session with a repoId but no workspaceId → repoId present, workspaceId absent', async () => {
    const mockFetch = mockOkFetch({ _id: 'sess-repo-only' });
    globalThis.fetch = mockFetch;

    await chatApi.createSession('claude', 'claude-3-5-sonnet-20241022', undefined, 'repo-abc');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.repoId).toBe('repo-abc');
    expect(body).not.toHaveProperty('workspaceId');
  });
});

describe('chatApi.createSession — request mechanics', () => {
  it('sends a POST to /api/chat/sessions', async () => {
    const mockFetch = mockOkFetch();
    globalThis.fetch = mockFetch;

    await chatApi.createSession();

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/chat/sessions');
  });

  it('includes Authorization header with Bearer token', async () => {
    const mockFetch = mockOkFetch();
    globalThis.fetch = mockFetch;

    await chatApi.createSession('claude');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-access-token');
  });

  it('returns the parsed session object from the response', async () => {
    const mockFetch = mockOkFetch({ _id: 'returned-sess', title: '' });
    globalThis.fetch = mockFetch;

    const result = await chatApi.createSession('claude', undefined, undefined, undefined, 'ws-ret');

    expect(result).toMatchObject({ _id: 'returned-sess' });
  });
});
