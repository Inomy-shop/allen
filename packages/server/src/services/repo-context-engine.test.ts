import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GraphKeywordMetadataProvider,
  MandatoryGraphProvider,
  RepoContextEngine,
  type KnowledgeCandidateRef,
  type KnowledgeNodeLike,
} from './repo-context-engine.js';
import { summarizeInjection, WorkflowContextInjectionAdapter } from './workflow-context-injection-adapter.js';
import { createConfiguredContextReranker, type ContextRerankInput, type ContextRerankResult, type ContextReranker } from './repo-context-reranker.js';
import { CogneeMemoryProvider, runCogneeSidecar } from './repo-context-cognee-provider.js';

const originalContextProvider = process.env.ALLEN_CONTEXT_PROVIDER;

beforeEach(() => {
  process.env.ALLEN_CONTEXT_PROVIDER = 'cognee';
});

afterEach(() => {
  if (originalContextProvider === undefined) delete process.env.ALLEN_CONTEXT_PROVIDER;
  else process.env.ALLEN_CONTEXT_PROVIDER = originalContextProvider;
});

describe('RepoContextEngine', () => {
  const nodes: KnowledgeNodeLike[] = [
    node('repo:root', 'repo', 'Repo', undefined, 'root repo summary', [], 'baseline'),
    node('repo:agents', 'instruction_file', 'Root AGENTS', 'AGENTS.md', 'root coding rules', ['rules'], 'baseline'),
    node('repo:prod', 'production_note', 'Payments Production Rules', 'docs/payments.md', 'payment refund idempotency', ['payments'], 'on_demand', ['backend-developer']),
    node('repo:dup-prod', 'production_note', 'Duplicate Payments Rules', 'docs/payments.md', 'duplicate payment ref', ['payments'], 'on_demand', ['backend-developer']),
    node('repo:skill', 'skill', 'Payments Skill', '.claude/skills/payments/SKILL.md', 'payment reconciliation skill', ['payments'], 'on_demand'),
  ];

  it('composes mandatory refs before optional refs and dedupes repeated paths', async () => {
    const packet = await graphEngine().buildPacket({
      packetId: 'packet-1',
      executionId: 'exec-1',
      repoId: 'repo',
      repoName: 'fixture',
      repoPath: '/tmp/fixture',
      indexId: 'index-1',
      indexFreshness: 'fresh',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'implement',
      nodeRole: 'backend-developer',
      attempt: 1,
      state: {},
      prompt: 'Fix payment refund idempotency',
      provider: 'claude',
      currentFiles: [],
      nodes,
    });

    expect(packet.retrievalProviders).toEqual(['mandatory_graph', 'graph_keyword_metadata', 'deterministic_policy_reranker']);
    expect(packet.selectedRefs[0]).toEqual(expect.objectContaining({ providerId: 'mandatory_graph', mandatory: true }));
    expect(packet.selectedRefs.map((ref) => ref.refId)).toContain('repo:prod');
    expect(packet.selectedRefs.map((ref) => ref.refId)).not.toContain('repo:dup-prod');
    expect(packet.rejectedRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ refId: 'repo:dup-prod' }),
    ]));
    expect(packet.providerTraces).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerId: 'mandatory_graph', decision: 'selected' }),
    ]));
  });

  it('searches through the same provider scoring path', () => {
    const refs = graphEngine().search({
      repoId: 'repo',
      repoName: 'fixture',
      repoPath: '/tmp/fixture',
      indexId: 'index-1',
      indexFreshness: 'fresh',
      workflowName: 'search_repo_knowledge',
      nodeName: 'search',
      nodeRole: 'backend-developer',
      attempt: 1,
      state: {},
      provider: 'unknown',
      currentFiles: [],
      nodes,
      query: 'payment reconciliation',
      limit: 3,
    });

    expect(refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ refId: 'repo:skill', source: 'search_repo_knowledge', loadable: true }),
    ]));
  });

  it('keeps mandatory refs protected while allowing optional semantic reranking', async () => {
    const packet = await new RepoContextEngine(
      [new MandatoryGraphProvider(), new GraphKeywordMetadataProvider()],
      new TestSemanticReranker(),
    ).buildPacket({
      packetId: 'packet-rerank',
      executionId: 'exec-rerank',
      repoId: 'repo',
      repoName: 'fixture',
      repoPath: '/tmp/fixture',
      indexId: 'index-1',
      indexFreshness: 'fresh',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'implement',
      nodeRole: 'backend-developer',
      attempt: 1,
      state: {},
      prompt: 'Fix payment refund idempotency',
      provider: 'claude',
      currentFiles: [],
      nodes,
    });

    expect(packet.selectedRefs[0]).toEqual(expect.objectContaining({ mandatory: true }));
    const optionalRefs = packet.selectedRefs.filter((ref) => !ref.mandatory);
    expect(optionalRefs[0]).toEqual(expect.objectContaining({ refId: 'repo:skill' }));
    expect(packet.rerankerProviders).toEqual(['test_semantic_reranker']);
    expect(packet.rerankerTraces).toEqual(expect.arrayContaining([
      expect.objectContaining({ refId: 'repo:skill', providerId: 'test_semantic_reranker' }),
    ]));
  });
});

describe('WorkflowContextInjectionAdapter', () => {
  let repoPath: string | undefined;

  afterEach(() => {
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
    repoPath = undefined;
  });

  it('injects tracked mandatory files and audits provider-native refs', async () => {
    repoPath = mkdtempSync(join(tmpdir(), 'allen-context-adapter-'));
    mkdirSync(join(repoPath, 'docs'), { recursive: true });
    writeFileSync(join(repoPath, 'AGENTS.md'), 'Loaded by Codex natively.\n');
    writeFileSync(join(repoPath, 'docs/rules.md'), 'Always keep payment writes idempotent.\n');
    execFileSync('git', ['init'], { cwd: repoPath });
    execFileSync('git', ['add', '.'], { cwd: repoPath });

    const adapter = new WorkflowContextInjectionAdapter();
    const packet = await graphEngine().buildPacket({
      packetId: 'packet-1',
      executionId: 'exec-1',
      repoId: 'repo',
      repoName: 'fixture',
      repoPath,
      indexId: 'index-1',
      indexFreshness: 'fresh',
      workflowName: 'workflow',
      nodeName: 'implement',
      nodeRole: 'backend-developer',
      attempt: 1,
      state: { repo_path: repoPath },
      prompt: 'Fix payment writes',
      provider: 'codex',
      currentFiles: [],
      nodes: [
        node('repo:agents', 'instruction_file', 'Root AGENTS', 'AGENTS.md', 'root coding rules', ['rules'], 'baseline'),
        node('repo:rules', 'context_file', 'Payment Rules', 'docs/rules.md', 'payment write rules', ['payments'], 'on_demand', ['backend-developer']),
      ],
    });
    const injection = await adapter.buildInjection({ packet, provider: 'codex', repoPath });

    expect(injection.injectedRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ refId: 'repo:rules', source: 'allen_system_injection' }),
    ]));
    expect(injection.providerNativeRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ refId: 'repo:agents', skipReason: 'provider_native' }),
    ]));
    expect(adapter.renderSystemPromptBlock(injection)).toContain('Always keep payment writes idempotent.');
  });

  it('injects provider-text context and keeps the full text in the audit summary', async () => {
    const adapter = new WorkflowContextInjectionAdapter();
    const packet = {
      packetId: 'packet-provider-text',
      executionId: 'exec-provider-text',
      repoId: 'repo',
      repoName: 'fixture',
      repoPath: '/tmp/fixture',
      indexId: 'index-1',
      indexFreshness: 'fresh',
      workflowName: 'workflow',
      nodeName: 'implement',
      nodeRole: 'backend-developer',
      attempt: 1,
      state: {},
      prompt: 'Fix payment refund idempotency',
      provider: 'claude',
      currentFiles: [],
      selectedRefs: [{
        refId: 'cognee:memory:1',
        kind: 'historical_learning' as const,
        title: 'Cognee refund memory',
        summary: 'Refund idempotency recall',
        providerId: 'cognee_memory',
        source: 'cognee_recall',
        reason: 'Cognee recalled this provider text for the task.',
        loadable: true,
        mandatory: false,
        itemType: 'provider_text' as const,
        grounding: 'provider_text' as const,
        content: 'Refund retry handlers must check idempotency keys before writing a second ledger entry.',
      }],
      rejectedRefs: [],
      availableRefs: [],
      providerTraces: [],
      providerDiagnostics: [],
      rerankerTraces: [],
      rerankerDiagnostics: [],
      rerankerProviders: [],
      retrievalProviders: ['cognee_memory'],
      createdAt: new Date(),
    };

    const injection = await adapter.buildInjection({ packet, provider: 'claude', repoPath: '/tmp/fixture' });
    const summary = summarizeInjection(injection);

    expect(injection.injectedRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ refId: 'cognee:memory:1', itemType: 'provider_text', source: 'allen_system_injection' }),
    ]));
    expect(adapter.renderSystemPromptBlock(injection)).toContain('Refund retry handlers must check idempotency keys');
    expect(summary.injectedRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ refId: 'cognee:memory:1', content: expect.stringContaining('idempotency keys') }),
    ]));
  });

  it('section-extracts large narrative mandatory docs before dropping them', async () => {
    repoPath = mkdtempSync(join(tmpdir(), 'allen-context-adapter-'));
    mkdirSync(join(repoPath, 'docs'), { recursive: true });
    writeFileSync(join(repoPath, 'docs/large-runbook.md'), `# Noise\n${'noise\n'.repeat(20_000)}\n# Payment Incident Recovery\nAlways verify refund idempotency before retrying writes.\n`);
    execFileSync('git', ['init'], { cwd: repoPath });
    execFileSync('git', ['add', '.'], { cwd: repoPath });

    const adapter = new WorkflowContextInjectionAdapter();
    const packet = await graphEngine().buildPacket({
      packetId: 'packet-large-doc',
      executionId: 'exec-large-doc',
      repoId: 'repo',
      repoName: 'fixture',
      repoPath,
      indexId: 'index-1',
      indexFreshness: 'fresh',
      workflowName: 'workflow',
      nodeName: 'implement',
      nodeRole: 'backend-developer',
      attempt: 1,
      state: { repo_path: repoPath },
      prompt: 'Fix payment refund idempotency',
      provider: 'claude',
      currentFiles: [],
      nodes: [
        node('repo:runbook', 'doc', 'Large Payment Runbook', 'docs/large-runbook.md', 'payment incident recovery idempotency', ['payments'], 'on_demand', ['backend-developer']),
      ],
    });
    const injection = await adapter.buildInjection({ packet, provider: 'claude', repoPath });

    expect(injection.injectedRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        refId: 'repo:runbook',
        packingTransformation: 'section_extracted',
        riskClass: 'narrative',
      }),
    ]));
    expect(adapter.renderSystemPromptBlock(injection)).toContain('Always verify refund idempotency');
  });

  it('uses env-configured injection budgets', async () => {
    const previousMaxFile = process.env.ALLEN_CONTEXT_MAX_FILE_CHARS;
    const previousMaxTotal = process.env.ALLEN_CONTEXT_MAX_TOTAL_CHARS;
    const previousMaxRefs = process.env.ALLEN_CONTEXT_MAX_INJECTED_REFS;
    process.env.ALLEN_CONTEXT_MAX_FILE_CHARS = '2000';
    process.env.ALLEN_CONTEXT_MAX_TOTAL_CHARS = '3000';
    process.env.ALLEN_CONTEXT_MAX_INJECTED_REFS = '1';
    try {
      const adapter = new WorkflowContextInjectionAdapter();
      const packet = {
        packetId: 'packet-env-limits',
        executionId: 'exec-env-limits',
        repoId: 'repo',
        repoName: 'fixture',
        repoPath: '/tmp/fixture',
        indexId: 'index-1',
        indexFreshness: 'fresh',
        workflowName: 'workflow',
        nodeName: 'implement',
        nodeRole: 'backend-developer',
        attempt: 1,
        state: {},
        prompt: 'Fix payment refund idempotency',
        provider: 'claude',
        currentFiles: [],
        selectedRefs: [{
          refId: 'provider-doc',
          kind: 'doc' as const,
          title: 'Provider doc',
          providerId: 'cognee_memory',
          source: 'cognee_recall',
          reason: 'Relevant provider text.',
          loadable: true,
          mandatory: false,
          itemType: 'provider_generated' as const,
          grounding: 'provider_generated' as const,
          content: 'Provider supplied context.',
        }],
        rejectedRefs: [],
        availableRefs: [],
        providerTraces: [],
        providerDiagnostics: [],
        rerankerTraces: [],
        rerankerDiagnostics: [],
        rerankerProviders: [],
        retrievalProviders: ['cognee_memory'],
        createdAt: new Date(),
      };

      const injection = await adapter.buildInjection({ packet, provider: 'claude', repoPath: '/tmp/fixture' });

      expect(injection.maxFileChars).toBe(2000);
      expect(injection.maxTotalChars).toBe(3000);
      expect(injection.maxInjectedRefs).toBe(1);
    } finally {
      if (previousMaxFile === undefined) delete process.env.ALLEN_CONTEXT_MAX_FILE_CHARS;
      else process.env.ALLEN_CONTEXT_MAX_FILE_CHARS = previousMaxFile;
      if (previousMaxTotal === undefined) delete process.env.ALLEN_CONTEXT_MAX_TOTAL_CHARS;
      else process.env.ALLEN_CONTEXT_MAX_TOTAL_CHARS = previousMaxTotal;
      if (previousMaxRefs === undefined) delete process.env.ALLEN_CONTEXT_MAX_INJECTED_REFS;
      else process.env.ALLEN_CONTEXT_MAX_INJECTED_REFS = previousMaxRefs;
    }
  });
});

describe('CogneeMemoryProvider', () => {
  let scriptPath: string | undefined;
  let scriptDir: string | undefined;
  let previousScript: string | undefined;
  let previousPythonPath: string | undefined;
  let previousLlmProvider: string | undefined;
  let previousHome: string | undefined;
  let previousFakeEnvOut: string | undefined;

  afterEach(() => {
    if (scriptDir) rmSync(scriptDir, { recursive: true, force: true });
    scriptPath = undefined;
    scriptDir = undefined;
    if (previousScript === undefined) delete process.env.ALLEN_COGNEE_SIDECAR_SCRIPT;
    else process.env.ALLEN_COGNEE_SIDECAR_SCRIPT = previousScript;
    if (previousPythonPath === undefined) delete process.env.PYTHONPATH;
    else process.env.PYTHONPATH = previousPythonPath;
    if (previousLlmProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = previousLlmProvider;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousFakeEnvOut === undefined) delete process.env.ALLEN_FAKE_COGNEE_ENV_OUT;
    else process.env.ALLEN_FAKE_COGNEE_ENV_OUT = previousFakeEnvOut;
    previousPythonPath = undefined;
    previousLlmProvider = undefined;
    previousHome = undefined;
    previousFakeEnvOut = undefined;
  });

  it('configures Cognee env from Allen payload before importing Cognee', async () => {
    previousScript = process.env.ALLEN_COGNEE_SIDECAR_SCRIPT;
    previousPythonPath = process.env.PYTHONPATH;
    previousLlmProvider = process.env.LLM_PROVIDER;
    previousHome = process.env.HOME;
    previousFakeEnvOut = process.env.ALLEN_FAKE_COGNEE_ENV_OUT;
    scriptDir = mkdtempSync(join(tmpdir(), 'allen-cognee-import-env-'));
    const fakeModuleDir = join(scriptDir, 'fake-python');
    const homeDir = join(scriptDir, 'home');
    mkdirSync(fakeModuleDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    const envOut = join(scriptDir, 'env.json');
    writeFileSync(join(fakeModuleDir, 'cognee.py'), `
import json
import os

with open(os.environ["ALLEN_FAKE_COGNEE_ENV_OUT"], "w") as file:
    json.dump({
        "dataRoot": os.environ.get("COGNEE_DATA_ROOT_DIRECTORY"),
        "dataRootDirectory": os.environ.get("DATA_ROOT_DIRECTORY"),
        "systemRoot": os.environ.get("COGNEE_SYSTEM_ROOT_DIRECTORY"),
        "systemRootDirectory": os.environ.get("SYSTEM_ROOT_DIRECTORY"),
        "cacheRootDirectory": os.environ.get("CACHE_ROOT_DIRECTORY"),
        "embeddingProvider": os.environ.get("EMBEDDING_PROVIDER"),
        "embeddingModel": os.environ.get("EMBEDDING_MODEL"),
        "llmProvider": os.environ.get("LLM_PROVIDER"),
        "llmModel": os.environ.get("LLM_MODEL"),
        "llmEndpoint": os.environ.get("LLM_ENDPOINT"),
        "llmApiKey": os.environ.get("LLM_API_KEY"),
    }, file)

class SearchType:
    CHUNKS = "CHUNKS"

class config:
    @staticmethod
    def data_root_directory(value):
        os.environ["FAKE_COGNEE_RUNTIME_DATA_ROOT"] = value

    @staticmethod
    def system_root_directory(value):
        os.environ["FAKE_COGNEE_RUNTIME_SYSTEM_ROOT"] = value

class datasets:
    @staticmethod
    async def list_datasets():
        return []

async def add(data, dataset_name=None):
    return None

async def cognify(datasets=None):
    return None

async def search(query_text=None, query_type=None, datasets=None):
    return []
`);
    process.env.PYTHONPATH = fakeModuleDir;
    process.env.HOME = homeDir;
    process.env.LLM_PROVIDER = 'openai';
    process.env.ALLEN_FAKE_COGNEE_ENV_OUT = envOut;

    const output = await runCogneeSidecar('ingest', {
      dataDir: '$HOME/.allen/cognee',
      datasetName: 'allen-fixture',
      documents: [{ title: 'Rules', path: 'AGENTS.md', kind: 'doc', content: '# Rules' }],
      llmUrl: 'http://127.0.0.1:4023/api/internal/context-evaluation/cognee-llm/v1',
      llmSecret: 'test-secret',
    });

    const importedEnv = JSON.parse(readFileSync(envOut, 'utf8'));
    const expectedStorageRoot = realpathSync(join(homeDir, '.allen', 'cognee'));
    const expectedSystemRoot = join(expectedStorageRoot, 'system');
    expect(output.status).toBe('completed');
    expect(output.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'cognee_storage_configured',
        storageRoot: expectedStorageRoot,
        databasePath: join(expectedSystemRoot, 'databases'),
      }),
    ]));
    expect(importedEnv).toEqual(expect.objectContaining({
      dataRoot: expectedStorageRoot,
      dataRootDirectory: expectedStorageRoot,
      systemRoot: expectedSystemRoot,
      systemRootDirectory: expectedSystemRoot,
      cacheRootDirectory: join(expectedStorageRoot, 'cache'),
      embeddingProvider: 'fastembed',
      embeddingModel: 'BAAI/bge-small-en-v1.5',
      llmProvider: 'custom',
      llmModel: 'gpt-5.5',
      llmEndpoint: 'http://127.0.0.1:4023/api/internal/context-evaluation/cognee-llm/v1',
      llmApiKey: 'test-secret',
    }));
  });

  it('passes full Markdown files to Cognee DataItem with external metadata', async () => {
    previousScript = process.env.ALLEN_COGNEE_SIDECAR_SCRIPT;
    previousPythonPath = process.env.PYTHONPATH;
    previousHome = process.env.HOME;
    previousFakeEnvOut = process.env.ALLEN_FAKE_COGNEE_ENV_OUT;
    scriptDir = mkdtempSync(join(tmpdir(), 'allen-cognee-dataitem-'));
    const fakeModuleDir = join(scriptDir, 'fake-python');
    const cogneeDir = join(fakeModuleDir, 'cognee');
    const ingestionDir = join(cogneeDir, 'tasks', 'ingestion');
    const homeDir = join(scriptDir, 'home');
    mkdirSync(ingestionDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    const addOut = join(scriptDir, 'added.json');
    writeFileSync(join(cogneeDir, '__init__.py'), `
import json
import os

class SearchType:
    CHUNKS = "CHUNKS"

class Config:
    def data_root_directory(self, value):
        self.data_root = value
    def system_root_directory(self, value):
        self.system_root = value

config = Config()

class datasets:
    @staticmethod
    async def list_datasets():
        return []

async def add(data, dataset_name=None):
    path = os.environ["ALLEN_FAKE_COGNEE_ENV_OUT"]
    try:
        with open(path) as fh:
            rows = json.load(fh)
    except Exception:
        rows = []
    rows.append({
        "datasetName": dataset_name,
        "data": data.data,
        "label": data.label,
        "externalMetadata": data.external_metadata,
        "dataId": str(data.data_id),
    })
    with open(path, "w") as fh:
        json.dump(rows, fh)

async def cognify(**kwargs):
    return None
`);
    writeFileSync(join(cogneeDir, 'tasks', '__init__.py'), '');
    writeFileSync(join(ingestionDir, '__init__.py'), '');
    writeFileSync(join(ingestionDir, 'data_item.py'), `
class DataItem:
    def __init__(self, data, label=None, external_metadata=None, data_id=None):
        self.data = data
        self.label = label
        self.external_metadata = external_metadata
        self.data_id = data_id
`);
    process.env.PYTHONPATH = fakeModuleDir;
    process.env.HOME = homeDir;
    process.env.ALLEN_FAKE_COGNEE_ENV_OUT = addOut;
    process.env.ALLEN_COGNEE_SIDECAR_SCRIPT = join(process.cwd(), 'src/scripts/cognee-context-provider.py');

    const output = await runCogneeSidecar('ingest', {
      dataDir: '$HOME/.allen/cognee',
      datasetName: 'allen-fixture-docmeta-v1',
      ingestFormat: 'markdown_file_docmeta_v1',
      repo: { repoId: 'repo-id', repoName: 'fixture', branch: 'main', headSha: 'abc123' },
      documents: [{
        title: 'Vendor Guidelines',
        path: 'docs/vendor-guidelines.md',
        kind: 'doc',
        content: '# Vendor Guidelines\n\nUse live mappings.',
        hash: 'doc-hash',
        dataId: '945f60a2-1e87-5d3c-bb88-f8d2f46b7c4a',
        externalMetadata: { ignored: true },
      }],
    });

    const added = JSON.parse(readFileSync(addOut, 'utf8'));
    expect(output.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'cognee_data_item_unavailable' }),
    ]));
    expect(added).toEqual([
      expect.objectContaining({
        datasetName: 'allen-fixture-docmeta-v1',
        data: '# Vendor Guidelines\n\nUse live mappings.',
        label: 'docs/vendor-guidelines.md',
        dataId: '945f60a2-1e87-5d3c-bb88-f8d2f46b7c4a',
        externalMetadata: expect.objectContaining({
          repoId: 'repo-id',
          repoName: 'fixture',
          path: 'docs/vendor-guidelines.md',
          title: 'Vendor Guidelines',
          kind: 'doc',
          fileHash: 'doc-hash',
          ingestFormat: 'markdown_file_docmeta_v1',
        }),
      }),
    ]);
    expect(added[0].externalMetadata).not.toHaveProperty('repoPath');
    expect(added[0].externalMetadata).not.toHaveProperty('sourcePath');
  });

  it('diffs current Markdown against Cognee-owned metadata by path and content hash', () => {
    const output = execFileSync('python3', ['-c', `
import importlib.util
import json
from pathlib import Path

script = Path("src/scripts/cognee-context-provider.py")
spec = importlib.util.spec_from_file_location("allen_cognee_context_provider", script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

diff = module.cognee_database_diff(
    [
        {"path": "docs/current.md", "title": "Current", "hash": "h1", "content": "same"},
        {"path": "docs/retry.md", "title": "Retry", "hash": "h2", "content": "same but uncognified"},
        {"path": "docs/changed.md", "title": "Changed", "hash": "h3", "content": "new"},
        {"path": "docs/added.md", "title": "Added", "hash": "h4", "content": "new"},
    ],
    [
        {"path": "docs/current.md", "title": "Current", "fileHash": "h1", "dataId": "data-current", "status": "DATA_ITEM_PROCESSING_COMPLETED"},
        {"path": "docs/retry.md", "title": "Retry", "fileHash": "h2", "dataId": "data-retry", "status": "DATA_ITEM_PROCESSING_FAILED"},
        {"path": "docs/changed.md", "title": "Changed", "fileHash": "old", "dataId": "data-changed", "status": "DATA_ITEM_PROCESSING_COMPLETED"},
        {"path": "docs/deleted.md", "title": "Deleted", "fileHash": "h5", "dataId": "data-deleted", "status": "DATA_ITEM_PROCESSING_COMPLETED"},
    ],
)
print(json.dumps(diff, sort_keys=True))
`], { cwd: process.cwd() });
    const diff = JSON.parse(output.toString());

    expect(diff).toEqual(expect.objectContaining({
      addedDocumentCount: 1,
      changedDocumentCount: 1,
      deletedDocumentCount: 1,
      unchangedDocumentCount: 2,
      uncognifiedRetryCount: 1,
    }));
    expect(diff.documents).toEqual([
      expect.objectContaining({ path: 'docs/changed.md', changeType: 'changed' }),
      expect.objectContaining({ path: 'docs/added.md', changeType: 'added' }),
    ]);
    expect(diff.deletedDocuments).toEqual([
      expect.objectContaining({ path: 'docs/deleted.md', dataId: 'data-deleted' }),
    ]);
  });

  it('normalizes Cognee file and provider-text recall into context refs', async () => {
    previousScript = process.env.ALLEN_COGNEE_SIDECAR_SCRIPT;
    scriptDir = mkdtempSync(join(tmpdir(), 'allen-cognee-sidecar-'));
    scriptPath = join(scriptDir, 'fake-cognee.py');
    writeFileSync(scriptPath, `#!/usr/bin/env python3
import json
import sys
payload = json.load(sys.stdin)
print(json.dumps({
  "diagnostics": [{"code": "fake_cognee", "severity": "info"}],
  "results": [
    {"refId": "file-ref", "title": "Repo chunk", "kind": "doc", "path": "docs/rules.md", "content": "Use repo-backed rules.", "score": 0.9, "datasetName": payload.get("datasetName")},
    {"refId": "text-ref", "title": "Generated memory", "kind": "historical_learning", "content": "A previous workflow found refund retries need idempotency.", "itemType": "provider_text", "grounding": "provider_text", "score": 0.8}
  ]
}))
`);
    process.env.ALLEN_COGNEE_SIDECAR_SCRIPT = scriptPath;

    const result = await new CogneeMemoryProvider().retrieve({
      repoId: 'repo-id',
      repoName: 'fixture',
      repoPath: '/tmp/fixture',
      indexId: 'index-1',
      indexFreshness: 'fresh',
      workflowName: 'workflow',
      nodeName: 'implement',
      nodeRole: 'backend-developer',
      attempt: 1,
      state: {},
      prompt: 'Fix refund idempotency',
      provider: 'claude',
      currentFiles: [],
      nodes: [],
    });

    expect(result.selectedRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ refId: 'file-ref', itemType: 'repo_chunk', grounding: 'repo_backed', path: 'docs/rules.md' }),
      expect.objectContaining({ refId: 'text-ref', itemType: 'provider_text', grounding: 'provider_text', contentSha256: expect.any(String) }),
    ]));
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'fake_cognee' }),
    ]));
  });

  it('uses Cognee chunk ids and external document metadata returned by search', async () => {
    previousScript = process.env.ALLEN_COGNEE_SIDECAR_SCRIPT;
    scriptDir = mkdtempSync(join(tmpdir(), 'allen-cognee-sidecar-docmeta-'));
    scriptPath = join(scriptDir, 'fake-cognee-docmeta.py');
    writeFileSync(scriptPath, `#!/usr/bin/env python3
import json
import sys
payload = json.load(sys.stdin)
print(json.dumps({
  "diagnostics": [{"code": "fake_cognee", "severity": "info"}],
  "results": [
    {
      "id": "chunk-1",
      "content": "Use live vendor mappings.",
      "path": "/var/lib/cognee/raw/absolute-storage-copy.md",
      "chunkIndex": 0,
      "chunkSize": 4,
      "cutType": "paragraph_end",
      "externalMetadata": {
        "repoId": "repo-id",
        "path": "docs/vendor-guidelines.md",
        "title": "Vendor Guidelines",
        "kind": "doc",
        "fileHash": "doc-hash",
        "ingestFormat": "markdown_file_docmeta_v1"
      },
      "score": 0.9,
      "datasetName": payload.get("datasetName")
    }
  ]
}))
`);
    process.env.ALLEN_COGNEE_SIDECAR_SCRIPT = scriptPath;
    const fakeDb = {
      collection: () => ({
        findOne: async () => ({
          datasetName: 'allen-fixture-repo-id-docmeta-v1',
          ingestFormat: 'markdown_file_docmeta_v1',
        }),
      }),
    };

    const result = await new CogneeMemoryProvider(fakeDb as any).retrieve({
      repoId: 'repo-id',
      repoName: 'fixture',
      repoPath: '/tmp/fixture',
      indexId: 'index-1',
      indexFreshness: 'fresh',
      workflowName: 'workflow',
      nodeName: 'implement',
      nodeRole: 'backend-developer',
      attempt: 1,
      state: {},
      prompt: 'Fix vendor mappings',
      provider: 'claude',
      currentFiles: [],
      nodes: [],
    });

    expect(result.selectedRefs[0]).toEqual(expect.objectContaining({
      refId: 'cognee:chunk-1',
      title: 'Vendor Guidelines',
      path: 'docs/vendor-guidelines.md',
      kind: 'doc',
      itemType: 'repo_chunk',
      grounding: 'repo_backed',
      content: 'Use live vendor mappings.',
      providerMetadata: expect.objectContaining({
        chunkId: 'chunk-1',
        cogneeChunkId: 'chunk-1',
        chunkIndex: 0,
        chunkSize: 4,
        cutType: 'paragraph_end',
        sourceMetadata: expect.objectContaining({
          path: 'docs/vendor-guidelines.md',
          fileHash: 'doc-hash',
        }),
      }),
    }));
    expect(result.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'cognee_manifest_missing' }),
    ]));
  });

  it('keeps Cognee metadata in injection summaries while stripping repo-backed content', () => {
    const summary = summarizeInjection({
      injectionId: 'injection-1',
      graphVersion: 'index-1',
      provider: 'claude',
      targetLayer: 'system_prompt',
      maxFileChars: 60_000,
      maxTotalChars: 180_000,
      maxInjectedRefs: 12,
      totalChars: 25,
      consideredRefs: [],
      injectedRefs: [{
        refId: 'cognee:chunk-1',
        kind: 'doc',
        title: 'Vendor Guidelines',
        path: 'docs/vendor-guidelines.md',
        providerId: 'cognee_memory',
        source: 'allen_system_injection',
        reason: 'Relevant Cognee chunk.',
        loadable: true,
        mandatory: false,
        itemType: 'repo_chunk',
        grounding: 'repo_backed',
        content: 'Use live vendor mappings.',
        contentSha256: 'content-hash',
        providerMetadata: {
          chunkId: 'chunk-1',
          cogneeChunkId: 'chunk-1',
          chunkIndex: 0,
          chunkSize: 4,
          cutType: 'paragraph_end',
          documentRole: 'guideline',
          containsCodeBlocks: false,
          sourceMetadata: {
            repoId: 'repo-id',
            path: 'docs/vendor-guidelines.md',
            fileHash: 'doc-hash',
            ingestFormat: 'markdown_file_docmeta_v1',
          },
        },
      }],
      skippedRefs: [],
      providerNativeRefs: [],
      packingDecisions: [],
      packingDiagnostics: [],
      createdAt: new Date(),
    } as any);

    const injected = (summary.injectedRefs as Array<Record<string, unknown>>)[0];
    expect(injected.content).toBeUndefined();
    expect(summary.injectedRefs).toEqual([
      expect.objectContaining({
        refId: 'cognee:chunk-1',
        contentSha256: 'content-hash',
        providerMetadata: expect.objectContaining({
          cogneeChunkId: 'chunk-1',
          sourceMetadata: expect.objectContaining({
            path: 'docs/vendor-guidelines.md',
            fileHash: 'doc-hash',
          }),
        }),
      }),
    ]);
  });

  it('defensively unpacks JSON-envelope content returned by a sidecar', async () => {
    previousScript = process.env.ALLEN_COGNEE_SIDECAR_SCRIPT;
    scriptDir = mkdtempSync(join(tmpdir(), 'allen-cognee-sidecar-envelope-'));
    scriptPath = join(scriptDir, 'fake-cognee-envelope.py');
    writeFileSync(scriptPath, `#!/usr/bin/env python3
import json
import sys
payload = json.load(sys.stdin)
print(json.dumps({
  "diagnostics": [{"code": "fake_cognee", "severity": "info"}],
  "results": [
    {
      "refId": "prd-envelope",
      "title": "Cognee result 1",
      "kind": "historical_learning",
      "content": json.dumps({
        "title": "PRD: Vendor Wizard",
        "path": "docs/prds/vendor-wizard.md",
        "kind": "doc",
        "content": "# PRD: Vendor Wizard\\n\\n\`\`\`ts\\nconst stale = true;\\n\`\`\`"
      }),
      "score": 0.9,
      "datasetName": payload.get("datasetName")
    }
  ]
}))
`);
    process.env.ALLEN_COGNEE_SIDECAR_SCRIPT = scriptPath;

    const result = await new CogneeMemoryProvider().retrieve({
      repoId: 'repo-id',
      repoName: 'fixture',
      repoPath: '/tmp/fixture',
      indexId: 'index-1',
      indexFreshness: 'fresh',
      workflowName: 'workflow',
      nodeName: 'implement',
      nodeRole: 'backend-developer',
      attempt: 1,
      state: {},
      prompt: 'Fix vendor wizard',
      provider: 'claude',
      currentFiles: [],
      nodes: [],
    });

    expect(result.selectedRefs[0]).toEqual(expect.objectContaining({
      refId: 'prd-envelope',
      title: 'PRD: Vendor Wizard',
      path: 'docs/prds/vendor-wizard.md',
      kind: 'doc',
      itemType: 'repo_chunk',
      grounding: 'repo_backed',
      content: '# PRD: Vendor Wizard\n\n```ts\nconst stale = true;\n```',
      providerMetadata: expect.objectContaining({
        documentRole: 'prd',
        containsCodeBlocks: true,
      }),
    }));
  });

  it('caps Cognee sidecar stderr diagnostics instead of accumulating unbounded logs', async () => {
    previousScript = process.env.ALLEN_COGNEE_SIDECAR_SCRIPT;
    scriptDir = mkdtempSync(join(tmpdir(), 'allen-cognee-sidecar-stderr-'));
    scriptPath = join(scriptDir, 'fake-cognee-large-stderr.py');
    writeFileSync(scriptPath, `#!/usr/bin/env python3
import sys

for index in range(700):
    sys.stderr.write(f"large stderr line {index} " + ("x" * 10000) + "\\n")
    sys.stderr.flush()

sys.exit(7)
`);
    process.env.ALLEN_COGNEE_SIDECAR_SCRIPT = scriptPath;

    let error: Error | undefined;
    try {
      await runCogneeSidecar('search', { datasetName: 'allen-fixture', query: 'test' });
    } catch (err) {
      error = err as Error;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('large stderr line');
    expect(error?.message.length).toBeLessThan(300_000);
  });

  it('flattens nested Cognee search_result rows into path-aware chunks', async () => {
    previousScript = process.env.ALLEN_COGNEE_SIDECAR_SCRIPT;
    previousPythonPath = process.env.PYTHONPATH;
    scriptDir = mkdtempSync(join(tmpdir(), 'allen-cognee-nested-'));
    const fakeModuleDir = join(scriptDir, 'fake-python');
    mkdirSync(fakeModuleDir, { recursive: true });
    writeFileSync(join(fakeModuleDir, 'cognee.py'), `
class SearchType:
    CHUNKS = "CHUNKS"

class Config:
    def data_root_directory(self, value):
        self.data_root = value
    def system_root_directory(self, value):
        self.system_root = value

config = Config()

async def search(**kwargs):
    assert kwargs.get("top_k") == 2
    dataset_name = kwargs.get("datasets", ["allen-fixture"])[0]
    return {
        "dataset_id": "dataset-1",
        "dataset_name": dataset_name,
        "search_result": [
            {
                "id": "chunk-prd",
                "text": "{\\"title\\": \\"Vendor PRD\\", \\"path\\": \\"docs/prd/vendor.md\\", \\"kind\\": \\"doc\\", \\"content\\": \\"# Vendor PRD\\\\n\\\\nRequirements only.\\"}",
                "score": 0.7,
            },
            {
                "id": "chunk-runbook",
                "text": "{\\"title\\": \\"Vendor Runbook\\", \\"path\\": \\"docs/runbooks/vendor.md\\", \\"kind\\": \\"runbook\\", \\"content\\": \\"# Vendor Runbook\\\\n\\\\nUse live category mappings.\\"}",
                "score": 0.6,
            },
        ],
    }
`);
    process.env.PYTHONPATH = fakeModuleDir;
    process.env.ALLEN_COGNEE_SIDECAR_SCRIPT = join(process.cwd(), 'src/scripts/cognee-context-provider.py');

    const output = await runCogneeSidecar('search', {
      datasetName: 'allen-fixture',
      dataDir: join(scriptDir, 'cognee'),
      query: 'vendor category mapping',
      limits: { maxResults: 2 },
    });

    expect(output.results).toEqual([
      expect.objectContaining({
        refId: 'chunk-prd',
        title: 'Vendor PRD',
        path: 'docs/prd/vendor.md',
        content: '# Vendor PRD\n\nRequirements only.',
      }),
      expect.objectContaining({
        refId: 'chunk-runbook',
        title: 'Vendor Runbook',
        path: 'docs/runbooks/vendor.md',
        content: '# Vendor Runbook\n\nUse live category mappings.',
      }),
    ]);
    expect(JSON.stringify(output.results)).not.toContain('search_result');
  });

  it('resolves Cognee chunk ids through SQLite document metadata when search omits source metadata', async () => {
    previousScript = process.env.ALLEN_COGNEE_SIDECAR_SCRIPT;
    previousPythonPath = process.env.PYTHONPATH;
    scriptDir = mkdtempSync(join(tmpdir(), 'allen-cognee-sqlite-meta-'));
    const fakeModuleDir = join(scriptDir, 'fake-python');
    const dataDir = join(scriptDir, 'cognee');
    const databaseDir = join(dataDir, 'system', 'databases');
    mkdirSync(fakeModuleDir, { recursive: true });
    mkdirSync(databaseDir, { recursive: true });
    writeFileSync(join(fakeModuleDir, 'cognee.py'), `
class SearchType:
    CHUNKS = "CHUNKS"

class Config:
    def data_root_directory(self, value):
        self.data_root = value
    def system_root_directory(self, value):
        self.system_root = value

config = Config()

async def search(**kwargs):
    return [{"id": "chunk-1", "content": "Use live vendor mappings.", "score": 0.9}]
`);
    execFileSync('python3', ['-c', `
import json
import sqlite3
from pathlib import Path
db = Path(${JSON.stringify(join(databaseDir, 'cognee_db'))})
connection = sqlite3.connect(db)
connection.execute("CREATE TABLE data (id TEXT PRIMARY KEY, external_metadata TEXT)")
connection.execute("CREATE TABLE nodes (id TEXT, slug TEXT, data_id TEXT, label TEXT, attributes TEXT)")
connection.execute(
    "INSERT INTO data (id, external_metadata) VALUES (?, ?)",
    ("data-1", json.dumps({
        "repoId": "repo-id",
        "repoName": "fixture",
        "branch": "main",
        "headSha": "abc123",
        "path": "docs/vendor-guidelines.md",
        "title": "Vendor Guidelines",
        "kind": "doc",
        "fileHash": "doc-hash",
        "ingestFormat": "markdown_file_docmeta_v1",
        "source": "allen_markdown_file_filter",
    })),
)
connection.execute(
    "INSERT INTO nodes (id, slug, data_id, label, attributes) VALUES (?, ?, ?, ?, ?)",
    ("node-1", "chunk1", "data-1", "chunk-1", json.dumps({"id": "chunk-1"})),
)
connection.commit()
connection.close()
`]);
    process.env.PYTHONPATH = fakeModuleDir;
    process.env.ALLEN_COGNEE_SIDECAR_SCRIPT = join(process.cwd(), 'src/scripts/cognee-context-provider.py');

    const output = await runCogneeSidecar('search', {
      datasetName: 'allen-fixture',
      dataDir,
      query: 'vendor category mapping',
      limits: { maxResults: 1 },
    });

    expect(output.results).toEqual([
      expect.objectContaining({
        refId: 'chunk-1',
        title: 'Vendor Guidelines',
        path: 'docs/vendor-guidelines.md',
        kind: 'doc',
        sourceMetadata: expect.objectContaining({
          repoId: 'repo-id',
          path: 'docs/vendor-guidelines.md',
          fileHash: 'doc-hash',
        }),
      }),
    ]);
    expect(output.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'cognee_chunk_source_metadata_resolution',
        chunkCount: 1,
        resolvedChunkMetadataCount: 1,
        unresolvedChunkMetadataCount: 0,
      }),
    ]));
    expect(output.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'cognee_chunk_source_metadata_unresolved' }),
    ]));
  });

  it('unpacks Cognee content envelopes and double-encoded envelopes', async () => {
    previousScript = process.env.ALLEN_COGNEE_SIDECAR_SCRIPT;
    previousPythonPath = process.env.PYTHONPATH;
    scriptDir = mkdtempSync(join(tmpdir(), 'allen-cognee-envelope-'));
    const fakeModuleDir = join(scriptDir, 'fake-python');
    mkdirSync(fakeModuleDir, { recursive: true });
    writeFileSync(join(fakeModuleDir, 'cognee.py'), `
import json

class SearchType:
    CHUNKS = "CHUNKS"

class Config:
    def data_root_directory(self, value):
        self.data_root = value
    def system_root_directory(self, value):
        self.system_root = value

config = Config()

async def search(**kwargs):
    direct = json.dumps({
        "title": "Direct PRD",
        "path": "docs/prds/direct.md",
        "kind": "doc",
        "content": "# Direct PRD\\n\\nRequirements only.",
    })
    inner = json.dumps({
        "title": "Inner PRD",
        "path": "docs/prds/inner.md",
        "kind": "doc",
        "content": "# Inner PRD\\n\\nconst live = true;",
    })
    double_encoded = json.dumps({
        "title": "Outer Wrapper",
        "path": "docs/wrapper.md",
        "kind": "doc",
        "content": inner,
    })
    return [
        {"id": "direct-prd", "content": direct, "score": 0.5},
        {"id": "double-prd", "content": double_encoded, "score": 0.4},
    ]
`);
    process.env.PYTHONPATH = fakeModuleDir;
    process.env.ALLEN_COGNEE_SIDECAR_SCRIPT = join(process.cwd(), 'src/scripts/cognee-context-provider.py');

    const output = await runCogneeSidecar('search', {
      datasetName: 'allen-fixture',
      dataDir: join(scriptDir, 'cognee'),
      query: 'vendor category mapping',
      limits: { maxResults: 2 },
    });

    expect(output.results).toEqual([
      expect.objectContaining({
        refId: 'direct-prd',
        title: 'Direct PRD',
        path: 'docs/prds/direct.md',
        kind: 'doc',
        content: '# Direct PRD\n\nRequirements only.',
      }),
      expect.objectContaining({
        refId: 'double-prd',
        title: 'Inner PRD',
        path: 'docs/prds/inner.md',
        kind: 'doc',
        content: '# Inner PRD\n\nconst live = true;',
      }),
    ]);
    expect(JSON.stringify(output.results)).not.toContain('Outer Wrapper');
  });
});

describe('Context reranker sidecars and policy', () => {
  let tempDir: string | undefined;
  let previousScript: string | undefined;
  let previousPythonPath: string | undefined;
  let previousReranker: string | undefined;
  let previousModel: string | undefined;
  let previousPairsOut: string | undefined;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
    if (previousScript === undefined) delete process.env.ALLEN_CONTEXT_RERANKER_SCRIPT;
    else process.env.ALLEN_CONTEXT_RERANKER_SCRIPT = previousScript;
    if (previousPythonPath === undefined) delete process.env.PYTHONPATH;
    else process.env.PYTHONPATH = previousPythonPath;
    if (previousReranker === undefined) delete process.env.ALLEN_CONTEXT_RERANKER;
    else process.env.ALLEN_CONTEXT_RERANKER = previousReranker;
    if (previousModel === undefined) delete process.env.ALLEN_CONTEXT_RERANKER_MODEL;
    else process.env.ALLEN_CONTEXT_RERANKER_MODEL = previousModel;
    if (previousPairsOut === undefined) delete process.env.ALLEN_RERANKER_PAIRS_OUT;
    else process.env.ALLEN_RERANKER_PAIRS_OUT = previousPairsOut;
  });

  it('includes candidate content in Python reranker scoring text', () => {
    previousPythonPath = process.env.PYTHONPATH;
    previousPairsOut = process.env.ALLEN_RERANKER_PAIRS_OUT;
    tempDir = mkdtempSync(join(tmpdir(), 'allen-reranker-content-'));
    const pairsOut = join(tempDir, 'pairs.json');
    writeFileSync(join(tempDir, 'sentence_transformers.py'), `
import json
import os

class CrossEncoder:
    def __init__(self, model_name):
        self.model_name = model_name
    def predict(self, pairs):
        with open(os.environ["ALLEN_RERANKER_PAIRS_OUT"], "w") as fh:
            json.dump(pairs, fh)
        return [0.42 for _ in pairs]
`);
    process.env.PYTHONPATH = tempDir;
    process.env.ALLEN_RERANKER_PAIRS_OUT = pairsOut;

    const output = execFileSync(
      process.env.ALLEN_PYTHON_BIN ?? 'python3',
      [join(process.cwd(), 'src/scripts/context-reranker.py')],
      {
        input: JSON.stringify({
          providerId: 'bge',
          task: 'Fix vendor mapper',
          candidates: [{
            refId: 'ref-1',
            title: 'Vendor PRD',
            path: 'docs/prd/vendor.md',
            kind: 'doc',
            summary: 'summary',
            content: 'DISTINCTIVE CONTENT USED BY RERANKER',
            tags: ['prd'],
          }],
        }),
        env: process.env,
      },
    );

    expect(JSON.parse(output.toString()).scores).toEqual([expect.objectContaining({ refId: 'ref-1', score: 0.42 })]);
    expect(readFileSync(pairsOut, 'utf8')).toContain('DISTINCTIVE CONTENT USED BY RERANKER');
  });

  it('preserves Cognee retrieval order for Cognee-only candidates even when semantic reranking is configured', async () => {
    previousReranker = process.env.ALLEN_CONTEXT_RERANKER;
    previousScript = process.env.ALLEN_CONTEXT_RERANKER_SCRIPT;
    process.env.ALLEN_CONTEXT_RERANKER = 'bge';
    delete process.env.ALLEN_CONTEXT_RERANKER_SCRIPT;

    const reranked = await createConfiguredContextReranker().rerank({
      repoId: 'repo',
      repoName: 'fixture',
      repoPath: '/tmp/fixture',
      indexId: 'index-1',
      indexFreshness: 'fresh',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'investigate',
      nodeRole: 'bug-investigator',
      attempt: 1,
      state: {},
      prompt: 'Fix vendor onboarding stale category mapper rerun',
      provider: 'claude',
      currentFiles: ['ui/src/modules/vendor-onboarding-v2/components/steps/Step2CategorySelection.tsx'],
      nodes: [],
      candidates: [
        {
          refId: 'cognee:first',
          title: 'Stale Data Detection',
          kind: 'historical_learning',
          summary: 'Step 2 reparse detectedCategories when agentResult changes.',
          tags: ['cognee', 'guideline'],
          providerId: 'cognee_memory',
          source: 'cognee_recall',
          reason: 'Cognee rank 1',
          loadable: true,
          mandatory: false,
          itemType: 'repo_chunk',
          grounding: 'repo_backed',
          content: 'detectedCategories _parserVersion agentResult',
        },
        {
          refId: 'cognee:second',
          title: 'LLM Transformation Memory',
          kind: 'historical_learning',
          summary: 'Batch category identification flow.',
          tags: ['cognee', 'guideline'],
          providerId: 'cognee_memory',
          source: 'cognee_recall',
          reason: 'Cognee rank 2',
          loadable: true,
          mandatory: false,
          itemType: 'repo_chunk',
          grounding: 'repo_backed',
          content: 'batch category identification ClassificationSteps',
        },
      ],
    });

    expect(reranked.providerId).toBe('provider_order_preserver');
    expect(reranked.rankedRefs.map((ref) => ref.refId)).toEqual(['cognee:first', 'cognee:second']);
    expect(reranked.rankedRefs.map((ref) => ref.rerank)).toEqual([
      expect.objectContaining({ providerId: 'provider_order_preserver', originalRank: 0, finalRank: 0 }),
      expect.objectContaining({ providerId: 'provider_order_preserver', originalRank: 1, finalRank: 1 }),
    ]);
    expect(reranked.diagnostics).toEqual([
      expect.objectContaining({
        code: 'semantic_reranker_skipped_single_provider',
        providerId: 'cognee_memory',
        candidateCount: 2,
        preservedProviderRank: true,
      }),
    ]);
  });

  it('delegates mixed-provider candidates to the configured semantic reranker', async () => {
    previousScript = process.env.ALLEN_CONTEXT_RERANKER_SCRIPT;
    previousReranker = process.env.ALLEN_CONTEXT_RERANKER;
    tempDir = mkdtempSync(join(tmpdir(), 'allen-reranker-mixed-'));
    const script = join(tempDir, 'fake-reranker.py');
    writeFileSync(script, `#!/usr/bin/env python3
import json
import sys

payload = json.loads(sys.stdin.read() or "{}")
scores = []
for candidate in payload.get("candidates", []):
    scores.append({
        "refId": candidate["refId"],
        "score": 0.9 if candidate["refId"] == "graph:ui-rules" else 0.1,
        "reason": "mixed provider semantic test score",
    })
print(json.dumps({"scores": scores, "diagnostics": []}))
`);
    process.env.ALLEN_CONTEXT_RERANKER = 'bge';
    process.env.ALLEN_CONTEXT_RERANKER_SCRIPT = script;

    const reranked = await createConfiguredContextReranker().rerank({
      repoId: 'repo',
      repoName: 'fixture',
      repoPath: '/tmp/fixture',
      indexId: 'index-1',
      indexFreshness: 'fresh',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'investigate',
      nodeRole: 'bug-investigator',
      attempt: 1,
      state: {},
      prompt: 'Fix vendor onboarding stale category mapper rerun',
      provider: 'claude',
      currentFiles: [],
      nodes: [],
      candidates: [
        {
          refId: 'cognee:first',
          title: 'Cognee Memory',
          kind: 'historical_learning',
          summary: 'Cognee-only source.',
          tags: ['cognee'],
          providerId: 'cognee_memory',
          source: 'cognee_recall',
          reason: 'Cognee rank 1',
          loadable: true,
          mandatory: false,
          itemType: 'repo_chunk',
          grounding: 'repo_backed',
          content: 'Cognee memory content.',
        },
        {
          refId: 'graph:ui-rules',
          title: 'UI Rules',
          kind: 'context_file',
          path: '.claude/rules/modules/ui.md',
          summary: 'UI rules.',
          tags: ['ui'],
          providerId: 'graph_keyword_metadata',
          source: 'repo_knowledge_graph',
          reason: 'Graph metadata match.',
          loadable: true,
          mandatory: false,
          itemType: 'repo_file',
          grounding: 'repo_backed',
          content: 'UI module rules.',
        },
      ],
    });

    expect(reranked.providerId).toBe('bge');
    expect(reranked.rankedRefs.map((ref) => ref.refId)).toEqual(['graph:ui-rules', 'cognee:first']);
    expect(reranked.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'semantic_reranker_completed', providerId: 'bge' }),
    ]));
    expect(reranked.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'semantic_reranker_skipped_single_provider' }),
    ]));
  });

  it('downranks PRD code snippets for coding tasks when semantic scores are close', async () => {
    previousScript = process.env.ALLEN_CONTEXT_RERANKER_SCRIPT;
    previousReranker = process.env.ALLEN_CONTEXT_RERANKER;
    tempDir = mkdtempSync(join(tmpdir(), 'allen-reranker-policy-'));
    const script = join(tempDir, 'fake-reranker.py');
    writeFileSync(script, `#!/usr/bin/env python3
import json
import sys

payload = json.loads(sys.stdin.read() or "{}")
print(json.dumps({
  "scores": [{"refId": candidate["refId"], "score": 0.5, "reason": "equal test score"} for candidate in payload.get("candidates", [])],
  "diagnostics": []
}))
`);
    process.env.ALLEN_CONTEXT_RERANKER = 'bge';
    process.env.ALLEN_CONTEXT_RERANKER_SCRIPT = script;

    const reranked = await createConfiguredContextReranker().rerank({
      repoId: 'repo',
      repoName: 'fixture',
      repoPath: '/tmp/fixture',
      indexId: 'index-1',
      indexFreshness: 'fresh',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'implement',
      nodeRole: 'backend-developer',
      attempt: 1,
      state: {},
      prompt: 'Fix stale vendor category mappings',
      provider: 'claude',
      currentFiles: [],
      nodes: [],
      candidates: [
        {
          refId: 'prd-ref',
          title: 'Vendor PRD',
          kind: 'doc',
          path: 'docs/prd/vendor.md',
          summary: 'Illustrative implementation snippet.',
          tags: ['prd'],
          providerId: 'cognee_memory',
          source: 'cognee_recall',
          reason: 'PRD matched the task.',
          loadable: true,
          mandatory: false,
          itemType: 'repo_chunk',
          grounding: 'repo_backed',
          content: '```ts\nfunction staleExample() {}\n```',
          providerMetadata: { documentRole: 'prd', containsCodeBlocks: true },
        },
        {
          refId: 'guideline-ref',
          title: 'Vendor Mapping Guidelines',
          kind: 'doc',
          path: 'docs/vendor-guidelines.md',
          summary: 'Use live mapper state.',
          tags: ['guideline'],
          providerId: 'graph_keyword_metadata',
          source: 'repo_knowledge_graph',
          reason: 'Guidelines matched the task.',
          loadable: true,
          mandatory: false,
          itemType: 'repo_chunk',
          grounding: 'repo_backed',
          content: 'Use live mapper state.',
          providerMetadata: { documentRole: 'guideline', containsCodeBlocks: false },
        },
      ],
    });

    expect(reranked.rankedRefs[0].refId).toBe('guideline-ref');
    expect(reranked.rankedRefs.find((ref) => ref.refId === 'prd-ref')?.rerank).toEqual(expect.objectContaining({
      policyAdjustment: expect.any(Number),
      policyReason: expect.stringContaining('lower authority'),
    }));
    expect(reranked.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'context_policy_adjusted_ranking', prdCodeSnippetDownrankedCount: 1 }),
    ]));
  });
});

class TestSemanticReranker implements ContextReranker {
  readonly providerId = 'test_semantic_reranker';

  async rerank(input: ContextRerankInput): Promise<ContextRerankResult> {
    const rankedRefs = input.candidates
      .map((ref, originalRank) => ({
        ...ref,
        rerank: {
          providerId: this.providerId,
          score: semanticScore(ref),
          originalRank,
          finalRank: originalRank,
          reason: 'test semantic score',
          mandatoryProtected: ref.mandatory,
        },
      }))
      .sort((a, b) => Number((b.rerank as { score: number }).score) - Number((a.rerank as { score: number }).score))
      .map((ref, finalRank) => ({ ...ref, rerank: { ...(ref.rerank as Record<string, unknown>), finalRank } }));
    return {
      providerId: this.providerId,
      rankedRefs,
      diagnostics: [],
      traces: rankedRefs.map((ref, idx) => ({ refId: ref.refId, providerId: this.providerId, finalRank: idx })),
    };
  }
}

function graphEngine(reranker?: ContextReranker): RepoContextEngine {
  return new RepoContextEngine(
    [new MandatoryGraphProvider(), new GraphKeywordMetadataProvider()],
    reranker,
  );
}

function semanticScore(ref: KnowledgeCandidateRef): number {
  if (ref.refId === 'repo:skill') return 100;
  if (ref.mandatory) return -100;
  return Number(ref.score ?? 0);
}

function node(
  id: string,
  kind: KnowledgeNodeLike['kind'],
  title: string,
  path: string | undefined,
  summary: string,
  tags: string[],
  injectPolicy: KnowledgeNodeLike['access']['injectPolicy'],
  mandatoryForNodeRoles?: string[],
): KnowledgeNodeLike {
  return {
    id,
    kind,
    title,
    path,
    summary,
    tags,
    mandatoryForNodeRoles,
    access: { injectPolicy },
  };
}
