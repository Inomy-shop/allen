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

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Test 1: image-on-mention ──

  it('image-on-mention: appends markdown link when event.files contains an image', async () => {
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
    expect(messageArg).toContain('[photo.jpg](/api/files/');
  });

  // ── Test 2: image-in-thread ──

  it('image-in-thread: appends markdown link from a thread message with files', async () => {
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
    expect(messageArg).toContain('[screenshot.png](/api/files/');
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
});

// ── Progress handler flag tests ──

describe('SlackService ALLEN_SLACK_PROGRESS_POSTS flag', () => {
  const originalProgressPosts = process.env.ALLEN_SLACK_PROGRESS_POSTS;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.ALLEN_SLACK_PROGRESS_POSTS;
    fetchSpy = vi.spyOn(global, 'fetch');
    // Default: all Slack API calls succeed
    fetchSpy.mockResolvedValue(fakeResponse({ ok: true }));
  });

  afterEach(() => {
    if (originalProgressPosts === undefined) delete process.env.ALLEN_SLACK_PROGRESS_POSTS;
    else process.env.ALLEN_SLACK_PROGRESS_POSTS = originalProgressPosts;
    vi.restoreAllMocks();
  });

  it('flag unset → sendMessageForSlack is called with undefined as 5th arg', async () => {
    const { service } = makeService();

    const event = {
      type: 'app_mention',
      text: '<@U123> hello',
      user: 'U456',
      channel: 'C789',
      ts: '111.001',
    };

    await service.handleNewThread('T001', 'C789', '111.001', event);

    const sendCalls = vi.mocked(service.chatService.sendMessageForSlack).mock.calls;
    expect(sendCalls.length).toBeGreaterThan(0);
    // 5th argument (index 4) must be undefined — no progress handler
    expect(sendCalls[0][4]).toBeUndefined();
  });

  it('flag unset → hourglass reaction added, success reaction added, final message posted', async () => {
    const { service } = makeService();

    const event = {
      type: 'app_mention',
      text: '<@U123> hello',
      user: 'U456',
      channel: 'C789',
      ts: '111.002',
    };

    await service.handleNewThread('T001', 'C789', '111.002', event);

    const urls = fetchSpy.mock.calls.map((c) => {
      const input = c[0];
      return typeof input === 'string' ? input : (input as URL).toString();
    });

    // Hourglass reaction must be added
    expect(urls.some((u) => u.includes('reactions.add'))).toBe(true);
    const addBodies = fetchSpy.mock.calls
      .filter((c) => {
        const input = c[0];
        const url = typeof input === 'string' ? input : (input as URL).toString();
        return url.includes('reactions.add');
      })
      .map((c) => {
        const opts = c[1] as RequestInit | undefined;
        return JSON.parse((opts?.body as string) ?? '{}') as Record<string, string>;
      });
    expect(addBodies.some((b) => b.name === 'hourglass_flowing_sand')).toBe(true);
    expect(addBodies.some((b) => b.name === 'white_check_mark')).toBe(true);

    // Final response must be posted via chat.postMessage
    expect(urls.some((u) => u.includes('chat.postMessage'))).toBe(true);
  });

  it('flag set to "true" → sendMessageForSlack is called with a function as 5th arg', async () => {
    process.env.ALLEN_SLACK_PROGRESS_POSTS = 'true';
    const { service } = makeService();

    const event = {
      type: 'app_mention',
      text: '<@U123> hello',
      user: 'U456',
      channel: 'C789',
      ts: '111.003',
    };

    await service.handleNewThread('T001', 'C789', '111.003', event);

    const sendCalls = vi.mocked(service.chatService.sendMessageForSlack).mock.calls;
    expect(sendCalls.length).toBeGreaterThan(0);
    // 5th argument (index 4) must be a function when the flag is enabled
    expect(typeof sendCalls[0][4]).toBe('function');

    // Reactions must still fire even in opt-in mode
    const urls = fetchSpy.mock.calls.map((c) => {
      const input = c[0];
      return typeof input === 'string' ? input : (input as URL).toString();
    });
    expect(urls.some((u) => u.includes('reactions.add'))).toBe(true);
  });

  it('flag set to "1" → sendMessageForSlack is called with a function as 5th arg', async () => {
    process.env.ALLEN_SLACK_PROGRESS_POSTS = '1';
    const { service } = makeService();

    const event = {
      type: 'app_mention',
      text: '<@U123> hello',
      user: 'U456',
      channel: 'C789',
      ts: '111.004',
    };

    await service.handleNewThread('T001', 'C789', '111.004', event);

    const sendCalls = vi.mocked(service.chatService.sendMessageForSlack).mock.calls;
    expect(sendCalls.length).toBeGreaterThan(0);
    expect(typeof sendCalls[0][4]).toBe('function');
  });

  it('flag set to "TRUE" (uppercase) → sendMessageForSlack is called with a function', async () => {
    process.env.ALLEN_SLACK_PROGRESS_POSTS = 'TRUE';
    const { service } = makeService();

    const event = {
      type: 'app_mention',
      text: '<@U123> hello',
      user: 'U456',
      channel: 'C789',
      ts: '111.005',
    };

    await service.handleNewThread('T001', 'C789', '111.005', event);

    const sendCalls = vi.mocked(service.chatService.sendMessageForSlack).mock.calls;
    expect(sendCalls.length).toBeGreaterThan(0);
    expect(typeof sendCalls[0][4]).toBe('function');
  });

  it('flag set to "false" → sendMessageForSlack is called with undefined (OFF)', async () => {
    process.env.ALLEN_SLACK_PROGRESS_POSTS = 'false';
    const { service } = makeService();

    const event = {
      type: 'app_mention',
      text: '<@U123> hello',
      user: 'U456',
      channel: 'C789',
      ts: '111.006',
    };

    await service.handleNewThread('T001', 'C789', '111.006', event);

    const sendCalls = vi.mocked(service.chatService.sendMessageForSlack).mock.calls;
    expect(sendCalls.length).toBeGreaterThan(0);
    expect(sendCalls[0][4]).toBeUndefined();
  });
});

// ── Inline text / markdown file tests ──

describe('SlackService inline text/markdown file handling', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Test: text/markdown mimetype is fetched and inlined ──

  it('text-markdown-attachment: text/markdown file is fetched from Slack and inlined as labelled fenced block, not as a /api/files/ link', async () => {
    const { service } = makeService();
    const markdownContent = '# Hello World\n\nThis is **markdown** content.';

    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('files.slack.com')) {
        // fetchSlackTextContent calls resp.text() — return a response with that method.
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(markdownContent),
        } as unknown as Response);
      }
      // Slack API calls (reactions.add/remove, chat.postMessage)
      return Promise.resolve(fakeResponse({ ok: true }));
    });

    const event = {
      type: 'app_mention',
      text: '<@U123> review this file',
      user: 'U456',
      channel: 'C789',
      ts: '555.001',
      files: [
        {
          id: 'FMD1',
          name: 'notes.md',
          mimetype: 'text/markdown',
          url_private: 'https://files.slack.com/files-pri/aaa/notes.md',
          size: Buffer.byteLength(markdownContent, 'utf8'),
        },
      ],
    };

    await service.handleNewThread('T001', 'C789', '555.001', event);

    const sendCalls = vi.mocked(service.chatService.sendMessageForSlack).mock.calls;
    expect(sendCalls.length).toBeGreaterThan(0);
    const messageArg: string = sendCalls[0][1];

    // Filename label and fenced block must be present
    expect(messageArg).toContain('**File: notes.md**');
    expect(messageArg).toContain('```markdown');
    expect(messageArg).toContain('# Hello World');
    // Must NOT produce a binary download link
    expect(messageArg).not.toContain('/api/files/');
  });

  // ── Test: application/octet-stream + .md extension triggers MIME fallback ──

  it('octet-stream-md-extension: application/octet-stream with .md filename is inlined via MIME fallback, not as a /api/files/ link', async () => {
    const { service } = makeService();
    const markdownContent = '## Architecture\n\nThis file has an `application/octet-stream` MIME type.';

    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('files.slack.com')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(markdownContent),
        } as unknown as Response);
      }
      return Promise.resolve(fakeResponse({ ok: true }));
    });

    const event = {
      type: 'app_mention',
      text: '<@U123> explain this',
      user: 'U456',
      channel: 'C789',
      ts: '555.002',
      files: [
        {
          id: 'FOS1',
          name: 'README.md',
          mimetype: 'application/octet-stream',
          url_private: 'https://files.slack.com/files-pri/bbb/README.md',
          size: Buffer.byteLength(markdownContent, 'utf8'),
        },
      ],
    };

    await service.handleNewThread('T001', 'C789', '555.002', event);

    const sendCalls = vi.mocked(service.chatService.sendMessageForSlack).mock.calls;
    expect(sendCalls.length).toBeGreaterThan(0);
    const messageArg: string = sendCalls[0][1];

    // octet-stream + .md extension → inlined as fenced markdown block, not a download link
    expect(messageArg).toContain('**File: README.md**');
    expect(messageArg).toContain('```markdown');
    expect(messageArg).toContain('## Architecture');
    expect(messageArg).not.toContain('/api/files/');
  });

  // ── Test: content exceeding 8 KB is truncated with a notice ──

  it('truncation: text/markdown content >8 KB is capped at 8 KB and a truncation notice is appended; trailing content is absent', async () => {
    const { service } = makeService();
    // Build content that just exceeds the 8 KB (8 192-byte) inline cap.
    // The first 8 192 bytes are ASCII 'a'; the sentinel that follows must NOT appear in the output.
    const bodyPart = 'a'.repeat(8192);
    const sentinel = 'SENTINEL_TRAILING_CONTENT_MUST_NOT_APPEAR';
    const bigContent = bodyPart + sentinel; // total > 8 192 bytes → triggers truncation

    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('files.slack.com')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(bigContent),
        } as unknown as Response);
      }
      return Promise.resolve(fakeResponse({ ok: true }));
    });

    const event = {
      type: 'app_mention',
      text: '<@U123> summarize this big file',
      user: 'U456',
      channel: 'C789',
      ts: '555.003',
      files: [
        {
          id: 'FBG1',
          name: 'bigfile.md',
          mimetype: 'text/markdown',
          url_private: 'https://files.slack.com/files-pri/ccc/bigfile.md',
          size: Buffer.byteLength(bigContent, 'utf8'),
        },
      ],
    };

    await service.handleNewThread('T001', 'C789', '555.003', event);

    const sendCalls = vi.mocked(service.chatService.sendMessageForSlack).mock.calls;
    expect(sendCalls.length).toBeGreaterThan(0);
    const messageArg: string = sendCalls[0][1];

    // Truncation notice must be present with the correct byte cap and filename
    expect(messageArg).toContain('truncated');
    expect(messageArg).toContain('8 KB');
    expect(messageArg).toContain('"bigfile.md"');
    // Content beyond the 8 KB boundary must NOT appear
    expect(messageArg).not.toContain(sentinel);
  });
});

// ── Bot/app message in thread tests ──

describe('SlackService bot/app messages in thread', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes bot/app messages from conversations.replies in combined message to chatService', async () => {
    const { service } = makeService();

    // Thread timestamps
    const threadTs = '200.000';
    const humanMsgTs = '200.001';
    const botMsgTs = '200.002';
    const triggerTs = '200.999'; // the @Allen mention — must be excluded

    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('conversations.replies')) {
        return Promise.resolve(
          fakeResponse({
            ok: true,
            messages: [
              // Normal human message (not the trigger)
              {
                ts: humanMsgTs,
                user: 'U200',
                text: 'Here is the incident details',
              },
              // Bot/app message — previously filtered out, must now be included
              {
                ts: botMsgTs,
                bot_id: 'B123BOT',
                subtype: 'bot_message',
                text: 'Bot posted this alert message',
                // no `user` field — author will be undefined
              },
              // The triggering @Allen mention — must be excluded
              {
                ts: triggerTs,
                user: 'U456',
                text: '<@U123> please summarize this thread',
              },
            ],
          }),
        );
      }
      // All other Slack API calls (reactions.add/remove, chat.postMessage)
      return Promise.resolve(fakeResponse({ ok: true }));
    });

    // A reply inside an existing thread (thread_ts ≠ ts)
    const event = {
      type: 'app_mention',
      text: '<@U123> please summarize this thread',
      user: 'U456',
      channel: 'C789',
      ts: triggerTs,
      thread_ts: threadTs,
    };

    await service.handleNewThread('T001', 'C789', threadTs, event);

    const sendCalls = vi.mocked(service.chatService.sendMessageForSlack).mock.calls;
    expect(sendCalls.length).toBeGreaterThan(0);
    const messageArg: string = sendCalls[0][1];

    // Bot/app message text must be present in the combined message (AC1, AC2, AC8)
    expect(messageArg).toContain('Bot posted this alert message');

    // Human message text must also be present
    expect(messageArg).toContain('Here is the incident details');

    // The trigger mention (excludeTs) must NOT appear as a thread context entry.
    // The thread context section is before "User's request:" — the trigger text
    // "please summarize this thread" only appears in the "User's request:" part, not
    // as a [Message X] context entry, proving the excludeTs filter still works (AC3).
    const [contextSection] = messageArg.split("User's request:");
    expect(contextSection).not.toContain('please summarize this thread');
  });
});
