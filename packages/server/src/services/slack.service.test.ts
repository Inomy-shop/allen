import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlackService } from './slack.service.js';

// ── Module mocks (hoisted before imports) ──

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

// Prevent mkdirSync/existsSync from touching the real filesystem at module load.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
  };
});

// ── Existing tests ──

describe('SlackService provider defaults', () => {
  const originalEffort = process.env.ALLEN_SLACK_REASONING_EFFORT;
  const originalProvider = process.env.ALLEN_SLACK_DEFAULT_PROVIDER;
  const originalModel = process.env.ALLEN_SLACK_DEFAULT_MODEL;

  beforeEach(() => {
    delete process.env.ALLEN_SLACK_REASONING_EFFORT;
    delete process.env.ALLEN_SLACK_DEFAULT_PROVIDER;
    delete process.env.ALLEN_SLACK_DEFAULT_MODEL;
  });

  afterEach(() => {
    if (originalEffort === undefined) delete process.env.ALLEN_SLACK_REASONING_EFFORT;
    else process.env.ALLEN_SLACK_REASONING_EFFORT = originalEffort;
    if (originalProvider === undefined) delete process.env.ALLEN_SLACK_DEFAULT_PROVIDER;
    else process.env.ALLEN_SLACK_DEFAULT_PROVIDER = originalProvider;
    if (originalModel === undefined) delete process.env.ALLEN_SLACK_DEFAULT_MODEL;
    else process.env.ALLEN_SLACK_DEFAULT_MODEL = originalModel;
  });

  it('always starts Slack sessions on Codex 5.5, even if text asks for Claude', () => {
    const service = new SlackService({} as any) as any;

    const defaults = service.resolveSlackDefaults('please use claude for this');

    expect(defaults).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.5',
      reasoningEffort: 'high',
    });
  });
});

// ── File attachment tests ──

/** Build a minimal fake fetch Response. */
function fakeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: () => {
      if (body instanceof ArrayBuffer) return Promise.resolve(body);
      return Promise.resolve(Buffer.from('fake-bytes').buffer as ArrayBuffer);
    },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** Create a SlackService with a fully mocked Db and spied-on chatService methods. */
function makeService() {
  const mockCollection = {
    findOne: vi.fn().mockResolvedValue(null),
    insertOne: vi.fn().mockResolvedValue({ insertedId: 'test-id' }),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    createIndex: vi.fn().mockResolvedValue('ok'),
  };
  const mockDb = {
    collection: vi.fn().mockReturnValue(mockCollection),
  } as any;

  const service = new SlackService(mockDb) as any;

  // Mock getBotToken to return a predictable token (never logged).
  vi.spyOn(service, 'getBotToken').mockResolvedValue('xoxb-test-token');

  // Prevent chatService from making any real calls.
  vi.spyOn(service.chatService, 'createSession').mockResolvedValue({
    _id: { toString: () => 'session-123' },
  });
  vi.spyOn(service.chatService, 'sendMessageForSlack').mockResolvedValue({
    text: 'OK',
  });

  return { service, mockCollection };
}

describe('SlackService file attachment handling', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  // Capture the original value before any test sets it.
  const originalPublicUrl = process.env.ALLEN_PUBLIC_URL;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch');
    // Set a predictable public base for all tests in this describe block.
    process.env.ALLEN_PUBLIC_URL = 'https://allen.inomy.test';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore ALLEN_PUBLIC_URL to whatever it was before the test suite ran.
    if (originalPublicUrl === undefined) delete process.env.ALLEN_PUBLIC_URL;
    else process.env.ALLEN_PUBLIC_URL = originalPublicUrl;
  });

  // ── Test 1: image-on-mention ──

  it('image-on-mention: appends markdown link and absolute public URL when event.files contains an image', async () => {
    const { service } = makeService();
    const imageBytes = Buffer.from('fake-image-data').buffer as ArrayBuffer;

    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('files.slack.com')) {
        // Authenticated download of the private file
        return Promise.resolve(fakeResponse(imageBytes));
      }
      // All other Slack API calls (reactions.add/remove, conversations.replies, chat.postMessage)
      return Promise.resolve(fakeResponse({ ok: true, messages: [] }));
    });

    const event = {
      type: 'app_mention',
      text: '<@U123> please analyze this image',
      user: 'U456',
      channel: 'C789',
      ts: '111.001',
      // No thread_ts → top-level mention, no context fetch needed
      files: [
        {
          id: 'F1',
          name: 'photo.jpg',
          mimetype: 'image/jpeg',
          url_private: 'https://files.slack.com/files-pri/xxx/photo.jpg',
          size: 1024,
        },
      ],
    };

    await service.handleNewThread('T001', 'C789', '111.001', event);

    const sendCalls = vi.mocked(service.chatService.sendMessageForSlack).mock.calls;
    expect(sendCalls.length).toBeGreaterThan(0);
    const messageArg: string = sendCalls[0][1];

    // Existing relative Markdown link must be preserved (for UI rendering).
    expect(messageArg).toContain('[photo.jpg](/api/files/');

    // Absolute public URL must be present so agent runtimes can fetch the file.
    expect(messageArg).toContain('https://allen.inomy.test/api/files/');
    expect(messageArg).toContain('Uploaded files / images available at public URLs:');
    expect(messageArg).toContain('If the user asks about an image, fetch/read the relevant URL above directly.');

    // Security: Slack url_private and bot token must NOT appear in the prompt.
    expect(messageArg).not.toContain('url_private');
    expect(messageArg).not.toContain('xoxb-');
    expect(messageArg).not.toContain('files.slack.com');
  });

  // ── Test 2: image-in-thread ──

  it('image-in-thread: appends markdown link and absolute public URL from a thread message with files', async () => {
    const { service } = makeService();
    const imageBytes = Buffer.from('fake-thread-image').buffer as ArrayBuffer;

    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('files.slack.com')) {
        return Promise.resolve(fakeResponse(imageBytes));
      }
      if (url.includes('conversations.replies')) {
        return Promise.resolve(
          fakeResponse({
            ok: true,
            messages: [
              {
                ts: '100.001',
                user: 'U100',
                text: '',
                // Image-only message in thread (no text)
                files: [
                  {
                    id: 'F2',
                    name: 'screenshot.png',
                    mimetype: 'image/png',
                    url_private: 'https://files.slack.com/files-pri/yyy/screenshot.png',
                    size: 2048,
                  },
                ],
              },
            ],
          }),
        );
      }
      return Promise.resolve(fakeResponse({ ok: true }));
    });

    // A reply inside a thread (thread_ts ≠ ts)
    const event = {
      type: 'app_mention',
      text: '<@U123> summarize this',
      user: 'U456',
      channel: 'C789',
      ts: '100.999',
      thread_ts: '100.000',
      // No event.files — file is in thread message only
    };

    // Exclude ts is event.ts; thread root is '100.000'
    await service.handleNewThread('T001', 'C789', '100.000', event);

    const sendCalls = vi.mocked(service.chatService.sendMessageForSlack).mock.calls;
    expect(sendCalls.length).toBeGreaterThan(0);
    const messageArg: string = sendCalls[0][1];

    // Existing relative Markdown link must be preserved.
    expect(messageArg).toContain('[screenshot.png](/api/files/');

    // Absolute public URL must be present.
    expect(messageArg).toContain('https://allen.inomy.test/api/files/');
    expect(messageArg).toContain('Uploaded files / images available at public URLs:');

    // Security: no Slack private metadata in prompt.
    expect(messageArg).not.toContain('url_private');
    expect(messageArg).not.toContain('xoxb-');
  });

  // ── Test 3: size-cap-exceeded ──

  it('size-cap-exceeded: files over 25 MB are skipped — no fetch, no markdown link', async () => {
    const { service } = makeService();

    const result: string | null = await service.downloadSlackFileToUploads(
      {
        id: 'F3',
        name: 'huge.jpg',
        mimetype: 'image/jpeg',
        url_private: 'https://files.slack.com/files-pri/zzz/huge.jpg',
        size: 26 * 1024 * 1024, // 26 MB — over the 25 MB cap
      },
      'xoxb-test-token',
    );

    expect(result).toBeNull();
    // fetch must NOT have been called for the private file URL
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ── Test 4: mimetype-blocked ──

  it('mimetype-blocked: non-image/non-pdf mimetypes are skipped silently', async () => {
    const { service } = makeService();

    const result: string | null = await service.downloadSlackFileToUploads(
      {
        id: 'F4',
        name: 'clip.mp4',
        mimetype: 'video/mp4',
        url_private: 'https://files.slack.com/files-pri/zzz/clip.mp4',
        size: 1024,
      },
      'xoxb-test-token',
    );

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ── Test 5: follow-up mention with image ──

  it('follow-up: image attachment injects absolute public URL into the prompt via handleFollowUp', async () => {
    const { service } = makeService();
    const imageBytes = Buffer.from('fake-followup-image').buffer as ArrayBuffer;

    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('files.slack.com')) {
        return Promise.resolve(fakeResponse(imageBytes));
      }
      // reactions.add / reactions.remove / chat.postMessage
      return Promise.resolve(fakeResponse({ ok: true }));
    });

    const event = {
      type: 'app_mention',
      text: '<@U123> what is in this image',
      user: 'U456',
      channel: 'C789',
      ts: '200.002',
      thread_ts: '200.000',
      files: [
        {
          id: 'F5',
          name: 'followup.png',
          mimetype: 'image/png',
          url_private: 'https://files.slack.com/files-pri/aaa/followup.png',
          size: 512,
        },
      ],
    };

    // Call handleFollowUp directly (simulating a second mention in the same thread).
    await service.handleFollowUp('session-456', event, 'C789', '200.000');

    const sendCalls = vi.mocked(service.chatService.sendMessageForSlack).mock.calls;
    expect(sendCalls.length).toBeGreaterThan(0);
    const messageArg: string = sendCalls[0][1];

    // Relative Markdown link preserved.
    expect(messageArg).toContain('[followup.png](/api/files/');

    // Absolute public URL injected for agent runtimes.
    expect(messageArg).toContain('https://allen.inomy.test/api/files/');
    expect(messageArg).toContain('Uploaded files / images available at public URLs:');
    expect(messageArg).toContain('If the user asks about an image, fetch/read the relevant URL above directly.');

    // Security: no Slack private metadata in prompt.
    expect(messageArg).not.toContain('url_private');
    expect(messageArg).not.toContain('xoxb-');
    expect(messageArg).not.toContain('files.slack.com');
  });
});

// ── Fallback: ALLEN_PUBLIC_URL unset → localhost form ──

describe('SlackService file attachment — ALLEN_PUBLIC_URL fallback', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const originalPublicUrl = process.env.ALLEN_PUBLIC_URL;
  const originalPort = process.env.PORT;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch');
    // Ensure ALLEN_PUBLIC_URL is unset so the fallback path is exercised.
    delete process.env.ALLEN_PUBLIC_URL;
    // Ensure PORT is unset so the default 4023 is used.
    delete process.env.PORT;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalPublicUrl === undefined) delete process.env.ALLEN_PUBLIC_URL;
    else process.env.ALLEN_PUBLIC_URL = originalPublicUrl;
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
  });

  it('fallback: uses http://localhost:4023 when ALLEN_PUBLIC_URL is unset', async () => {
    const { service } = makeService();
    const imageBytes = Buffer.from('fake-fallback-image').buffer as ArrayBuffer;

    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('files.slack.com')) {
        return Promise.resolve(fakeResponse(imageBytes));
      }
      return Promise.resolve(fakeResponse({ ok: true, messages: [] }));
    });

    const event = {
      type: 'app_mention',
      text: '<@U123> describe this',
      user: 'U789',
      channel: 'C789',
      ts: '300.001',
      // No thread_ts → top-level mention
      files: [
        {
          id: 'F6',
          name: 'fallback.jpg',
          mimetype: 'image/jpeg',
          url_private: 'https://files.slack.com/files-pri/bbb/fallback.jpg',
          size: 256,
        },
      ],
    };

    await service.handleNewThread('T001', 'C789', '300.001', event);

    const sendCalls = vi.mocked(service.chatService.sendMessageForSlack).mock.calls;
    expect(sendCalls.length).toBeGreaterThan(0);
    const messageArg: string = sendCalls[0][1];

    // Fallback: absolute URL must start with http://localhost:4023
    expect(messageArg).toContain('http://localhost:4023/api/files/');
    expect(messageArg).toContain('Uploaded files / images available at public URLs:');

    // Security: no Slack private metadata.
    expect(messageArg).not.toContain('url_private');
    expect(messageArg).not.toContain('xoxb-');
  });
});
