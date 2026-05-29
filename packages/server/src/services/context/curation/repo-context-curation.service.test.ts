import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockInventory = vi.hoisted(() => ({
  candidates: [] as Array<{ path: string; title: string; sourceHash: string; bytes: number; kind: 'markdown' }>,
}));

vi.mock('./repo-context-curation-git.js', () => ({
  collectDefaultBranchContextFiles: vi.fn(async (_repoPath: string, branch: string) => ({
    branch,
    ref: `origin/${branch}`,
    headSha: 'head-sha',
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
}));

vi.mock('../common/context-role-inventory.js', () => ({
  buildWorkflowRoleInventory: vi.fn(async () => []),
  buildSpawnedAgentRoleInventory: vi.fn(async () => []),
}));

import { RepoContextCurationService } from './repo-context-curation.service.js';
import {
  buildRepoContextCuratorSystemPrompt,
  buildRepoContextCuratorWorkerSystemPrompt,
  buildRepoContextCuratorWorkerUserPrompt,
} from './repo-context-curator-prompts.js';
import {
  buildRepoContextCurationAssignmentPlan,
  validateStageEntry,
} from './repo-context-curation-runner.js';
import * as gitModule from './repo-context-curation-git.js';

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

  it('instructs workers to keep production learnings and omit agent persona instructions', () => {
    const coordinatorPrompt = buildRepoContextCuratorSystemPrompt();
    const workerPrompt = buildRepoContextCuratorWorkerSystemPrompt();

    expect(coordinatorPrompt).toContain('Treat agent-adjacent files such as .claude/agents/** and .agents/** as mixed-source files');
    expect(coordinatorPrompt).toContain('Memory/learnings entries should use production categories');
    expect(workerPrompt).toContain('stage only the production-learning chunks');
    expect(workerPrompt).toContain('omit persona/system sections from curatedContext, retrievalText, and chunks');
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
      curatedContext: 'You are the backend developer subagent. Use allowed tools and delegate when needed.',
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
