import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockInventory = vi.hoisted(() => ({
  candidates: [] as Array<{ path: string; title: string; sourceHash: string; bytes: number; kind: 'markdown' }>,
}));

vi.mock('./repo-context-curation-git.js', () => ({
  collectDefaultBranchContextFiles: vi.fn(async (_repoPath: string, branch: string) => ({
    branch,
    ref: `origin/${branch}`,
    headSha: 'head-sha',
    fetchOk: true,
    candidates: mockInventory.candidates,
    diagnostics: [],
  })),
  contextInventoryConfig: () => ({ source: 'test' }),
  resolveDefaultBranchName: () => 'main',
  isSafeBranchName: vi.fn((value: string) =>
    Boolean(value)
    && !/[\s\0~^:?*[\\]/.test(value)
    && !value.includes('..')
    && !value.includes('@{')
    && !value.startsWith('-')
    && !value.endsWith('.'),
  ),
  resolveRequestedBranch: vi.fn((requested: string | undefined, defaultBranch: string) => {
    if (!requested) return defaultBranch;
    const normalized = requested.startsWith('origin/') ? requested.slice('origin/'.length) : requested;
    const safe = Boolean(normalized)
      && !/[\s\0~^:?*[\\]/.test(normalized)
      && !normalized.includes('..')
      && !normalized.includes('@{')
      && !normalized.startsWith('-')
      && !normalized.endsWith('.');
    return safe ? normalized : defaultBranch;
  }),
  // G1: default to undefined (no advance); override per test for stale-at-promote cases
  revParse: vi.fn(async () => undefined),
}));

vi.mock('../common/context-role-inventory.js', () => ({
  buildWorkflowRoleInventory: vi.fn(async () => []),
  buildSpawnedAgentRoleInventory: vi.fn(async () => []),
}));

// Partially mock the runner: keep buildRepoContextCurationAssignmentPlan and validateStageEntry
// as real implementations (used by existing tests), but stub createRepoContextCurationRun and
// getRepoContextCurationStageStatus so that Fix H tests don't need a fully-functional MongoDB mock.
vi.mock('./repo-context-curation-runner.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createRepoContextCurationRun: vi.fn(async () => ({ runId: 'fix-h-mocked-run' })),
    getRepoContextCurationStageStatus: vi.fn(async () => ({
      runId: 'fix-h-mocked-run',
      status: 'running',
      expectedFiles: 0,
      stagedEntries: 0,
      validEntries: 0,
      stagedStatuses: 0,
      completedFiles: 0,
      missingFiles: [],
      invalidFiles: [],
      duplicateStatusFiles: [],
      retryFiles: [],
      promotable: false,
      entries: [],
      diagnostics: [],
    })),
  };
});

import { RepoContextCurationService } from './repo-context-curation.service.js';
import {
  buildRepoContextCuratorSystemPrompt,
  buildRepoContextCuratorWorkerSystemPrompt,
  buildRepoContextCuratorWorkerUserPrompt,
} from './repo-context-curator-prompts.js';
import {
  buildRepoContextCurationAssignmentPlan,
  validateStageEntry,
  getRepoContextCurationStageStatus,
  createRepoContextCurationRun,
} from './repo-context-curation-runner.js';
import * as gitModule from './repo-context-curation-git.js';
import {
  makeCollection as makeMockCollection,
  makeDb as makeMockDb,
} from '../../../test-helpers/mock-mongo.js';

function candidate(path: string, sourceHash: string) {
  return { path, title: path, sourceHash, bytes: 1000, kind: 'markdown' as const };
}

function entry(path: string, sourceHash: string, promptVersion = 1) {
  return {
    entryId: `entry:${path}`,
    repoId: 'repo-1',
    path,
    sourceHash,
    title: path,
    category: 'doc',
    inclusion: 'include',
    authority: 'medium',
    freshness: 'current',
    injectionPolicy: 'snippet',
    summary: path,
    curatedContext: `curated ${path}`,
    retrievalText: `retrieval ${path}`,
    chunks: [],
    aliases: [],
    appliesToGlobs: [],
    mandatoryForNodeRoles: [],
    mandatoryForSpawnedAgentRoles: [],
    mandatoryForSpawnerRoles: [],
    sourceAnchors: [],
    reasoning: '',
    curationVersion: 2,
    promptVersion,
    configHash: `old-config-${promptVersion}`,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

function makeDb(priorEntries: Record<string, unknown>[] = []) {
  return {
    collection: (name: string) => ({
      find: (query: Record<string, unknown>) => ({
        toArray: async () => name === 'repo_context_curation_entries'
          ? priorEntries.filter((doc) => doc.repoId === query.repoId && doc.curationVersion === query.curationVersion)
          : [],
      }),
      findOne: async () => null,
      insertOne: async () => ({}),
      updateOne: async () => ({}),
      updateMany: async () => ({}),
    }),
  } as any;
}

function makeLatestDb(input: {
  profiles: Record<string, unknown>[];
  executions?: Record<string, unknown>[];
  runs?: Record<string, unknown>[];
}) {
  const profiles = input.profiles;
  const executions = input.executions ?? [];
  const runs = input.runs ?? [];
  return {
    collection: (name: string) => ({
      find: (query: Record<string, unknown>) => ({
        sort: () => ({
          toArray: async () => name === 'repo_context_curation_profiles'
            ? profiles.filter((profile) => matches(profile, query)).sort((a, b) => dateMs(b.createdAt) - dateMs(a.createdAt))
            : [],
        }),
        toArray: async () => name === 'repo_context_curation_profiles'
          ? profiles.filter((profile) => matches(profile, query))
          : [],
      }),
      findOne: async (query: Record<string, unknown>) => {
        const rows = name === 'repo_context_curation_profiles'
          ? profiles
          : name === 'executions'
            ? executions
            : [];
        return rows.find((row) => matches(row, query)) ?? null;
      },
      updateOne: async (query: Record<string, unknown>, update: Record<string, any>) => {
        const rows = name === 'repo_context_curation_profiles'
          ? profiles
          : name === 'executions'
            ? executions
            : runs;
        const row = rows.find((item) => matches(item, query));
        if (row && update.$set) Object.assign(row, update.$set);
        return { modifiedCount: row ? 1 : 0 };
      },
      updateMany: async (query: Record<string, unknown>, update: Record<string, any>) => {
        const rows = name === 'repo_context_curation_profiles'
          ? profiles
          : name === 'repo_context_curation_runs'
            ? runs
            : [];
        let modifiedCount = 0;
        for (const row of rows.filter((item) => matches(item, query))) {
          if (update.$set) Object.assign(row, update.$set);
          modifiedCount++;
        }
        return { modifiedCount };
      },
    }),
  } as any;
}

function matches(row: Record<string, unknown>, query: Record<string, unknown>): boolean {
  return Object.entries(query).every(([key, value]) => row[key] === value);
}

function dateMs(value: unknown): number {
  const date = value instanceof Date ? value : new Date(String(value ?? 0));
  return Number.isFinite(date.getTime()) ? date.getTime() : 0;
}

async function buildInput(priorEntries: Record<string, unknown>[], scope: Record<string, unknown> = {}, options: { branch?: string } = {}) {
  const service = new RepoContextCurationService(makeDb(priorEntries));
  return (service as any).buildRunInput({ _id: 'repo-1', name: 'repo', path: '/tmp/repo' }, scope, options);
}

describe('RepoContextCurationService reuse selection', () => {
  beforeEach(() => {
    mockInventory.candidates = [];
  });

  it('reuses same path and source hash even when prompt metadata is older', async () => {
    mockInventory.candidates = [candidate('docs/a.md', 'hash-a')];

    const input = await buildInput([entry('docs/a.md', 'hash-a', 1)]);

    expect(input.reusedEntries).toHaveLength(1);
    expect(input.newOrChangedFiles).toHaveLength(0);
  });

  it('selects changed hashes for curation', async () => {
    mockInventory.candidates = [candidate('docs/a.md', 'hash-new')];

    const input = await buildInput([entry('docs/a.md', 'hash-old', 1)]);

    expect(input.reusedEntries).toHaveLength(0);
    expect(input.newOrChangedFiles.map((file: any) => file.path)).toEqual(['docs/a.md']);
  });

  it('force selects unchanged files for curation', async () => {
    mockInventory.candidates = [candidate('docs/a.md', 'hash-a')];

    const input = await buildInput([entry('docs/a.md', 'hash-a', 1)], { force: true });

    expect(input.reusedEntries).toHaveLength(0);
    expect(input.newOrChangedFiles.map((file: any) => file.path)).toEqual(['docs/a.md']);
  });

  it('force with a pattern only selects matching unchanged files', async () => {
    mockInventory.candidates = [
      candidate('docs/a.md', 'hash-a'),
      candidate('docs/b.md', 'hash-b'),
    ];

    const input = await buildInput(
      [entry('docs/a.md', 'hash-a', 1), entry('docs/b.md', 'hash-b', 1)],
      { pattern: 'docs/a', force: true },
    );

    expect(input.candidates.map((file: any) => file.path)).toEqual(['docs/a.md']);
    expect(input.newOrChangedFiles.map((file: any) => file.path)).toEqual(['docs/a.md']);
  });

  it('keeps agent-adjacent files in default curation so workers can classify mixed content', async () => {
    mockInventory.candidates = [
      candidate('.claude/agents/chief.md', 'hash-chief'),
      candidate('.claude/agents/engineering-lead.md', 'hash-lead'),
      candidate('.claude/agents/chief/memory/team-learnings.md', 'hash-chief-memory'),
      candidate('.claude/agents/engineering/agents/memory/git-ops-manager-memory.md', 'hash-agent-memory'),
      candidate('.claude/agents/learnings-agent-template.md', 'hash-learning-template'),
      candidate('.agents/backend-developer.md', 'hash-backend'),
      candidate('AGENTS.md', 'hash-agents'),
      candidate('CLAUDE.md', 'hash-claude'),
      candidate('docs/agent-memory/lessons.md', 'hash-memory'),
    ];

    const input = await buildInput([]);

    expect(input.candidates.map((file: any) => file.path)).toEqual([
      '.claude/agents/chief.md',
      '.claude/agents/engineering-lead.md',
      '.claude/agents/chief/memory/team-learnings.md',
      '.claude/agents/engineering/agents/memory/git-ops-manager-memory.md',
      '.claude/agents/learnings-agent-template.md',
      '.agents/backend-developer.md',
      'AGENTS.md',
      'CLAUDE.md',
      'docs/agent-memory/lessons.md',
    ]);
    expect(input.newOrChangedFiles.map((file: any) => file.path)).toEqual([
      '.claude/agents/chief.md',
      '.claude/agents/engineering-lead.md',
      '.claude/agents/chief/memory/team-learnings.md',
      '.claude/agents/engineering/agents/memory/git-ops-manager-memory.md',
      '.claude/agents/learnings-agent-template.md',
      '.agents/backend-developer.md',
      'AGENTS.md',
      'CLAUDE.md',
      'docs/agent-memory/lessons.md',
    ]);
  });

  it('includes subagent persona files when explicitly scoped', async () => {
    mockInventory.candidates = [
      candidate('.claude/agents/chief.md', 'hash-chief'),
      candidate('docs/agent-memory/lessons.md', 'hash-memory'),
    ];

    const input = await buildInput([], { pattern: '.claude/agents' });

    expect(input.candidates.map((file: any) => file.path)).toEqual(['.claude/agents/chief.md']);
  });
});

describe('RepoContextCurationService save promotion', () => {
  it('uses curator replacement for new entries and archives deleted entries through the editor', async () => {
    const repoId = '507f1f77bcf86cd799439011';
    const newEntry = { ...entry('docs/a.md', 'hash-a'), repoId };
    const service = new RepoContextCurationService(makeDb([]));
    const editor = {
      replaceFromCurator: vi.fn(async () => ({ revision: {}, entry: {} })),
      getEntry: vi.fn(async () => ({ entryId: 'entry:docs/deleted.md' })),
      applyEdit: vi.fn(async () => ({ revision: {}, entry: {} })),
    };
    (service as any).editor = editor;

    await (service as any).saveCompletedCuration({
      input: {
        repoId,
        repoName: 'repo',
        repoPath: '/tmp/repo',
        configHash: 'config-hash',
        roleInventory: [],
        spawnedRoleInventory: [],
        candidates: [candidate('docs/a.md', 'hash-a')],
        reusedEntries: [],
        newOrChangedFiles: [candidate('docs/a.md', 'hash-a')],
        deletedOrStaleFiles: [{ entryId: 'entry:docs/deleted.md', path: 'docs/deleted.md', sourceHash: 'hash-deleted' }],
        diagnostics: [],
      },
      profileId: 'profile-1',
      executionId: 'execution-1',
      newEntries: [newEntry],
      diagnostics: [],
      costUsd: 0,
      startedAt: Date.now(),
      message: 'done',
    });

    expect(editor.replaceFromCurator).toHaveBeenCalledWith(
      repoId,
      'entry:docs/a.md',
      expect.objectContaining({ path: 'docs/a.md' }),
      { actor: 'repo-context-curator', source: 'repo_context_curator' },
    );
    expect(editor.applyEdit).toHaveBeenCalledWith(
      repoId,
      'entry:docs/deleted.md',
      {},
      { actor: 'repo-context-curator', source: 'repo_context_curator', action: 'archive' },
    );
  });
});

describe('RepoContextCurationService latest profile selection', () => {
  it('ignores stale running profiles and returns the completed latest profile', async () => {
    const profiles = [
      {
        profileId: 'running-profile',
        repoId: 'repo-1',
        status: 'running',
        latest: false,
        executionId: 'exec-stale',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        stats: { candidateFiles: 557, newOrChangedFiles: 557 },
      },
      {
        profileId: 'completed-profile',
        repoId: 'repo-1',
        status: 'completed',
        latest: true,
        executionId: 'exec-completed',
        createdAt: new Date('2026-01-01T01:00:00Z'),
        updatedAt: new Date('2026-01-01T02:00:00Z'),
        stats: { totalEntries: 541, generatedChunks: 1633 },
      },
    ];
    const db = makeLatestDb({
      profiles,
      executions: [{ id: 'exec-stale', status: 'failed', completedAt: new Date('2026-01-01T00:05:00Z') }],
      runs: [{ executionId: 'exec-stale', status: 'running' }],
    });
    const service = new RepoContextCurationService(db);

    const latest = await service.getLatest('repo-1');

    expect(latest?.profileId).toBe('completed-profile');
    expect(profiles[0].status).toBe('stopped');
  });

  it('returns an active running profile before the completed profile', async () => {
    const now = new Date();
    const profiles = [
      {
        profileId: 'running-profile',
        repoId: 'repo-1',
        status: 'running',
        latest: false,
        executionId: 'exec-running',
        createdAt: now,
        updatedAt: now,
        stats: { candidateFiles: 1 },
      },
      {
        profileId: 'completed-profile',
        repoId: 'repo-1',
        status: 'completed',
        latest: true,
        executionId: 'exec-completed',
        createdAt: new Date('2026-01-01T01:00:00Z'),
        updatedAt: new Date('2026-01-01T02:00:00Z'),
        stats: { totalEntries: 1 },
      },
    ];
    const db = makeLatestDb({
      profiles,
      executions: [{ id: 'exec-running', status: 'running', updatedAt: now }],
    });
    const service = new RepoContextCurationService(db);

    const latest = await service.getLatest('repo-1');

    expect(latest?.profileId).toBe('running-profile');
    expect(profiles[0].status).toBe('running');
  });
});

describe('Repo context curation assignment planning', () => {
  it('splits large runs into multiple immediate worker assignments', () => {
    const files = Array.from({ length: 45 }, (_, index) => candidate(`docs/${String(index).padStart(2, '0')}.md`, `hash-${index}`));

    const plan = buildRepoContextCurationAssignmentPlan('run-1', files, {
      maxFilesPerAssignment: 10,
      maxBytesPerAssignment: 100_000,
      concurrencyLimit: 8,
    });

    expect(plan.assignments).toHaveLength(5);
    expect(plan.concurrencyLimit).toBe(4);
    expect(plan.immediateWorkerCount).toBe(4);
    expect(plan.assignments[0]).toMatchObject({
      assignmentId: 'curation-001',
      workerId: 'repo-context-curation-worker-001',
      fileCount: 10,
    });
    expect(plan.assignments.flatMap((assignment) => assignment.files)).toHaveLength(45);
  });

  it('isolates large files so one huge document does not bloat a worker prompt', () => {
    const files = [
      { ...candidate('docs/small-a.md', 'hash-a'), bytes: 1000 },
      { ...candidate('docs/huge.md', 'hash-huge'), bytes: 400_000 },
      { ...candidate('docs/small-b.md', 'hash-b'), bytes: 1000 },
    ];

    const plan = buildRepoContextCurationAssignmentPlan('run-1', files, {
      maxFilesPerAssignment: 10,
      maxBytesPerAssignment: 500_000,
      concurrencyLimit: 8,
    });

    expect(plan.assignments).toHaveLength(2);
    expect(plan.assignments.find((assignment) => assignment.files.some((file) => file.path === 'docs/huge.md'))?.files).toHaveLength(1);
  });

  it('uses larger default byte budgets to reduce assignment count', () => {
    const files = Array.from({ length: 30 }, (_, index) => ({
      ...candidate(`docs/topic/${String(index).padStart(2, '0')}.md`, `hash-${index}`),
      bytes: 20_000,
    }));

    const plan = buildRepoContextCurationAssignmentPlan('run-1', files);

    expect(plan.assignments).toHaveLength(2);
    expect(plan.assignments.map((assignment) => assignment.fileCount)).toEqual([17, 13]);
    expect(plan.concurrencyLimit).toBe(4);
  });
});

describe('Repo context curator prompt contract', () => {
  it('requires assignment planning and forbids pilot-first fanout for large runs', () => {
    const prompt = buildRepoContextCuratorSystemPrompt();

    expect(prompt).toContain('Call plan_repo_context_curation_assignments');
    expect(prompt).toContain('Fire those mcp__allen__spawn_agent calls back-to-back before waiting');
    expect(prompt).toContain('Do not run a single pilot/test worker unless');
  });

  it('instructs workers to keep production learnings and omit agent persona instructions (G4-revised explicit rule)', () => {
    const coordinatorPrompt = buildRepoContextCuratorSystemPrompt();
    const workerPrompt = buildRepoContextCuratorWorkerSystemPrompt();

    // G4-revised: both prompts now contain an explicit numbered agent-file policy rule
    expect(coordinatorPrompt).toContain('Agent-adjacent file policy (.claude/agents/**');
    expect(coordinatorPrompt).toContain('DEFAULT: set inclusion: exclude, category: agent_persona');
    expect(coordinatorPrompt).toContain('entry.reasoning MUST name the specific learning content');
    expect(workerPrompt).toContain('Agent-adjacent file policy (.claude/agents/**');
    expect(workerPrompt).toContain('DEFAULT: set inclusion: exclude, category: agent_persona');
    expect(workerPrompt).toContain('curate ONLY the extracted learning sections');
    expect(workerPrompt).toContain('Omit all persona/system text from curatedContext, retrievalText, and chunks');
  });

  it('instructs workers to save incrementally in batches of at most 5 files', () => {
    const coordinatorPrompt = buildRepoContextCuratorSystemPrompt();
    const workerSystemPrompt = buildRepoContextCuratorWorkerSystemPrompt();
    const workerUserPrompt = buildRepoContextCuratorWorkerUserPrompt({
      repoName: 'my-repo',
      repoPath: '/tmp/repo',
      runId: 'run-1',
      assignmentId: 'curation-001',
      workerId: 'repo-context-curation-worker-001',
      roleInventory: [],
      spawnedRoleInventory: [],
      assignedFiles: [],
    });

    expect(coordinatorPrompt).toMatch(/batches of at most 5 files/i);
    expect(workerSystemPrompt).toMatch(/batches of at most 5 files/i);
    expect(workerUserPrompt).toMatch(/batches of at most 5 files/i);
    // Incremental, not one giant final save
    expect(workerSystemPrompt).toContain('Do not hold the whole assignment for one final save');
    expect(workerUserPrompt).toContain('Do not hold the whole assignment for one final save');
  });
});

describe('Repo context curation stage validation', () => {
  it('rejects injectable agent persona snippets', () => {
    const validation = validateStageEntry({
      path: '.agents/backend-developer.md',
      title: 'Backend developer persona',
      category: 'agent_persona',
      inclusion: 'include',
      injectionPolicy: 'snippet',
      curatedContext: 'You are the backend developer subagent. Use allowed tools and spawn agents when needed.',
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('agent_persona_not_injectable');
  });

  it('allows source-grounded learnings from agent-adjacent files under production categories', () => {
    const validation = validateStageEntry({
      path: '.claude/agents/chief/memory/team-learnings.md',
      title: 'Team learnings',
      category: 'production_note',
      inclusion: 'include',
      injectionPolicy: 'snippet',
      curatedContext: [
        'Learning: Product grouping failures usually trace back to product_group_temp table joins.',
        'Debugging pattern: check the identifier config service, grouping module, schema columns, and query filters before changing matcher behavior.',
      ].join(' '),
    });

    expect(validation.ok).toBe(true);
  });
});

describe('Branch-aware curation', () => {
  beforeEach(() => {
    mockInventory.candidates = [];
    vi.mocked(gitModule.collectDefaultBranchContextFiles).mockClear();
  });

  it('passes default branch to inventory when no branch override is given', async () => {
    mockInventory.candidates = [candidate('docs/a.md', 'hash-a')];

    const input = await buildInput([]);

    expect(gitModule.collectDefaultBranchContextFiles).toHaveBeenCalledWith('/tmp/repo', 'main');
    expect(input.branch).toBe('main');
    expect(input.gitRef).toBe('origin/main');
  });

  it('passes the requested branch to inventory, including knowledge-docs paths', async () => {
    mockInventory.candidates = [
      candidate('knowledge-docs/onboarding.md', 'hash-onboarding'),
      candidate('knowledge-docs/runbook.md', 'hash-runbook'),
    ];

    const input = await buildInput([], {}, { branch: 'context/knowledge-docs-curation-branch-tfsvp1' });

    expect(gitModule.collectDefaultBranchContextFiles).toHaveBeenCalledWith(
      '/tmp/repo',
      'context/knowledge-docs-curation-branch-tfsvp1',
    );
    expect(input.branch).toBe('context/knowledge-docs-curation-branch-tfsvp1');
    expect(input.newOrChangedFiles.map((f: any) => f.path)).toEqual([
      'knowledge-docs/onboarding.md',
      'knowledge-docs/runbook.md',
    ]);
  });

  it('strips leading origin/ prefix and passes bare branch name to inventory', async () => {
    mockInventory.candidates = [candidate('docs/a.md', 'hash-a')];

    const input = await buildInput([], {}, { branch: 'origin/feature/my-docs' });

    // resolveRequestedBranch strips "origin/" before passing to git
    expect(gitModule.collectDefaultBranchContextFiles).toHaveBeenCalledWith('/tmp/repo', 'feature/my-docs');
    expect(input.branch).toBe('feature/my-docs');
  });

  it('falls back to default branch when requested branch is unsafe (shell injection attempt)', async () => {
    mockInventory.candidates = [candidate('docs/a.md', 'hash-a')];

    // Branch with spaces and dangerous chars
    const input = await buildInput([], {}, { branch: 'main; rm -rf /' });

    expect(gitModule.collectDefaultBranchContextFiles).toHaveBeenCalledWith('/tmp/repo', 'main');
    expect(input.branch).toBe('main');
  });

  it('falls back to default branch when requested branch contains double-dot path traversal', async () => {
    mockInventory.candidates = [candidate('docs/a.md', 'hash-a')];

    const input = await buildInput([], {}, { branch: '../secret-branch' });

    expect(gitModule.collectDefaultBranchContextFiles).toHaveBeenCalledWith('/tmp/repo', 'main');
    expect(input.branch).toBe('main');
  });

  it('falls back to default branch when requested branch starts with a dash', async () => {
    mockInventory.candidates = [candidate('docs/a.md', 'hash-a')];

    const input = await buildInput([], {}, { branch: '-evil' });

    expect(gitModule.collectDefaultBranchContextFiles).toHaveBeenCalledWith('/tmp/repo', 'main');
    expect(input.branch).toBe('main');
  });
});

describe('Coordinator and worker prompts include branch/ref context', () => {
  it('coordinator system prompt instructs passing branch for non-default branch curation', () => {
    const prompt = buildRepoContextCuratorSystemPrompt();

    expect(prompt).toContain('branch');
    expect(prompt).toContain('prepare_repo_context_curation');
  });

  it('worker user prompt includes branch and HEAD sha fields', () => {
    const prompt = buildRepoContextCuratorWorkerUserPrompt({
      repoName: 'my-repo',
      repoPath: '/tmp/repo',
      branch: 'context/knowledge-docs-curation-branch-tfsvp1',
      headSha: 'abc123',
      runId: 'run-1',
      assignmentId: 'curation-001',
      workerId: 'repo-context-curation-worker-001',
      roleInventory: [],
      spawnedRoleInventory: [],
      assignedFiles: [],
    });

    expect(prompt).toContain('context/knowledge-docs-curation-branch-tfsvp1');
    expect(prompt).toContain('abc123');
  });
});

// ── Fix H: prepareForCoordinator — skip_execution_record prevents phantom row ─

// Valid 24-char hex ObjectId for Fix H tests
const FIX_H_REPO_ID = '507f1f77bcf86cd799439022';

describe('Fix H: prepareForCoordinator execution record behavior', () => {
  /** Build a db mock that tracks executions.insertOne calls and supports the
   *  full collection surface needed by prepareForCoordinator. */
  function makeFullDb() {
    const executionsInserted: Record<string, unknown>[] = [];
    const profilesInserted: Record<string, unknown>[] = [];
    const runsInserted: Record<string, unknown>[] = [];
    const reposUpdated: Array<{ filter: unknown; update: unknown }> = [];

    // Shared store for profiles
    const profilesStore = profilesInserted;

    const makeTrackedCol = (name: string) => ({
      findOne: vi.fn(async () => null),
      find: vi.fn(() => ({ toArray: async () => [], sort: function () { return this; } })),
      insertOne: vi.fn(async (doc: Record<string, unknown>) => {
        if (name === 'executions') executionsInserted.push(doc);
        if (name === 'repo_context_curation_profiles') profilesInserted.push(doc);
        if (name === 'repo_context_curation_runs') runsInserted.push(doc);
        return { insertedId: doc.profileId ?? doc.id ?? doc.runId };
      }),
      updateOne: vi.fn(async (filter: unknown, update: unknown) => {
        if (name === 'repos') reposUpdated.push({ filter, update });
        if (name === 'repo_context_curation_profiles') {
          const $set = ((update as Record<string, unknown>).$set ?? {}) as Record<string, unknown>;
          const idx = profilesStore.findIndex((p) => (p as Record<string, unknown>).profileId === (filter as Record<string, unknown>).profileId);
          if (idx >= 0) Object.assign(profilesStore[idx], $set);
        }
        return { modifiedCount: 1 };
      }),
      updateMany: vi.fn(async () => ({ modifiedCount: 0 })),
    });

    const cols: Record<string, ReturnType<typeof makeTrackedCol>> = {};
    const getCol = (name: string) => {
      if (!cols[name]) cols[name] = makeTrackedCol(name);
      return cols[name];
    };
    // Repo col: findOne returns a test repo with a valid ObjectId-compatible _id
    const repoCol = makeTrackedCol('repos');
    repoCol.findOne = vi.fn(async () => ({
      _id: { toString: () => FIX_H_REPO_ID, toHexString: () => FIX_H_REPO_ID },
      name: 'test-repo',
      path: '/tmp/repo',
    }));

    const db = {
      collection: (name: string) => {
        if (name === 'repos') return repoCol;
        return getCol(name);
      },
    } as any;

    return { db, executionsInserted, profilesInserted, runsInserted, reposUpdated, cols, getCol };
  }

  beforeEach(() => {
    // Reset mockInventory
    mockInventory.candidates = [{ path: 'docs/a.md', title: 'A', sourceHash: 'h1', bytes: 100, kind: 'markdown' as const }];
  });

  it('legacy: WITHOUT skip_execution_record, createRunningProfile inserts an executions row (regression guard)', async () => {
    const { db, executionsInserted } = makeFullDb();
    const svc = new RepoContextCurationService(db);

    // Call without skip_execution_record — should go through createRunningProfile → createCurationExecution
    await svc.prepareForCoordinator({ repo_id: FIX_H_REPO_ID });

    // The phantom executions row MUST be created in legacy mode
    expect(executionsInserted.length).toBeGreaterThanOrEqual(1);
    const row = executionsInserted[0];
    expect(row).toMatchObject({ meta: expect.objectContaining({ spawnedBy: 'repo-context-curation' }) });
  });

  it('Fix H: WITH skip_execution_record:true, no executions row is inserted', async () => {
    const { db, executionsInserted } = makeFullDb();
    const svc = new RepoContextCurationService(db);

    await svc.prepareForCoordinator({ repo_id: FIX_H_REPO_ID, skip_execution_record: true });

    // No phantom executions row
    expect(executionsInserted).toHaveLength(0);
  });

  it('Fix H: profile is inserted with executionId undefined when skip_execution_record:true', async () => {
    const { db, profilesInserted } = makeFullDb();
    const svc = new RepoContextCurationService(db);

    await svc.prepareForCoordinator({ repo_id: FIX_H_REPO_ID, skip_execution_record: true });

    expect(profilesInserted.length).toBeGreaterThanOrEqual(1);
    // profile.executionId should be undefined/missing — will be set by attachExecutionToProfile
    const profile = profilesInserted[0] as Record<string, unknown>;
    expect(profile.executionId).toBeUndefined();
  });

  it('attachExecutionToProfile backfills executionId on profile and stage-run', async () => {
    const { db, profilesInserted } = makeFullDb();
    const svc = new RepoContextCurationService(db);

    const result = await svc.prepareForCoordinator({ repo_id: FIX_H_REPO_ID, skip_execution_record: true });
    const profileId = String(result.profile_id ?? '');
    const runId = String(result.run_id ?? '');

    // Add the profile to the findOne mock so attach can read it
    const profileDoc = profilesInserted[0] as Record<string, unknown>;
    const profileCol = db.collection('repo_context_curation_profiles');
    (profileCol.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(profileDoc);

    // Clear updateOne history accumulated by prepareForCoordinator (including the G1 snapshot
    // persistence on the runs collection) so we only see calls made by attachExecutionToProfile.
    (profileCol.updateOne as ReturnType<typeof vi.fn>).mockClear();
    const runsColForClear = db.collection('repo_context_curation_runs');
    (runsColForClear.updateOne as ReturnType<typeof vi.fn>).mockClear();

    await svc.attachExecutionToProfile(profileId, runId, 'real-exec-1');

    // Profile updateOne must be called with executionId
    const profileUpdateCall = (profileCol.updateOne as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => {
        const filter = call[0] as Record<string, unknown>;
        const update = call[1] as Record<string, unknown>;
        const $s = (update.$set ?? {}) as Record<string, unknown>;
        return String(filter.profileId ?? '') === profileId && 'executionId' in $s;
      },
    );
    expect(profileUpdateCall).toBeDefined();
    const $set = ((profileUpdateCall![1] as Record<string, unknown>).$set ?? {}) as Record<string, unknown>;
    expect($set.executionId).toBe('real-exec-1');

    // Stage-run collection updateOne must also be called with executionId
    const runsCol = db.collection('repo_context_curation_runs');
    const runsUpdateCall = (runsCol.updateOne as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => String((call[0] as Record<string, unknown>).runId ?? '') === runId,
    );
    expect(runsUpdateCall).toBeDefined();
    const runsSet = ((runsUpdateCall![1] as Record<string, unknown>).$set ?? {}) as Record<string, unknown>;
    expect(runsSet.executionId).toBe('real-exec-1');
  });
});

// ── G1: Snapshot freshness ──────────────────────────────────────────────────────

describe('G1: Snapshot freshness', () => {
  /** Minimal tracked db for G1 freshness tests — all collections have spied updateOne/findOne. */
  function makeG1Db(runsRows: Record<string, unknown>[] = []) {
    const runsUpdateCalls: Array<[unknown, unknown]> = [];
    const makeCol = (name: string) => ({
      find: vi.fn(() => ({ toArray: async () => [], sort: function () { return this; } })),
      findOne: vi.fn(async () => null),
      insertOne: vi.fn(async (doc: Record<string, unknown>) => ({ insertedId: doc.profileId ?? doc.id ?? doc.runId ?? 'inserted' })),
      updateOne: vi.fn(async (filter: unknown, update: unknown) => {
        if (name === 'repo_context_curation_runs') runsUpdateCalls.push([filter, update]);
        return { modifiedCount: 1 };
      }),
      updateMany: vi.fn(async () => ({ modifiedCount: 0 })),
    });

    const cols: Record<string, ReturnType<typeof makeCol>> = {};
    const getCol = (n: string) => { if (!cols[n]) cols[n] = makeCol(n); return cols[n]; };

    // repos col: always return the test repo
    const repoCol = makeCol('repos');
    repoCol.findOne = vi.fn(async () => ({
      _id: { toString: () => FIX_H_REPO_ID, toHexString: () => FIX_H_REPO_ID },
      name: 'test-repo',
      path: '/tmp/repo',
    }));

    // runs col: findOne returns from runsRows
    const runsCol = makeCol('repo_context_curation_runs');
    runsCol.findOne = vi.fn(async (filter: Record<string, unknown>) =>
      runsRows.find((r) => r.runId === filter.runId) ?? null,
    );

    const db = {
      collection: (n: string) => {
        if (n === 'repos') return repoCol;
        if (n === 'repo_context_curation_runs') return runsCol;
        return getCol(n);
      },
    } as any;

    return { db, runsUpdateCalls, getCol, runsCol, repoCol };
  }

  beforeEach(() => {
    mockInventory.candidates = [{ path: 'docs/a.md', title: 'A', sourceHash: 'h1', bytes: 100, kind: 'markdown' as const }];
    vi.mocked(gitModule.collectDefaultBranchContextFiles).mockClear();
    vi.mocked(gitModule.revParse).mockClear();
  });

  it('buildRunInput: fetchOk=false → snapshotFresh=false and snapshotFetchOk=false', async () => {
    vi.mocked(gitModule.collectDefaultBranchContextFiles).mockResolvedValueOnce({
      branch: 'main',
      ref: 'HEAD',
      headSha: 'head-sha',
      fetchOk: false,
      candidates: mockInventory.candidates,
      diagnostics: [{ code: 'default_branch_fetch_failed', severity: 'warn' }],
    });

    const input = await buildInput([]);

    expect(input.snapshotFresh).toBe(false);
    expect(input.snapshotFetchOk).toBe(false);
  });

  it('buildRunInput: fetchOk=true and ref matches origin/<branch> → snapshotFresh=true', async () => {
    // Default mock returns fetchOk:true, ref:`origin/main` → snapshotFresh:true
    const input = await buildInput([]);
    expect(input.snapshotFresh).toBe(true);
    expect(input.snapshotFetchOk).toBe(true);
  });

  it('prepareForCoordinator: returns snapshot block with fresh=true by default', async () => {
    const { db } = makeG1Db();
    const svc = new RepoContextCurationService(db);

    const result = await svc.prepareForCoordinator({ repo_id: FIX_H_REPO_ID, skip_execution_record: true });
    const snapshot = result.snapshot as Record<string, unknown>;

    expect(snapshot).toBeDefined();
    expect(snapshot.fresh).toBe(true);
    expect(snapshot.ref).toBe('origin/main');
    expect(snapshot.fetch_ok).toBe(true);
    expect(snapshot.head_sha).toBe('head-sha');
  });

  it('prepareForCoordinator: adds inventory_snapshot_stale diagnostic when fetchOk=false', async () => {
    vi.mocked(gitModule.collectDefaultBranchContextFiles).mockResolvedValueOnce({
      branch: 'main',
      ref: 'HEAD',
      headSha: 'old-sha',
      fetchOk: false,
      candidates: mockInventory.candidates,
      diagnostics: [],
    });

    const { db } = makeG1Db();
    const svc = new RepoContextCurationService(db);

    const result = await svc.prepareForCoordinator({ repo_id: FIX_H_REPO_ID, skip_execution_record: true });
    const diagnostics = result.diagnostics as Array<Record<string, unknown>>;
    const snapshot = result.snapshot as Record<string, unknown>;

    expect(diagnostics.some((d) => d.code === 'inventory_snapshot_stale')).toBe(true);
    expect(snapshot.fresh).toBe(false);
    expect(snapshot.fetch_ok).toBe(false);
  });

  it('prepareForCoordinator: persists snapshotHeadSha and snapshotFresh on run doc via updateOne', async () => {
    const { db, runsUpdateCalls } = makeG1Db();
    const svc = new RepoContextCurationService(db);

    await svc.prepareForCoordinator({ repo_id: FIX_H_REPO_ID, skip_execution_record: true });

    const snapshotUpdate = runsUpdateCalls.find(([, update]) => {
      const $set = ((update as Record<string, unknown>).$set ?? {}) as Record<string, unknown>;
      return 'snapshotHeadSha' in $set;
    });
    expect(snapshotUpdate).toBeDefined();
    const $set = ((snapshotUpdate![1] as Record<string, unknown>).$set ?? {}) as Record<string, unknown>;
    expect($set.snapshotHeadSha).toBe('head-sha');
    expect($set.snapshotFresh).toBe(true);
    expect($set.snapshotFetchOk).toBe(true);
  });

  it('promoteStageFromAgent: attaches snapshot_stale_at_promote when origin advanced; promote still succeeds', async () => {
    // Override stage status to promotable for this test
    vi.mocked(getRepoContextCurationStageStatus).mockResolvedValueOnce({
      runId: 'g1-run',
      status: 'validated',
      expectedFiles: 0,
      stagedEntries: 0,
      validEntries: 0,
      stagedStatuses: 0,
      completedFiles: 0,
      missingFiles: [],
      invalidFiles: [],
      duplicateStatusFiles: [],
      retryFiles: [],
      promotable: true,
      entries: [],
      diagnostics: [],
    } as any);

    // revParse returns a SHA newer than the snapshot → stale-at-promote
    vi.mocked(gitModule.revParse).mockResolvedValueOnce('new-sha-at-promote');

    const runDoc = {
      runId: 'g1-run',
      repoId: FIX_H_REPO_ID,
      profileId: 'g1-profile',
      executionId: 'g1-exec',
      status: 'running',
      branch: 'main',
      scope: {},
      expectedFiles: [],
      snapshotHeadSha: 'old-snapshot-sha',
    };

    const { db } = makeG1Db([runDoc]);
    const svc = new RepoContextCurationService(db);

    const result = await svc.promoteStageFromAgent({ run_id: 'g1-run' });

    // Promote must succeed regardless of staleness
    expect(result).toMatchObject({ run_id: 'g1-run', profile_id: 'g1-profile' });

    // Diagnostics must include the stale-at-promote warning
    const diagnostics = result.diagnostics as Array<Record<string, unknown>>;
    const staleDiag = diagnostics.find((d) => d.code === 'snapshot_stale_at_promote');
    expect(staleDiag).toBeDefined();
    expect(staleDiag?.severity).toBe('warning');
    expect(staleDiag?.currentHeadSha).toBe('new-sha-at-promote');
    expect(staleDiag?.snapshotHeadSha).toBe('old-snapshot-sha');
  });

  it('promoteStageFromAgent: no stale-at-promote diagnostic when revParse returns undefined (non-fatal)', async () => {
    // Override stage status to promotable for this test
    vi.mocked(getRepoContextCurationStageStatus).mockResolvedValueOnce({
      runId: 'g1-run-ok',
      status: 'validated',
      expectedFiles: 0,
      stagedEntries: 0,
      validEntries: 0,
      stagedStatuses: 0,
      completedFiles: 0,
      missingFiles: [],
      invalidFiles: [],
      duplicateStatusFiles: [],
      retryFiles: [],
      promotable: true,
      entries: [],
      diagnostics: [],
    } as any);

    vi.mocked(gitModule.revParse).mockResolvedValueOnce(undefined);

    const runDoc = {
      runId: 'g1-run-ok',
      repoId: FIX_H_REPO_ID,
      profileId: 'g1-profile-ok',
      executionId: 'g1-exec-ok',
      status: 'running',
      branch: 'main',
      scope: {},
      expectedFiles: [],
      snapshotHeadSha: 'snapshot-sha',
    };

    const { db } = makeG1Db([runDoc]);
    const svc = new RepoContextCurationService(db);

    const result = await svc.promoteStageFromAgent({ run_id: 'g1-run-ok' });

    expect(result).toMatchObject({ run_id: 'g1-run-ok' });
    const diagnostics = result.diagnostics as Array<Record<string, unknown>>;
    expect(diagnostics.some((d) => d.code === 'snapshot_stale_at_promote')).toBe(false);
  });
});

// ── Fix L: prepareForCoordinator honors run_id (reuse staged progress) ───────

describe('Fix L: prepareForCoordinator run_id reuse', () => {
  /** Builds a db mock suitable for Fix L tests.
   *  runsRows are served by repo_context_curation_runs.findOne.
   *  runsInserted tracks createRepoContextCurationRun calls (via insertOne on that collection). */
  function makeFixLDb(runsRows: Record<string, unknown>[] = []) {
    const runsInserted: Record<string, unknown>[] = [];
    const profilesUpdated: Array<[unknown, unknown]> = [];

    const makeCol = (name: string) => ({
      find: vi.fn(() => ({ toArray: async () => [], sort: function () { return this; } })),
      findOne: vi.fn(async () => null),
      insertOne: vi.fn(async (doc: Record<string, unknown>) => {
        if (name === 'repo_context_curation_runs') runsInserted.push(doc);
        return { insertedId: doc.profileId ?? doc.id ?? doc.runId ?? 'inserted' };
      }),
      updateOne: vi.fn(async (filter: unknown, update: unknown) => {
        if (name === 'repo_context_curation_profiles') profilesUpdated.push([filter, update]);
        return { modifiedCount: 1 };
      }),
      updateMany: vi.fn(async () => ({ modifiedCount: 0 })),
    });

    const cols: Record<string, ReturnType<typeof makeCol>> = {};
    const getCol = (n: string) => { if (!cols[n]) cols[n] = makeCol(n); return cols[n]; };

    // repos col: always return the test repo
    const repoCol = makeCol('repos');
    repoCol.findOne = vi.fn(async () => ({
      _id: { toString: () => FIX_H_REPO_ID, toHexString: () => FIX_H_REPO_ID },
      name: 'test-repo',
      path: '/tmp/repo',
    }));

    // runs col: findOne returns from runsRows; insertOne tracked
    const runsCol = makeCol('repo_context_curation_runs');
    runsCol.findOne = vi.fn(async (filter: Record<string, unknown>) =>
      runsRows.find((r) => r.runId === filter.runId) ?? null,
    );
    runsCol.insertOne = vi.fn(async (doc: Record<string, unknown>) => {
      runsInserted.push(doc);
      return { insertedId: doc.runId ?? 'new-run' };
    });

    const db = {
      collection: (n: string) => {
        if (n === 'repos') return repoCol;
        if (n === 'repo_context_curation_runs') return runsCol;
        return getCol(n);
      },
    } as any;

    return { db, runsInserted, profilesUpdated, runsCol, repoCol };
  }

  beforeEach(() => {
    mockInventory.candidates = [{ path: 'docs/a.md', title: 'A', sourceHash: 'h1', bytes: 100, kind: 'markdown' as const }];
    // Reset createRepoContextCurationRun mock call count before each Fix L test
    vi.mocked(createRepoContextCurationRun).mockClear();
  });

  it('active run_id → returns reuse response with curation_run_reused diagnostic, createRepoContextCurationRun NOT called', async () => {
    const existingRun = {
      runId: 'existing-run-1',
      repoId: FIX_H_REPO_ID,
      profileId: 'existing-profile-1',
      executionId: 'existing-exec-1',
      status: 'running',
      branch: 'main',
      scope: {},
      expectedFiles: [{ path: 'docs/a.md', sourceHash: 'h1', title: 'A', bytes: 100, kind: 'markdown' }],
    };

    // Stage status returns retry files (the staged progress)
    vi.mocked(getRepoContextCurationStageStatus).mockResolvedValueOnce({
      runId: 'existing-run-1',
      status: 'running',
      expectedFiles: 1,
      stagedEntries: 0,
      validEntries: 0,
      stagedStatuses: 0,
      completedFiles: 0,
      missingFiles: [{ path: 'docs/a.md', sourceHash: 'h1', title: 'A', bytes: 100, kind: 'markdown' }],
      invalidFiles: [],
      duplicateStatusFiles: [],
      retryFiles: [{ path: 'docs/a.md', sourceHash: 'h1', title: 'A', bytes: 100, kind: 'markdown' }],
      promotable: false,
      entries: [],
      diagnostics: [],
    } as any);

    const { db, profilesUpdated } = makeFixLDb([existingRun]);
    const svc = new RepoContextCurationService(db);

    const result = await svc.prepareForCoordinator({
      repo_id: FIX_H_REPO_ID,
      run_id: 'existing-run-1',
      skip_execution_record: true,
    });

    // Must return the SAME run_id and profile_id
    expect(result.run_id).toBe('existing-run-1');
    expect(result.profile_id).toBe('existing-profile-1');

    // createRepoContextCurationRun must NOT have been called (reuse path skips run creation)
    expect(vi.mocked(createRepoContextCurationRun)).not.toHaveBeenCalled();

    // Must have curation_run_reused diagnostic
    const diagnostics = result.diagnostics as Array<Record<string, unknown>>;
    expect(diagnostics.some((d) => d.code === 'curation_run_reused')).toBe(true);

    // Profile message was updated
    expect(profilesUpdated.some(([, upd]) => {
      const $s = ((upd as Record<string, unknown>).$set ?? {}) as Record<string, unknown>;
      return typeof $s.message === 'string' && $s.message.includes('pending');
    })).toBe(true);

    // files_to_curate comes from retryFiles
    expect(result.files_to_curate_count).toBe(1);
  });

  it('stale run_id (not active) → creates new run (createRepoContextCurationRun called) and adds run_id_not_reusable diagnostic', async () => {
    const staleRun = {
      runId: 'stale-run-1',
      repoId: FIX_H_REPO_ID,
      profileId: 'stale-profile',
      executionId: 'stale-exec',
      status: 'promoted', // not 'running'
      branch: 'main',
      scope: {},
      expectedFiles: [],
    };

    const { db } = makeFixLDb([staleRun]);
    const svc = new RepoContextCurationService(db);

    const result = await svc.prepareForCoordinator({
      repo_id: FIX_H_REPO_ID,
      run_id: 'stale-run-1',
      skip_execution_record: true,
    });

    // Must have called createRepoContextCurationRun to create a NEW run
    expect(vi.mocked(createRepoContextCurationRun)).toHaveBeenCalled();

    // Must have run_id_not_reusable diagnostic
    const diagnostics = result.diagnostics as Array<Record<string, unknown>>;
    expect(diagnostics.some((d) => d.code === 'run_id_not_reusable')).toBe(true);
    const diag = diagnostics.find((d) => d.code === 'run_id_not_reusable')!;
    expect(diag.requestedRunId).toBe('stale-run-1');
  });

  it('completed run_id → creates new run (createRepoContextCurationRun called) and adds run_id_not_reusable diagnostic', async () => {
    const completedRun = {
      runId: 'completed-run-1',
      repoId: FIX_H_REPO_ID,
      profileId: 'completed-profile',
      executionId: 'completed-exec',
      status: 'completed', // terminal success — never reactivated
      branch: 'main',
      scope: {},
      expectedFiles: [],
    };

    const { db } = makeFixLDb([completedRun]);
    const svc = new RepoContextCurationService(db);

    const result = await svc.prepareForCoordinator({
      repo_id: FIX_H_REPO_ID,
      run_id: 'completed-run-1',
      skip_execution_record: true,
    });

    expect(vi.mocked(createRepoContextCurationRun)).toHaveBeenCalled();

    const diagnostics = result.diagnostics as Array<Record<string, unknown>>;
    expect(diagnostics.some((d) => d.code === 'run_id_not_reusable')).toBe(true);
    expect(diagnostics.some((d) => d.code === 'curation_run_reactivated')).toBe(false);
  });

  it('unknown run_id → creates new run and adds run_id_not_reusable diagnostic', async () => {
    // No runs in the store
    const { db } = makeFixLDb([]);
    const svc = new RepoContextCurationService(db);

    const result = await svc.prepareForCoordinator({
      repo_id: FIX_H_REPO_ID,
      run_id: 'ghost-run-999',
      skip_execution_record: true,
    });

    // Must have called createRepoContextCurationRun to create a NEW run
    expect(vi.mocked(createRepoContextCurationRun)).toHaveBeenCalled();

    // Must have run_id_not_reusable diagnostic
    const diagnostics = result.diagnostics as Array<Record<string, unknown>>;
    expect(diagnostics.some((d) => d.code === 'run_id_not_reusable')).toBe(true);
    const diag = diagnostics.find((d) => d.code === 'run_id_not_reusable')!;
    expect(diag.requestedRunId).toBe('ghost-run-999');
  });

  it('no run_id in body → normal behavior, createRepoContextCurationRun called, no run_id_not_reusable diagnostic', async () => {
    const { db } = makeFixLDb([]);
    const svc = new RepoContextCurationService(db);

    const result = await svc.prepareForCoordinator({
      repo_id: FIX_H_REPO_ID,
      skip_execution_record: true,
    });

    // New run created normally via createRepoContextCurationRun
    expect(vi.mocked(createRepoContextCurationRun)).toHaveBeenCalled();

    // No run_id_not_reusable diagnostic (no run_id was requested)
    const diagnostics = result.diagnostics as Array<Record<string, unknown>>;
    expect(diagnostics.some((d) => d.code === 'run_id_not_reusable')).toBe(false);
  });

  it('active run_id for different repo → creates new run, run_id_not_reusable diagnostic', async () => {
    const otherRepoRun = {
      runId: 'other-repo-run',
      repoId: 'aaaaaaaaaaaaaaaaaaaaaaaa', // different repo
      profileId: 'other-profile',
      executionId: 'other-exec',
      status: 'running',
      branch: 'main',
      scope: {},
      expectedFiles: [],
    };

    const { db } = makeFixLDb([otherRepoRun]);
    const svc = new RepoContextCurationService(db);

    const result = await svc.prepareForCoordinator({
      repo_id: FIX_H_REPO_ID,
      run_id: 'other-repo-run',
      skip_execution_record: true,
    });

    // Must have created a NEW run (different repoId → not reusable)
    expect(vi.mocked(createRepoContextCurationRun)).toHaveBeenCalled();

    const diagnostics = result.diagnostics as Array<Record<string, unknown>>;
    expect(diagnostics.some((d) => d.code === 'run_id_not_reusable')).toBe(true);
  });
});

// ── Stall recovery: prepareForCoordinator reactivates stopped curation runs ──

describe('Stall recovery: prepareForCoordinator reactivates stopped runs', () => {
  const REPO_OBJECT_ID = { toString: () => FIX_H_REPO_ID, toHexString: () => FIX_H_REPO_ID };
  const WATCHDOG_MESSAGE = 'Context curation was interrupted or abandoned; showing the latest completed curation profile.';

  function stageStatusWithRetryFiles(runId: string, retryFiles: Array<Record<string, unknown>>) {
    return {
      runId,
      status: 'running',
      expectedFiles: retryFiles.length,
      stagedEntries: 0,
      validEntries: 0,
      stagedStatuses: 0,
      completedFiles: 0,
      missingFiles: retryFiles,
      invalidFiles: [],
      duplicateStatusFiles: [],
      retryFiles,
      promotable: false,
      entries: [],
      diagnostics: [],
    } as any;
  }

  function makeStoppedFixture() {
    const stoppedAt = new Date('2026-06-01T00:00:00Z');
    const runs = makeMockCollection([{
      runId: 'stopped-run-1',
      repoId: FIX_H_REPO_ID,
      profileId: 'stopped-profile-1',
      executionId: 'stopped-exec-1',
      status: 'stopped',
      message: WATCHDOG_MESSAGE,
      branch: 'main',
      scope: {},
      expectedFiles: [
        { path: 'docs/a.md', sourceHash: 'h1', title: 'A', bytes: 100, kind: 'markdown' },
        { path: 'docs/b.md', sourceHash: 'h2', title: 'B', bytes: 100, kind: 'markdown' },
      ],
      completedAt: stoppedAt,
      updatedAt: stoppedAt,
    }]);
    const profiles = makeMockCollection([{
      profileId: 'stopped-profile-1',
      repoId: FIX_H_REPO_ID,
      status: 'stopped',
      latest: false,
      executionId: 'stopped-exec-1',
      message: WATCHDOG_MESSAGE,
      completedAt: stoppedAt,
      createdAt: stoppedAt,
      updatedAt: stoppedAt,
    }]);
    const repos = makeMockCollection([{ _id: REPO_OBJECT_ID, name: 'test-repo', path: '/tmp/repo' }]);
    const db = makeMockDb({
      repos,
      repo_context_curation_runs: runs,
      repo_context_curation_profiles: profiles,
      repo_context_curation_entries: makeMockCollection(),
      executions: makeMockCollection(),
    });
    return { db, runs, profiles };
  }

  beforeEach(() => {
    mockInventory.candidates = [
      { path: 'docs/a.md', title: 'A', sourceHash: 'h1', bytes: 100, kind: 'markdown' as const },
      { path: 'docs/b.md', title: 'B', sourceHash: 'h2', bytes: 100, kind: 'markdown' as const },
    ];
    vi.mocked(createRepoContextCurationRun).mockClear();
    vi.mocked(gitModule.collectDefaultBranchContextFiles).mockClear();
  });

  it('stopped run for the same repo → reactivates run + profile and reuses the run_id', async () => {
    const retryFiles = [{ path: 'docs/b.md', sourceHash: 'h2', title: 'B', bytes: 100, kind: 'markdown' }];
    vi.mocked(getRepoContextCurationStageStatus).mockResolvedValueOnce(stageStatusWithRetryFiles('stopped-run-1', retryFiles));

    const { db, runs, profiles } = makeStoppedFixture();
    const svc = new RepoContextCurationService(db);

    const result = await svc.prepareForCoordinator({
      repo_id: FIX_H_REPO_ID,
      run_id: 'stopped-run-1',
      skip_execution_record: true,
    });

    // Reuses the same run/profile rather than starting a new one
    expect(result.run_id).toBe('stopped-run-1');
    expect(result.profile_id).toBe('stopped-profile-1');
    expect(vi.mocked(createRepoContextCurationRun)).not.toHaveBeenCalled();

    // Run flipped back to running with completedAt and the watchdog message cleared
    const runDoc = runs._store[0];
    expect(runDoc.status).toBe('running');
    expect(runDoc.completedAt).toBeUndefined();
    expect(runDoc.message).toBeUndefined();
    expect(runDoc.updatedAt).toBeInstanceOf(Date);

    // Profile flipped back to running with completedAt cleared; the watchdog message is
    // overwritten by the existing "Context curation resuming" update in the reuse path
    const profileDoc = profiles._store[0];
    expect(profileDoc.status).toBe('running');
    expect(profileDoc.completedAt).toBeUndefined();
    expect(String(profileDoc.message)).toContain('Context curation resuming: 1 file');

    // Diagnostics include both the reuse and the reactivation codes
    const diagnostics = result.diagnostics as Array<Record<string, unknown>>;
    expect(diagnostics.some((d) => d.code === 'curation_run_reused')).toBe(true);
    const reactivatedDiag = diagnostics.find((d) => d.code === 'curation_run_reactivated');
    expect(reactivatedDiag).toBeDefined();
    expect(reactivatedDiag?.severity).toBe('info');
    expect(String(reactivatedDiag?.message)).toContain('stopped-run-1');
    expect(String(reactivatedDiag?.message)).toContain('1 file(s) still pending');

    // Pending files come from retryFiles, not expectedFiles
    expect(result.files_to_curate_count).toBe(1);
    expect((result.files_to_curate_preview as Array<Record<string, unknown>>)[0].path).toBe('docs/b.md');
  });

  it('stopped run with a stale snapshot still reactivates (no fresh run created)', async () => {
    vi.mocked(gitModule.collectDefaultBranchContextFiles).mockResolvedValueOnce({
      branch: 'main',
      ref: 'HEAD',
      headSha: 'newer-head-sha',
      fetchOk: false,
      candidates: mockInventory.candidates,
      diagnostics: [],
    });
    const retryFiles = [{ path: 'docs/a.md', sourceHash: 'h1', title: 'A', bytes: 100, kind: 'markdown' }];
    vi.mocked(getRepoContextCurationStageStatus).mockResolvedValueOnce(stageStatusWithRetryFiles('stopped-run-1', retryFiles));

    const { db, runs } = makeStoppedFixture();
    const svc = new RepoContextCurationService(db);

    const result = await svc.prepareForCoordinator({
      repo_id: FIX_H_REPO_ID,
      run_id: 'stopped-run-1',
      skip_execution_record: true,
    });

    // A stale snapshot must NOT force a fresh run — reactivate regardless
    expect(result.run_id).toBe('stopped-run-1');
    expect(vi.mocked(createRepoContextCurationRun)).not.toHaveBeenCalled();
    expect(runs._store[0].status).toBe('running');

    const diagnostics = result.diagnostics as Array<Record<string, unknown>>;
    expect(diagnostics.some((d) => d.code === 'curation_run_reactivated')).toBe(true);
    expect(diagnostics.some((d) => d.code === 'inventory_snapshot_stale')).toBe(true);
    expect((result.snapshot as Record<string, unknown>).fresh).toBe(false);
  });
});
