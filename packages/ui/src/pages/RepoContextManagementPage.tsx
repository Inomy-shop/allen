import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ArrowLeft,
  BookOpenCheck,
  Database,
  Info,
  Loader2,
  Network,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import AgentChatDropdown, { type AgentChatOption } from '../components/chat/AgentChatDropdown';
import {
  ContextReactFlow,
  displayGraphNodeLabel,
  edgeEndpointNodes,
  hasUsableConnectionDetail,
  isDocumentGraphNode,
  mergeContextGraphs,
  nodeDetailToContextGraph,
  selectedTitle,
  type ContextGraph,
} from '../components/context-management/ContextGraphFlow';
import { repos as repoApi } from '../services/api';
import { useToast } from '../components/common/Toast';

type Repo = {
  _id: string;
  name: string;
  path: string;
  detected?: { defaultBranch?: string };
};

type ContextManagementState = {
  entries?: Array<Record<string, any>>;
  allEntries?: Array<Record<string, any>>;
  curationStats?: { active?: number; total?: number; excluded?: number; stale?: number };
  mandatoryMappings?: Array<Record<string, any>>;
  agents?: Array<Record<string, any>>;
  cogneeStatus?: CogneeStatus | null;
  graph?: ContextGraph;
};

type CogneeStatus = {
  status?: 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'stopped';
  stage?: 'pulling' | 'collecting_curated_context' | 'collecting_markdown' | 'ingesting' | 'cognifying' | 'completed' | 'failed';
  ingestFormat?: string;
  message?: string;
  documentCount?: number;
  candidateCount?: number;
  processedDocumentCount?: number;
  ingestedDocumentCount?: number;
  cognifiedDocumentCount?: number;
  documentsToIngestCount?: number;
  addedDocumentCount?: number;
  changedDocumentCount?: number;
  deletedDocumentCount?: number;
  unchangedDocumentCount?: number;
  uncognifiedRetryCount?: number;
  workerActive?: boolean;
  buildMode?: 'resume' | 'clean_rebuild';
  previousDatasetName?: string;
  uncognifiedDocuments?: Array<{ path?: string; title?: string; fileHash?: string; dataId?: string; cogneeDataId?: string; status?: string }>;
  error?: string;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  updatedAt?: string;
};

type ContextGraphFilters = {
  query: string;
  nodeType: string;
  relationship: string;
};

type CuratedChunkDraft = {
  chunkId: string;
  heading: string;
  targetGlobs: string[];
  targetRoles: string[];
  sourceAnchors: string[];
  text: string;
};

type CuratedEntryDraft = {
  entryId?: string;
  path: string;
  title: string;
  category: string;
  inclusion: string;
  injectionPolicy: string;
  summary: string;
  curatedContext: string;
  retrievalText: string;
  chunks: CuratedChunkDraft[];
};

const NEW_CURATED_ENTRY_ID = '__new_curated_entry__';
const CONTEXT_GRAPH_PREVIEW_NODES = 160;
const CONTEXT_GRAPH_PREVIEW_EDGES = 360;
const CONTEXT_FIELD_INFO = {
  curatedContext: 'Agent-facing curated content. After Cognee returns a matching chunk and Allen resolves it to a curation entry, this is the primary text injected into the agent prompt.',
  retrievalText: 'Cognee-facing ingestion text. Refresh Context ingests this first for semantic search, chunk retrieval, cognification, graph entities, and graph relationships.',
  curatedChunks: 'Section-level curated material for large or multi-topic files. Currently used as fallback Cognee ingestion material when retrieval text is missing, and shown for editing/debugging.',
  cogneeChunkText: 'Raw text returned by Cognee search from its own chunking/cognification. Allen keeps this for diagnostics; after curation resolution it is not the primary injected text.',
  selectedRefContent: 'The final content on the selected reference after Allen enrichment. For resolved curated Cognee refs this is usually curated context, and this is what the injection packer considers.',
  mandatoryContext: 'Mandatory agent-specific context from mandatory mappings. When selected for an agent, this content is injected directly into the system prompt.',
} as const;

export default function RepoContextManagementPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [repo, setRepo] = useState<Repo | null>(null);
  const [state, setState] = useState<ContextManagementState | null>(null);
  const [cogneeStatus, setCogneeStatus] = useState<CogneeStatus | null>(null);
  const [activeTab, setActiveTab] = useState<'playground' | 'graph' | 'curated' | 'mandatory'>('graph');
  const [loading, setLoading] = useState(true);
  const [stoppingBuild, setStoppingBuild] = useState(false);
  const [graph, setGraph] = useState<ContextGraph | undefined>();
  const [graphLoaded, setGraphLoaded] = useState(false);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphFilters, setGraphFilters] = useState<ContextGraphFilters>({ query: '', nodeType: '', relationship: '' });
  const [selected, setSelected] = useState<Record<string, any> | null>(null);
  const [selectedGraphNodeId, setSelectedGraphNodeId] = useState<string | null>(null);
  const [selectedGraphEdge, setSelectedGraphEdge] = useState<Record<string, any> | null>(null);
  const wasLiveBuildRef = useRef(false);

  const clearGraphSelection = useCallback(() => {
    setSelected(null);
    setSelectedGraphNodeId(null);
    setSelectedGraphEdge(null);
  }, []);

  const load = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!id) return;
    if (!options.silent) setLoading(true);
    try {
      const [repoDoc, management] = await Promise.all([
        repoApi.get(id),
        repoApi.getContextManagement(id),
      ]);
      setRepo(repoDoc);
      setState(management);
      setCogneeStatus(management.cogneeStatus ?? null);
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to load context management');
    } finally {
      if (!options.silent) setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const stopContextBuild = useCallback(async () => {
    if (!id) return;
    setStoppingBuild(true);
    try {
      const status = await repoApi.stopCognee(id);
      setCogneeStatus(status);
      toast.info(status.message ?? 'Context build stopped.');
      await load({ silent: true });
    } catch (err: any) {
      toast.error(err.message ?? 'Context stop failed');
    } finally {
      setStoppingBuild(false);
    }
  }, [id, load, toast]);

  const refreshCogneeStatus = useCallback(async () => {
    if (!id) return null;
    const status = await repoApi.getCogneeStatus(id);
    setCogneeStatus(status);
    return status as CogneeStatus | null;
  }, [id]);

  const loadContextGraph = useCallback(async (
    extra: Record<string, string | number | undefined> = {},
    options: { clearSelection?: boolean } = {},
  ): Promise<ContextGraph | undefined> => {
    if (!id) return undefined;
    const nextFilters = {
      query: String(extra.query ?? graphFilters.query),
      nodeType: String(extra.nodeType ?? graphFilters.nodeType),
      relationship: String(extra.relationship ?? graphFilters.relationship),
    };
    setGraphLoading(true);
    try {
      const nextGraph = await repoApi.getContextGraph(id, {
        query: nextFilters.query,
        nodeType: nextFilters.nodeType,
        relationship: nextFilters.relationship,
        maxNodes: CONTEXT_GRAPH_PREVIEW_NODES,
        maxEdges: CONTEXT_GRAPH_PREVIEW_EDGES,
        ...extra,
        ...(options.clearSelection === false ? {} : { expandNodeId: undefined }),
      });
      setGraph(nextGraph);
      setGraphLoaded(true);
      if (options.clearSelection !== false) clearGraphSelection();
      return nextGraph;
    } catch (err: any) {
      setGraphLoaded(true);
      toast.error(err.message ?? 'Failed to load context graph');
      return undefined;
    } finally {
      setGraphLoading(false);
    }
  }, [clearGraphSelection, graphFilters.nodeType, graphFilters.query, graphFilters.relationship, id, toast]);

  useEffect(() => {
    const live = isContextLiveBuild(cogneeStatus);
    wasLiveBuildRef.current = live || wasLiveBuildRef.current;
    if (!live) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void refreshCogneeStatus()
        .then((status) => {
          if (cancelled || !status) return;
          if (!isContextLiveBuild(status) && wasLiveBuildRef.current) {
            wasLiveBuildRef.current = false;
            void load({ silent: true });
            void loadContextGraph({}, { clearSelection: false });
          }
        })
        .catch((err: any) => toast.error(err.message ?? 'Failed to refresh context build status'));
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [cogneeStatus, load, loadContextGraph, refreshCogneeStatus, toast]);

  useEffect(() => {
    if (!state?.graph || graphLoaded || graph) return;
    setGraph(state.graph);
    setGraphLoaded(true);
  }, [graph, graphLoaded, state?.graph]);

  useEffect(() => {
    if (loading || activeTab !== 'graph' || graphLoaded || isContextLiveBuild(cogneeStatus)) return;
    void loadContextGraph({}, { clearSelection: false });
  }, [activeTab, cogneeStatus, graphLoaded, loadContextGraph, loading]);

  const activeCurated = useMemo(
    () => uniqueCuratedEntries(state?.allEntries ?? state?.entries ?? []).filter((entry) => entry.inclusion === 'include').length,
    [state?.allEntries, state?.entries],
  );
  const providerLabel = cogneeStatus?.status
    ? String(cogneeStatus.status)
    : 'none';

  return (
    <div className="min-h-full px-6 pt-5 pb-8">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <button
            type="button"
            onClick={() => navigate('/agents?section=repos')}
            className="btn btn-ghost btn-sm mb-3"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Back to repos
          </button>
          <h1 className="mt-1 text-[22px] font-semibold text-theme-primary tracking-tight truncate">
            {repo?.name ?? 'Context management'}
          </h1>
          <ContextBuildProgress status={cogneeStatus} stopping={stoppingBuild} onStop={() => void stopContextBuild()} />
        </div>
        <button type="button" onClick={() => void load()} className="btn btn-secondary btn-sm">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      {loading ? (
        <div className="text-xs text-theme-muted animate-pulse">Loading context management...</div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
            <Metric label="Curated active" value={activeCurated} />
            <Metric label="Mandatory" value={state?.mandatoryMappings?.length ?? 0} />
            <Metric label="Context provider" value={providerLabel} />
            <Metric label="Graph nodes" value={Number(graph?.nodeCount ?? state?.graph?.nodeCount ?? 0).toLocaleString()} />
            <Metric label="Graph edges" value={Number(graph?.edgeCount ?? state?.graph?.edgeCount ?? 0).toLocaleString()} />
          </div>
          <div className="border-b border-app flex gap-1">
            {([
              ['graph', Network, 'Context Graph'],
              ['curated', BookOpenCheck, 'Curated Context'],
              ['mandatory', ShieldCheck, 'Mandatory Context'],
              ['playground', Search, 'Playground'],
            ] as Array<[typeof activeTab, LucideIcon, string]>).map(([tab, Icon, label]) => (
              <button
                key={String(tab)}
                type="button"
                onClick={() => setActiveTab(tab as typeof activeTab)}
                className={`px-3 py-2 text-xs rounded-t inline-flex items-center gap-1.5 ${activeTab === tab ? 'bg-app-muted text-theme-primary' : 'text-theme-muted hover:text-theme-primary'}`}
              >
                <Icon className="w-3.5 h-3.5" /> {label}
              </button>
            ))}
          </div>

          {activeTab === 'playground' && <ContextPlayground repoId={id} agents={state?.agents ?? []} />}
          {activeTab === 'graph' && (
            <ContextGraphSection
              repoId={id}
              graph={graph}
              graphFilters={graphFilters}
              selected={selected}
              selectedGraphNodeId={selectedGraphNodeId}
              selectedGraphEdge={selectedGraphEdge}
              loading={graphLoading}
              onGraphFiltersChanged={setGraphFilters}
              onLoadGraph={loadContextGraph}
              onSelectedChanged={setSelected}
              onSelectedGraphNodeIdChanged={setSelectedGraphNodeId}
              onSelectedGraphEdgeChanged={setSelectedGraphEdge}
              contextStatus={cogneeStatus}
              onStatusChanged={setCogneeStatus}
              onChanged={() => load({ silent: true })}
            />
          )}
          {activeTab === 'curated' && <CuratedContextSection repoId={id} entries={state?.allEntries ?? state?.entries ?? []} onChanged={load} />}
          {activeTab === 'mandatory' && <MandatoryContextSection repoId={id} agents={state?.agents ?? []} mappings={state?.mandatoryMappings ?? []} onChanged={load} />}
        </div>
      )}
    </div>
  );
}

function ContextPlayground({ repoId, agents }: { repoId: string; agents: Array<Record<string, any>> }) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [agentName, setAgentName] = useState(String(agents[0]?.name ?? ''));
  const [currentFiles, setCurrentFiles] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Record<string, any> | null>(null);
  const agentOptions = useMemo(() => toAgentChatOptions(agents), [agents]);

  useEffect(() => {
    if (!agentName && agentOptions[0]?.name) setAgentName(agentOptions[0].name);
  }, [agentName, agentOptions]);

  const run = async () => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      setResult(await repoApi.runContextPlayground(repoId, {
        query,
        agentName,
        nodeRole: agentName,
        currentFiles: currentFiles.split(',').map((item) => item.trim()).filter(Boolean),
      }));
    } catch (err: any) {
      toast.error(err.message ?? 'Context playground run failed');
    } finally {
      setLoading(false);
    }
  };

  const packet = result?.packet ?? {};
  const injection = result?.injection ?? {};
  return (
    <div className="grid grid-cols-1 xl:grid-cols-[360px_1fr] gap-4">
      <div className="space-y-3">
        <AgentChatDropdown
          value={agentName || null}
          onChange={(name) => setAgentName(name ?? '')}
          agents={agentOptions}
          showAssistant={false}
        />
        <textarea value={query} onChange={(e) => setQuery(e.target.value)} className="input text-xs min-h-28" placeholder="Ask the context engine what this agent is about to work on..." />
        <input value={currentFiles} onChange={(e) => setCurrentFiles(e.target.value)} className="input text-xs" placeholder="Current files, comma-separated" />
        <button type="button" onClick={run} disabled={loading || !query.trim()} className="btn btn-primary btn-sm">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
          Run pipeline
        </button>
      </div>
      <div className="space-y-4">
        {!result ? (
          <EmptyState text="Run a query to see mandatory context, semantic retrieval, reranking, filtering, compression, and injection decisions." />
        ) : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
              <Metric label="Candidates" value={packet.candidateRefs?.length ?? 0} />
              <Metric label="Selected" value={packet.selectedRefs?.length ?? 0} />
              <Metric label="Injectable" value={packet.injectableRefs?.length ?? 0} />
              <Metric label="Injected" value={injection.injectedCount ?? 0} />
            </div>
            <KeyValue rows={[
              ['query hash', packet.contextQuery?.renderedQueryHash],
              ['query length', packet.contextQuery?.renderedQueryLength],
              ['role', packet.contextQuery?.role],
              ['role family', packet.contextQuery?.roleFamily],
              ['providers', packet.retrievalProviders?.join(', ')],
            ]} />
            <TextPanel title="Generated context query" text={packet.contextQuery?.renderedQuery} />
            <RefList title="Selected refs" refs={packet.selectedRefs ?? []} />
            <RefList title="Injectable refs" refs={packet.injectableRefs ?? []} />
            <RefList title="Rejected refs" refs={packet.rejectedRefs ?? []} />
            <RefList title="Packing decisions" refs={injection.packingDecisions ?? []} />
            <Diagnostics title="Provider diagnostics" items={packet.providerDiagnostics ?? []} />
            <JsonPanel title="Built packet JSON" value={packet} />
            <JsonPanel title="Generated injection JSON" value={injection} />
          </>
        )}
      </div>
    </div>
  );
}

function ContextBuildProgress({
  status,
  stopping,
  onStop,
}: {
  status?: CogneeStatus | null;
  stopping: boolean;
  onStop: () => void;
}) {
  if (!status) return null;
  const live = isContextLiveBuild(status);
  const visible = live || status.status === 'partial' || status.status === 'failed' || status.status === 'stopped';
  if (!visible) return null;
  const candidateCount = statusNumber(status.candidateCount);
  const documentCount = statusNumber(status.documentCount);
  const skipped = candidateCount != null && documentCount != null ? Math.max(0, candidateCount - documentCount) : undefined;
  const progress = contextBuildProgressPercent(status);
  const stage = contextBuildStageLabel(status);
  return (
    <div className={`mt-3 rounded border p-3 ${status.status === 'failed' ? 'border-red-500/40 bg-red-500/10' : 'border-app bg-app-card/70'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-medium text-theme-primary">
            {live ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Database className="w-3.5 h-3.5" />}
            <span>{stage}</span>
            {status.buildMode && <span className="text-[10px] font-mono text-theme-muted">{status.buildMode === 'clean_rebuild' ? 'clean build' : 'refresh'}</span>}
          </div>
          {status.message && <div className="mt-1 text-[11px] text-theme-muted">{status.message}</div>}
        </div>
        {progress != null && (
          <div className="flex items-center gap-3">
            <div className="w-36">
              <div className="h-1.5 rounded bg-app-muted overflow-hidden">
                <div className="h-full rounded bg-accent" style={{ width: `${progress}%` }} />
              </div>
              <div className="mt-1 text-[10px] text-theme-muted font-mono text-right">{progress}%</div>
            </div>
            {live && (
              <button type="button" onClick={onStop} disabled={stopping} className="btn btn-ghost btn-sm">
                {stopping ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
                Cancel
              </button>
            )}
          </div>
        )}
        {progress == null && live && (
          <button type="button" onClick={onStop} disabled={stopping} className="btn btn-ghost btn-sm">
            {stopping ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
            Cancel
          </button>
        )}
      </div>
      <div className="mt-3 grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2">
        <BuildProgressMetric label="candidates" value={candidateCount} />
        <BuildProgressMetric label="ingestable" value={documentCount} />
        <BuildProgressMetric label="skipped" value={skipped} />
        <BuildProgressMetric label="already there" value={status.unchangedDocumentCount} />
        <BuildProgressMetric label="to ingest" value={status.documentsToIngestCount} />
        <BuildProgressMetric label="added" value={status.addedDocumentCount} />
        <BuildProgressMetric label="changed" value={status.changedDocumentCount} />
        <BuildProgressMetric label="deleted" value={status.deletedDocumentCount} />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-theme-muted font-mono">
        <span>ingested {formatCount(status.ingestedDocumentCount)}/{formatCount(ingestProgressTotal(status))}</span>
        <span>cognified {formatCount(status.cognifiedDocumentCount)}/{formatCount(status.documentCount)}</span>
        <span>cognify target {formatCount(status.documentCount)}</span>
        {status.uncognifiedRetryCount != null && <span>uncognified retry {formatCount(status.uncognifiedRetryCount)}</span>}
        {status.error && <span className="text-red-400">{status.error}</span>}
      </div>
    </div>
  );
}

function BuildProgressMetric({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <div className="rounded border border-app bg-app-card/60 px-2 py-1.5">
      <div className="text-[9.5px] uppercase tracking-wide text-theme-muted">{label}</div>
      <div className="text-xs font-mono text-theme-primary">{formatCount(value)}</div>
    </div>
  );
}

function ContextGraphSection({
  repoId,
  graph,
  graphFilters,
  selected,
  selectedGraphNodeId,
  selectedGraphEdge,
  loading,
  onGraphFiltersChanged,
  onLoadGraph,
  onSelectedChanged,
  onSelectedGraphNodeIdChanged,
  onSelectedGraphEdgeChanged,
  contextStatus,
  onStatusChanged,
  onChanged,
}: {
  repoId: string;
  graph?: ContextGraph;
  graphFilters: ContextGraphFilters;
  selected: Record<string, any> | null;
  selectedGraphNodeId: string | null;
  selectedGraphEdge: Record<string, any> | null;
  loading: boolean;
  onGraphFiltersChanged: (filters: ContextGraphFilters) => void;
  onLoadGraph: (extra?: Record<string, string | number | undefined>, options?: { clearSelection?: boolean }) => Promise<ContextGraph | undefined>;
  onSelectedChanged: (selected: Record<string, any> | null) => void;
  onSelectedGraphNodeIdChanged: (nodeId: string | null) => void;
  onSelectedGraphEdgeChanged: (edge: Record<string, any> | null) => void;
  contextStatus?: CogneeStatus | null;
  onStatusChanged: (status: CogneeStatus | null) => void;
  onChanged: () => Promise<void> | void;
}) {
  const toast = useToast();
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [connectionDetail, setConnectionDetail] = useState<Record<string, any> | null>(null);
  const [connectionLoading, setConnectionLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [building, setBuilding] = useState(false);
  const liveBuild = isContextLiveBuild(contextStatus);
  const graphRebuilding = liveBuild && contextStatus?.buildMode === 'clean_rebuild';

  const loadConnectionDetail = useCallback(async (
    nodeId: string,
    options: { commit?: boolean } = {},
  ): Promise<Record<string, any> | null> => {
    if (!nodeId) return null;
    setConnectionLoading(true);
    try {
      const detail = await repoApi.getContextGraphNode(repoId, nodeId, {
        maxRelatedNodes: 500,
        maxRelatedEdges: 1000,
        includeDocuments: true,
      });
      if (options.commit !== false) setConnectionDetail(detail);
      return detail;
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to load node connections');
      return null;
    } finally {
      setConnectionLoading(false);
    }
  }, [repoId, toast]);

  const buildContext = async (cleanRebuild = false) => {
    setBuilding(true);
    try {
      const status = await repoApi.refreshCognee(repoId, { cleanRebuild });
      onStatusChanged(status);
      if (status.status === 'running') toast.info(status.message ?? 'Context build started.');
      else if (status.status === 'completed') toast.success(status.message ?? 'Context build completed.');
      else if (status.status === 'failed') toast.error(status.error ?? 'Context build failed.');
      if (status.status !== 'running') {
        await onChanged();
        await onLoadGraph({}, { clearSelection: false });
      }
    } catch (err: any) {
      toast.error(err.message ?? 'Context build failed');
    } finally {
      setBuilding(false);
    }
  };

  const selectNode = async (node: Record<string, any>) => {
    const nodeId = String(node.id ?? '');
    onSelectedChanged({ ...node, __selectionType: 'node' });
    onSelectedGraphNodeIdChanged(nodeId || null);
    onSelectedGraphEdgeChanged(null);
    if (!nodeId) return;
    setDetailLoading(true);
    try {
      const detail = await repoApi.getContextGraphNode(repoId, nodeId, {
        maxRelatedNodes: 40,
        maxRelatedEdges: 120,
        includeDocuments: true,
      });
      onSelectedChanged({
        ...(detail.node ?? node),
        __selectionType: 'node',
        documentPreview: detail.documentPreview ?? detail.node?.textPreview,
        documentChunks: detail.documentChunks ?? [],
        relatedNodes: detail.relatedNodes ?? [],
        relatedEdges: detail.relatedEdges ?? [],
        graphDetail: detail,
      });
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to load graph node details');
    } finally {
      setDetailLoading(false);
    }
  };

  const openConnections = async (nodeId: string) => {
    if (!nodeId) return;
    setConnectionOpen(true);
    await loadConnectionDetail(nodeId);
  };

  const selectConnectedNode = async (node: Record<string, any>): Promise<Record<string, any> | null> => {
    const nodeId = String(node.id ?? '');
    if (!nodeId) return null;
    if (node.__placeholder) return null;
    const detail = await loadConnectionDetail(nodeId, { commit: false });
    if (!hasUsableConnectionDetail(detail)) {
      return null;
    }
    return detail;
  };

  const nodeTypes = graph?.nodeTypeCounts ?? [];
  const relationships = graph?.relationshipCounts ?? [];
  const selectedNodeConnectionId = selected?.__selectionType === 'node' && selected.id ? String(selected.id) : '';
  return (
    <>
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-4">
      <div className="space-y-3 min-w-0">
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void buildContext(false)} disabled={building || liveBuild} className="btn btn-primary btn-sm">
            {building && !liveBuild ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            Refresh context
          </button>
          <button type="button" onClick={() => void buildContext(true)} disabled={building || liveBuild} className="btn btn-secondary btn-sm" title="Clean rebuild creates a fresh context dataset and does not continue the previous dataset">
            {building && !liveBuild ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Database className="w-3.5 h-3.5" />}
            Clean build context
          </button>
          <input
            value={graphFilters.query}
            onChange={(e) => onGraphFiltersChanged({ ...graphFilters, query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onLoadGraph();
            }}
            className="input text-xs max-w-xs"
            placeholder="Filter nodes..."
          />
          <select
            value={graphFilters.nodeType}
            onChange={(e) => {
              const nextNodeType = e.target.value;
              const nextFilters = { ...graphFilters, nodeType: nextNodeType };
              onGraphFiltersChanged(nextFilters);
              void onLoadGraph({ nodeType: nextNodeType });
            }}
            className="input text-xs max-w-[180px]"
          >
            <option value="">All node types</option>
            {nodeTypes.map((item) => <option key={String(item.type)} value={String(item.type)}>{String(item.type)} ({Number(item.count ?? 0)})</option>)}
          </select>
          <select
            value={graphFilters.relationship}
            onChange={(e) => {
              const nextRelationship = e.target.value;
              const nextFilters = { ...graphFilters, relationship: nextRelationship };
              onGraphFiltersChanged(nextFilters);
              void onLoadGraph({ relationship: nextRelationship });
            }}
            className="input text-xs max-w-[220px]"
          >
            <option value="">All relationships</option>
            {relationships.map((item) => <option key={String(item.relationship)} value={String(item.relationship)}>{String(item.relationship)} ({Number(item.count ?? 0)})</option>)}
          </select>
          <button type="button" onClick={() => void onLoadGraph()} className="btn btn-secondary btn-sm">
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Apply
          </button>
          <button
            type="button"
            onClick={() => void openConnections(selectedNodeConnectionId)}
            disabled={!selectedNodeConnectionId}
            className="btn btn-secondary btn-sm"
            title={selectedNodeConnectionId ? 'Open the selected node neighborhood graph' : 'Select a node to view its connections'}
          >
            <Network className="w-3.5 h-3.5" /> View connections
          </button>
        </div>
        <div className="text-[11px] text-theme-muted font-mono">
          {Number(graph?.nodeCount ?? 0).toLocaleString()} nodes · {Number(graph?.edgeCount ?? 0).toLocaleString()} edges · preview {Number(graph?.previewNodeCount ?? graph?.nodes?.length ?? 0).toLocaleString()} / {Number(graph?.previewEdgeCount ?? graph?.edges?.length ?? 0).toLocaleString()}
        </div>
        <div className="h-[620px] border border-app rounded bg-app-card overflow-hidden relative">
          {graphRebuilding && (
            <div className="absolute inset-x-3 top-3 z-10 rounded border border-app bg-app-card/95 px-3 py-2 text-xs text-theme-secondary shadow-popover">
              Clean build is rebuilding the graph from curated context entries. The graph will refresh when Cognee finishes ingestion and cognification.
            </div>
          )}
          <ReactFlowProvider>
                <ContextReactFlow
                  graph={graph}
                  selectedNodeId={selectedGraphNodeId}
                  selectedEdge={selectedGraphEdge}
                  fitPadding={0.01}
                  fitMaxZoom={2.2}
                  onSelectNode={(node) => void selectNode(node)}
              onSelectEdge={(edge) => {
                onSelectedChanged({ ...edge, __selectionType: 'edge', ...edgeEndpointNodes(graph, edge) });
                onSelectedGraphNodeIdChanged(null);
                onSelectedGraphEdgeChanged(edge);
              }}
              onExpand={(id) => void onLoadGraph({ expandNodeId: id }, { clearSelection: false })}
            />
          </ReactFlowProvider>
        </div>
      </div>
      <div className="space-y-3">
        <Panel title="Graph summary">
          <KeyValue rows={[
            ['provider', graph?.provider],
            ['access mode', graph?.accessMode],
            ['source', graph?.source],
            ['view', graph?.selection?.mode],
            ['nodes', graph?.nodeCount],
            ['edges', graph?.edgeCount],
            ['limited', graph?.limited ? 'yes' : 'no'],
            ['error', graph?.error],
          ]} />
        </Panel>
        <Panel title="Graph shape">
          <div className="space-y-2">
            <CompactCountList items={nodeTypes} labelKey="type" />
            <CompactCountList items={relationships} labelKey="relationship" />
          </div>
        </Panel>
        <Panel title="Selected">
          {selected ? (
            <div className="space-y-2 text-xs">
              <div className="font-medium text-theme-primary break-all">{selectedTitle(selected)}</div>
              {detailLoading && <div className="text-[11px] text-theme-muted animate-pulse">Loading node detail...</div>}
              <KeyValue rows={[
                ['type', selected.type],
                ['relationship', selected.relationship],
                ['entity', selected.entityName],
                ['source path', selected.sourcePath],
                ['text length', selected.textLength],
              ]} />
              {selected.entityDescription && <div className="text-[11px] text-theme-muted whitespace-pre-wrap">{String(selected.entityDescription)}</div>}
              {selected.description && <div className="text-[11px] text-theme-muted whitespace-pre-wrap">{String(selected.description)}</div>}
              {(selected.documentPreview || selected.textPreview) && (
                <div className="rounded border border-app bg-app-card/60 p-2">
                  <div className="text-[10px] uppercase tracking-wide text-theme-muted mb-1">{selected.type === 'TextDocument' ? 'Document preview from chunks' : 'Text preview'}</div>
                  <div className="text-[11px] text-theme-primary whitespace-pre-wrap max-h-72 overflow-auto">{String(selected.documentPreview ?? selected.textPreview)}</div>
                </div>
              )}
              {Array.isArray(selected.relatedNodes) && selected.relatedNodes.length > 0 && (
                <RelatedNodes nodes={selected.relatedNodes} />
              )}
              {Array.isArray(selected.documentChunks) && selected.documentChunks.length > 0 && (
                <RelatedNodes title="Document chunks" nodes={selected.documentChunks} />
              )}
              <details>
                <summary className="cursor-pointer text-[11px] text-theme-secondary">Raw JSON</summary>
                <pre className="mt-2 text-[11px] text-theme-muted whitespace-pre-wrap overflow-auto max-h-72">{JSON.stringify(selected, null, 2)}</pre>
              </details>
              {selected.__selectionType === 'edge' && <SelectedEdgeEndpoints edge={selected} />}
            </div>
          ) : <EmptyState text="Click a node or edge to inspect it." />}
        </Panel>
      </div>
    </div>
    {connectionOpen && (
      <NodeConnectionsDialog
        detail={connectionDetail}
        loading={connectionLoading}
        onClose={() => setConnectionOpen(false)}
        onSelectNode={selectConnectedNode}
      />
    )}
    </>
  );
}

function NodeConnectionsDialog({
  detail,
  loading,
  onClose,
  onSelectNode,
}: {
  detail: Record<string, any> | null;
  loading: boolean;
  onClose: () => void;
  onSelectNode: (node: Record<string, any>) => Promise<Record<string, any> | null>;
}) {
  const [selectedEdge, setSelectedEdge] = useState<Record<string, any> | null>(null);
  const [inspectedNode, setInspectedNode] = useState<Record<string, any> | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<Record<string, any> | null>(detail);
  const [expandedGraph, setExpandedGraph] = useState<ContextGraph>(() => nodeDetailToContextGraph(detail));
  const node = detail?.node ?? null;
  const nodeId = node ? String(node.id ?? '') : null;

  useEffect(() => {
    setSelectedEdge(null);
    setInspectedNode(null);
    setSelectedDetail(detail);
    setExpandedGraph(nodeDetailToContextGraph(detail));
  }, [detail, nodeId]);

  const inspectNode = async (selectedNode: Record<string, any>) => {
    setSelectedEdge(null);
    setInspectedNode(selectedNode);
    const nextDetail = await onSelectNode(selectedNode);
    if (nextDetail) {
      setSelectedDetail(nextDetail);
      setInspectedNode((nextDetail.node as Record<string, any> | undefined) ?? selectedNode);
      setExpandedGraph((current) => mergeContextGraphs(current, nodeDetailToContextGraph(nextDetail)));
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm p-4 overflow-y-auto" role="dialog" aria-modal="true" aria-label="Node connections">
      <div className="mx-auto w-full max-w-7xl rounded border border-app bg-app shadow-popover">
        <div className="flex items-start justify-between gap-3 border-b border-app p-4">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wide text-theme-muted">Node connections</div>
            <h2 className="text-base font-semibold text-theme-primary break-all">{node ? displayGraphNodeLabel(node) : 'Loading node...'}</h2>
            <div className="mt-1 text-[11px] text-theme-muted font-mono">
              {Number(expandedGraph.nodes?.length ?? 0).toLocaleString()} nodes shown · {Number(expandedGraph.edges?.length ?? 0).toLocaleString()} edges shown
              {expandedGraph.limited ? ' · limited preview' : ''}
            </div>
          </div>
          <button type="button" onClick={onClose} className="btn btn-ghost btn-sm" aria-label="Close node connections">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-4 p-4">
          <div className="min-w-0">
            <div className="h-[680px] border border-app rounded bg-app-card overflow-hidden relative">
              {loading && (
                <div className="absolute left-3 top-3 z-10 rounded border border-app bg-app-card/90 px-2 py-1 text-xs text-theme-muted animate-pulse">
                  Loading connections...
                </div>
              )}
              <ReactFlowProvider>
                <ContextReactFlow
                  graph={expandedGraph}
                  layout="dagre"
                  selectedNodeId={null}
                  selectedEdge={selectedEdge}
                  fitPadding={0.02}
                  fitMaxZoom={1.8}
                  onSelectNode={(selectedNode) => void inspectNode(selectedNode)}
                  onSelectEdge={(edge) => setSelectedEdge(edge)}
                  onExpand={(id) => {
                    const nextNode = expandedGraph.nodes?.find((item) => String(item.id ?? '') === id);
                    if (nextNode) void inspectNode(nextNode);
                  }}
                />
              </ReactFlowProvider>
            </div>
          </div>
          <div className="space-y-4 min-w-0">
            {selectedEdge ? (
              <ConnectionEdgeInspector edge={{ ...selectedEdge, ...edgeEndpointNodes(expandedGraph, selectedEdge) }} />
            ) : (
              <ConnectionNodeInspector node={inspectedNode ?? selectedDetail?.node ?? node} detail={selectedDetail} />
            )}
            <ConnectionGraphSummary graph={expandedGraph} detail={selectedDetail ?? detail} />
            <Panel title="Limits">
              <KeyValue rows={[
                ['max related nodes', detail?.limits?.maxRelatedNodes],
                ['max related edges', detail?.limits?.maxRelatedEdges],
                ['limited', detail?.limited ? 'yes' : 'no'],
              ]} />
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
}

function ConnectionNodeInspector({ node, detail }: { node: Record<string, any> | null; detail: Record<string, any> | null }) {
  const preview = String(detail?.documentPreview ?? node?.textPreview ?? '');
  const relatedEdges = Array.isArray(detail?.relatedEdges) ? detail.relatedEdges : [];
  return (
    <Panel title="Selected node">
      {node ? (
        <div className="space-y-2 text-xs">
          <div className="font-medium text-theme-primary break-all">{displayGraphNodeLabel(node)}</div>
          <KeyValue rows={[
            ['type', node.type],
            ['source path', node.sourcePath],
            ['text length', node.textLength],
            ['entity', node.entityName],
          ]} />
          {node.entityDescription && <div className="text-[11px] text-theme-muted whitespace-pre-wrap max-h-32 overflow-auto">{String(node.entityDescription)}</div>}
          {node.description && <div className="text-[11px] text-theme-muted whitespace-pre-wrap max-h-32 overflow-auto">{String(node.description)}</div>}
          {preview && (
            <div className="rounded border border-app bg-app-card/60 p-2">
              <div className="text-[10px] uppercase tracking-wide text-theme-muted mb-1">{isDocumentGraphNode(node) ? 'Document content' : 'Text preview'}</div>
              <div className="text-[11px] text-theme-primary whitespace-pre-wrap max-h-80 overflow-auto">{preview}</div>
            </div>
          )}
          <div className="rounded border border-app bg-app-card/60 p-2">
            <div className="text-[10px] uppercase tracking-wide text-theme-muted mb-1">Connected edge summaries</div>
            <div className="space-y-1 max-h-40 overflow-auto">
              {relatedEdges.slice(0, 20).map((edge: Record<string, any>, index: number) => (
                <div key={String(edge.id ?? index)} className="text-[11px] text-theme-muted">
                  <span className="font-mono text-theme-secondary">{String(edge.relationship ?? edge.label ?? 'related_to')}</span>
                  {edge.entityDescription ? <span> · {String(edge.entityDescription)}</span> : null}
                </div>
              ))}
              {!relatedEdges.length && <div className="text-[11px] text-theme-muted">No connected edges returned.</div>}
            </div>
          </div>
          <details>
            <summary className="cursor-pointer text-[11px] text-theme-secondary">Raw JSON</summary>
            <pre className="mt-2 text-[11px] text-theme-muted whitespace-pre-wrap overflow-auto max-h-52">{JSON.stringify(node, null, 2)}</pre>
          </details>
        </div>
      ) : <EmptyState text="Select a node in the graph." />}
    </Panel>
  );
}

function ConnectionEdgeInspector({ edge }: { edge: Record<string, any> }) {
  return (
    <Panel title="Selected edge">
      <div className="space-y-2 text-xs">
        <div className="font-mono text-theme-primary break-all">{String(edge.relationship ?? edge.label ?? 'related_to')}</div>
        <KeyValue rows={[
          ['source', edge.source],
          ['target', edge.target],
          ['entity', edge.entityName],
        ]} />
        <SelectedEdgeEndpoints edge={edge} />
        {edge.entityDescription && <div className="text-[11px] text-theme-muted whitespace-pre-wrap max-h-56 overflow-auto">{String(edge.entityDescription)}</div>}
        <details>
          <summary className="cursor-pointer text-[11px] text-theme-secondary">Raw JSON</summary>
          <pre className="mt-2 text-[11px] text-theme-muted whitespace-pre-wrap overflow-auto max-h-52">{JSON.stringify(edge, null, 2)}</pre>
        </details>
      </div>
    </Panel>
  );
}

function ConnectionGraphSummary({ graph, detail }: { graph: ContextGraph; detail: Record<string, any> | null }) {
  return (
    <Panel title="Neighborhood graph">
      <div className="space-y-2">
        <KeyValue rows={[
          ['nodes shown', graph.nodes?.length ?? 0],
          ['edges shown', graph.edges?.length ?? 0],
          ['source', graph.source],
          ['limited', detail?.limited ? 'yes' : 'no'],
        ]} />
        <div className="text-[11px] text-theme-muted">
          Click any node in the graph to load that node's neighborhood and content.
        </div>
      </div>
    </Panel>
  );
}

function SelectedEdgeEndpoints({ edge }: { edge: Record<string, any> }) {
  const sourceNode = edge.__sourceNode as Record<string, any> | undefined;
  const targetNode = edge.__targetNode as Record<string, any> | undefined;
  if (!sourceNode && !targetNode) return null;
  return (
    <div className="rounded border border-app bg-app-card/60 p-2">
      <div className="text-[10px] uppercase tracking-wide text-theme-muted mb-2">Selected edge nodes</div>
      <div className="space-y-2">
        {sourceNode && <EdgeEndpointCard label="Source" node={sourceNode} />}
        {targetNode && <EdgeEndpointCard label="Target" node={targetNode} />}
      </div>
    </div>
  );
}

function EdgeEndpointCard({ label, node }: { label: string; node: Record<string, any> }) {
  return (
    <div className="rounded border border-app bg-app-card p-2">
      <div className="text-[10px] uppercase tracking-wide text-theme-muted">{label}</div>
      <div className="text-xs text-theme-primary break-all">{displayGraphNodeLabel(node)}</div>
      <div className="text-[10px] text-theme-muted font-mono">{String(node.type ?? 'node')}</div>
      {node.sourcePath && <div className="text-[11px] text-theme-muted break-all">{String(node.sourcePath)}</div>}
      {node.textPreview && <div className="mt-1 text-[11px] text-theme-subtle line-clamp-3">{String(node.textPreview)}</div>}
      {node.description && <div className="mt-1 text-[11px] text-theme-subtle line-clamp-2">{String(node.description)}</div>}
    </div>
  );
}

function CuratedContextSection({ repoId, entries, onChanged }: { repoId: string; entries: Array<Record<string, any>>; onChanged: () => Promise<void> | void }) {
  const toast = useToast();
  const [filter, setFilter] = useState<'active' | 'stale' | 'all'>('all');
  const [searchDraft, setSearchDraft] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const uniqueEntries = useMemo(() => uniqueCuratedEntries(entries), [entries]);
  const [selectedId, setSelectedId] = useState(String(uniqueEntries[0]?.entryId ?? ''));
  const [draft, setDraft] = useState<CuratedEntryDraft>(() => blankCuratedDraft());
  const [saving, setSaving] = useState(false);

  const statusFiltered = uniqueEntries.filter((entry) => {
    if (filter === 'all') return true;
    if (filter === 'stale') return entry.cogneeSyncStatus === 'stale' || entry.inclusion === 'stale';
    return entry.inclusion === 'include';
  });
  const visible = statusFiltered.filter((entry) => matchesCuratedEntrySearch(entry, searchQuery));
  const isCreating = selectedId === NEW_CURATED_ENTRY_ID;
  const selected = isCreating ? null : visible.find((entry) => String(entry.entryId) === selectedId) ?? visible[0];

  useEffect(() => {
    if (isCreating) return;
    setDraft(entryToCuratedDraft(selected));
  }, [isCreating, selected?.entryId]);

  useEffect(() => {
    if (isCreating) return;
    if (!visible.length) {
      setSelectedId('');
      return;
    }
    if (!visible.some((entry) => String(entry.entryId) === selectedId)) {
      setSelectedId(String(visible[0]?.entryId ?? ''));
    }
  }, [isCreating, selectedId, visible]);

  const runSearch = () => {
    const nextQuery = searchDraft.trim();
    setSearchQuery(nextQuery);
    const nextVisible = statusFiltered.filter((entry) => matchesCuratedEntrySearch(entry, nextQuery));
    setSelectedId(String(nextVisible[0]?.entryId ?? ''));
  };

  const clearSearch = () => {
    setSearchDraft('');
    setSearchQuery('');
    setSelectedId(String(statusFiltered[0]?.entryId ?? ''));
  };

  const startNew = () => {
    setSelectedId(NEW_CURATED_ENTRY_ID);
    setDraft(blankCuratedDraft());
  };

  const save = async () => {
    if (!hasCuratedDraftContent(draft)) {
      toast.error('Add curated context, retrieval text, or at least one chunk before saving.');
      return;
    }
    setSaving(true);
    try {
      const payload = curatedDraftPayload(draft);
      const saved = isCreating
        ? await repoApi.createCuratedContextEntry(repoId, payload)
        : selected?.entryId
          ? await repoApi.updateCuratedContextEntry(repoId, String(selected.entryId), payload)
          : null;
      if (saved?.entryId) setSelectedId(String(saved.entryId));
      toast.success(isCreating ? 'Curated context entry created and marked stale.' : 'Curated context saved and marked stale.');
      await onChanged();
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to save curated context entry');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[380px_1fr] gap-4">
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1">
          {(['active', 'stale', 'all'] as const).map((item) => (
            <button key={item} type="button" onClick={() => setFilter(item)} className={`btn btn-sm ${filter === item ? 'btn-secondary' : 'btn-ghost'}`}>{item}</button>
          ))}
          <button type="button" onClick={startNew} className="btn btn-primary btn-sm ml-auto">
            <Plus className="w-3.5 h-3.5" /> New entry
          </button>
        </div>
        <div className="flex gap-1">
          <input
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch();
            }}
            className="input text-xs"
            placeholder="Search by path or name"
          />
          <button type="button" onClick={runSearch} className="btn btn-secondary btn-sm">
            <Search className="w-3.5 h-3.5" /> Search
          </button>
        </div>
        <div className="flex items-center justify-between gap-2 text-[10px] text-theme-muted font-mono">
          <span>{visible.length} / {statusFiltered.length} shown</span>
          {searchQuery && <button type="button" onClick={clearSearch} className="text-theme-secondary hover:text-theme-primary">Clear</button>}
        </div>
        <div className="border border-app rounded overflow-auto max-h-[680px]">
          {isCreating && (
            <button type="button" className="block w-full text-left px-3 py-2 border-b border-app bg-app-muted">
              <div className="text-xs text-theme-primary truncate">New curated entry</div>
              <div className="text-[10px] text-theme-muted font-mono truncate">user-added context</div>
              <div className="text-[10px] text-theme-subtle font-mono">include · snippet · stale</div>
            </button>
          )}
          {visible.length ? visible.map((entry) => {
            const entryKey = String(entry.entryId ?? entry.path ?? '');
            return (
              <button
                key={entryKey}
                type="button"
                onClick={() => setSelectedId(String(entry.entryId))}
                className={`block w-full text-left px-3 py-2 border-b border-app hover:bg-app-muted ${entryKey === String(selected?.entryId) ? 'bg-app-muted' : ''}`}
              >
                <div className="text-xs text-theme-primary truncate">{entry.title ?? entry.path}</div>
                <div className="text-[10px] text-theme-muted font-mono truncate">{entry.path}</div>
                <div className="text-[10px] text-theme-subtle font-mono">{entry.inclusion} · {entry.injectionPolicy}{entry.cogneeSyncStatus === 'stale' ? ' · stale' : ''}</div>
              </button>
            );
          }) : <div className="p-3"><EmptyState text="No curated context entries match this search." /></div>}
        </div>
      </div>
      <div className="space-y-3">
        {(selected || isCreating) ? (
          <>
            <Panel title={isCreating ? 'New curated entry' : String(selected?.title ?? selected?.path ?? selected?.entryId)}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <LabeledInput label="Title" value={draft.title} onChange={(value) => setDraft((prev) => ({ ...prev, title: value }))} />
                <LabeledInput label="Path" value={draft.path} onChange={(value) => setDraft((prev) => ({ ...prev, path: value }))} />
                <LabeledInput label="Category" value={draft.category} onChange={(value) => setDraft((prev) => ({ ...prev, category: value }))} />
                <label className="space-y-1">
                  <span className="text-[10px] uppercase tracking-wide text-theme-muted">Inclusion</span>
                  <select value={draft.inclusion} onChange={(e) => setDraft((prev) => ({ ...prev, inclusion: e.target.value }))} className="input text-xs">
                    <option value="include">include</option>
                    <option value="exclude">exclude</option>
                    <option value="stale">stale</option>
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-[10px] uppercase tracking-wide text-theme-muted">Injection policy</span>
                  <select value={draft.injectionPolicy} onChange={(e) => setDraft((prev) => ({ ...prev, injectionPolicy: e.target.value }))} className="input text-xs">
                    <option value="snippet">snippet</option>
                    <option value="manifest_only">manifest_only</option>
                    <option value="never_full_auto">never_full_auto</option>
                  </select>
                </label>
                <LabeledInput label="Summary" value={draft.summary} onChange={(value) => setDraft((prev) => ({ ...prev, summary: value }))} />
              </div>
              {!isCreating && (
                <KeyValue rows={[
                  ['entry', selected?.entryId],
                  ['Context sync', selected?.cogneeSyncStatus],
                ]} />
              )}
            </Panel>
            <EditableTextBlock
              label="Curated context"
              info={CONTEXT_FIELD_INFO.curatedContext}
              value={draft.curatedContext}
              minHeight="min-h-44"
              onChange={(value) => setDraft((prev) => ({ ...prev, curatedContext: value }))}
            />
            <EditableTextBlock
              label="Retrieval text"
              info={CONTEXT_FIELD_INFO.retrievalText}
              value={draft.retrievalText}
              minHeight="min-h-44"
              onChange={(value) => setDraft((prev) => ({ ...prev, retrievalText: value }))}
            />
            <Panel title="Chunks">
              <div className="mb-2 flex items-center justify-between gap-2">
                <FieldInfo text={CONTEXT_FIELD_INFO.curatedChunks} />
                <button type="button" onClick={() => setDraft((prev) => ({ ...prev, chunks: [...prev.chunks, newCuratedChunk(prev.chunks.length)] }))} className="btn btn-secondary btn-sm">
                  <Plus className="w-3.5 h-3.5" /> Add chunk
                </button>
              </div>
              <div className="space-y-3">
                {draft.chunks.map((chunk, index) => (
                  <div key={`${chunk.chunkId}-${index}`} className="rounded border border-app bg-app-card/60 p-2 space-y-2">
                    <div className="flex items-center gap-2">
                      <input value={chunk.heading} onChange={(e) => setDraft((prev) => updateChunkDraft(prev, index, { heading: e.target.value }))} className="input text-xs" placeholder="Chunk heading" />
                      <button type="button" onClick={() => setDraft((prev) => ({ ...prev, chunks: prev.chunks.filter((_, chunkIndex) => chunkIndex !== index) }))} className="btn btn-ghost btn-sm" title="Remove chunk">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <textarea value={chunk.text} onChange={(e) => setDraft((prev) => updateChunkDraft(prev, index, { text: e.target.value }))} className="input text-xs min-h-32 font-mono" placeholder="Chunk text" />
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                      <LabeledInput label="Target globs" value={joinCsv(chunk.targetGlobs)} onChange={(value) => setDraft((prev) => updateChunkDraft(prev, index, { targetGlobs: splitCsv(value) }))} />
                      <LabeledInput label="Target roles" value={joinCsv(chunk.targetRoles)} onChange={(value) => setDraft((prev) => updateChunkDraft(prev, index, { targetRoles: splitCsv(value) }))} />
                      <LabeledInput label="Source anchors" value={joinCsv(chunk.sourceAnchors)} onChange={(value) => setDraft((prev) => updateChunkDraft(prev, index, { sourceAnchors: splitCsv(value) }))} />
                    </div>
                  </div>
                ))}
                {!draft.chunks.length && <EmptyState text="No chunks yet." />}
              </div>
            </Panel>
            <button type="button" onClick={save} disabled={saving} className="btn btn-primary btn-sm">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} {isCreating ? 'Create entry' : 'Save curated entry'}
            </button>
          </>
        ) : <EmptyState text="No curated context entries." />}
      </div>
    </div>
  );
}

function uniqueCuratedEntries(entries: Array<Record<string, any>>): Array<Record<string, any>> {
  const byKey = new Map<string, Record<string, any>>();
  for (const entry of entries) {
    const key = String(entry.entryId ?? entry.path ?? '');
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing || entryTime(entry) >= entryTime(existing)) byKey.set(key, entry);
  }
  return Array.from(byKey.values()).sort((a, b) => String(a.path ?? a.title ?? '').localeCompare(String(b.path ?? b.title ?? '')));
}

function entryTime(entry: Record<string, any>): number {
  const value = new Date(entry.updatedAt ?? entry.createdAt ?? 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

function blankCuratedDraft(): CuratedEntryDraft {
  return {
    path: '',
    title: '',
    category: 'manual',
    inclusion: 'include',
    injectionPolicy: 'snippet',
    summary: '',
    curatedContext: '',
    retrievalText: '',
    chunks: [],
  };
}

function entryToCuratedDraft(entry?: Record<string, any> | null): CuratedEntryDraft {
  if (!entry) return blankCuratedDraft();
  return {
    entryId: entry.entryId ? String(entry.entryId) : undefined,
    path: String(entry.path ?? ''),
    title: String(entry.title ?? ''),
    category: String(entry.category ?? 'manual'),
    inclusion: String(entry.inclusion ?? 'include'),
    injectionPolicy: String(entry.injectionPolicy ?? 'snippet'),
    summary: String(entry.summary ?? ''),
    curatedContext: String(entry.curatedContext ?? ''),
    retrievalText: String(entry.retrievalText ?? ''),
    chunks: Array.isArray(entry.chunks)
      ? entry.chunks.map((chunk: Record<string, any>, index: number) => ({
        chunkId: String(chunk.chunkId ?? `chunk-${index + 1}`),
        heading: String(chunk.heading ?? `Chunk ${index + 1}`),
        targetGlobs: arrayOfStrings(chunk.targetGlobs),
        targetRoles: arrayOfStrings(chunk.targetRoles),
        sourceAnchors: arrayOfStrings(chunk.sourceAnchors),
        text: String(chunk.text ?? ''),
      }))
      : [],
  };
}

function curatedDraftPayload(draft: CuratedEntryDraft): Record<string, unknown> {
  return {
    path: draft.path.trim(),
    title: draft.title.trim(),
    category: draft.category.trim() || 'manual',
    inclusion: draft.inclusion || 'include',
    injectionPolicy: draft.injectionPolicy || 'snippet',
    summary: draft.summary.trim(),
    curatedContext: draft.curatedContext,
    retrievalText: draft.retrievalText,
    chunks: draft.chunks
      .map((chunk, index) => ({
        chunkId: chunk.chunkId || `chunk-${index + 1}`,
        heading: chunk.heading || `Chunk ${index + 1}`,
        targetGlobs: chunk.targetGlobs,
        targetRoles: chunk.targetRoles,
        sourceAnchors: chunk.sourceAnchors,
        text: chunk.text,
      }))
      .filter((chunk) => chunk.text.trim()),
  };
}

function hasCuratedDraftContent(draft: CuratedEntryDraft): boolean {
  return Boolean(draft.curatedContext.trim() || draft.retrievalText.trim() || draft.chunks.some((chunk) => chunk.text.trim()));
}

function newCuratedChunk(index: number): CuratedChunkDraft {
  return {
    chunkId: `chunk-${index + 1}`,
    heading: `Chunk ${index + 1}`,
    targetGlobs: [],
    targetRoles: [],
    sourceAnchors: [],
    text: '',
  };
}

function updateChunkDraft(draft: CuratedEntryDraft, index: number, patch: Partial<CuratedChunkDraft>): CuratedEntryDraft {
  return {
    ...draft,
    chunks: draft.chunks.map((chunk, chunkIndex) => chunkIndex === index ? { ...chunk, ...patch } : chunk),
  };
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

function splitCsv(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function joinCsv(value: string[]): string {
  return value.join(', ');
}

function FieldInfo({ text, compact = false }: { text: string; compact?: boolean }) {
  return (
    <span title={text} className="inline-flex items-center gap-1 text-[10px] text-theme-muted normal-case tracking-normal">
      <Info className="w-3.5 h-3.5" /> {!compact && 'info'}
    </span>
  );
}

function LabeledInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="space-y-1">
      <span className="text-[10px] uppercase tracking-wide text-theme-muted">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} className="input text-xs" />
    </label>
  );
}

function EditableTextBlock({
  label,
  info,
  value,
  minHeight,
  onChange,
}: {
  label: string;
  info: string;
  value: string;
  minHeight: string;
  onChange: (value: string) => void;
}) {
  return (
    <Panel title={label}>
      <div className="mb-2"><FieldInfo text={info} /></div>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} className={`input text-xs ${minHeight} font-mono`} />
    </Panel>
  );
}

function MandatoryContextSection({ repoId, agents, mappings, onChanged }: { repoId: string; agents: Array<Record<string, any>>; mappings: Array<Record<string, any>>; onChanged: () => Promise<void> | void }) {
  const toast = useToast();
  const [agentName, setAgentName] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [page, setPage] = useState(1);
  const agentOptions = useMemo(() => toAgentChatOptions(agents), [agents]);
  const visible = agentName ? mappings.filter((mapping) => mapping.agentName === agentName) : mappings;
  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageItems = visible.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  useEffect(() => {
    setPage(1);
  }, [agentName, mappings.length]);

  const saveNew = async () => {
    if (!agentName || !content.trim()) return;
    setSaving(true);
    try {
      await repoApi.saveMandatoryContext(repoId, { agentName, title: title.trim() || 'Manual mandatory context', content, sourceType: 'user_added', enabled: true });
      setTitle('');
      setContent('');
      await onChanged();
      toast.success('Mandatory context saved.');
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to save mandatory context');
    } finally {
      setSaving(false);
    }
  };

  const saveExisting = async (mapping: Record<string, any>) => {
    const mappingId = String(mapping.mappingId ?? '');
    if (!mappingId) return;
    setSaving(true);
    try {
      await repoApi.updateMandatoryContext(repoId, mappingId, { content: drafts[mappingId] ?? mapping.content ?? '', enabled: mapping.enabled !== false });
      await onChanged();
      toast.success('Mandatory context updated.');
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to update mandatory context');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[420px_1fr] gap-4">
      <div className="space-y-3">
        <Panel title="Agent filter">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => setAgentName('')} className={`btn btn-sm ${agentName ? 'btn-ghost' : 'btn-secondary'}`}>All agents</button>
              <AgentChatDropdown
                value={agentName || null}
                onChange={(name) => setAgentName(name ?? '')}
                agents={agentOptions}
                showAssistant={false}
              />
            </div>
            <div className="text-[11px] text-theme-muted font-mono">
              {agentName ? `Showing ${visible.length} mandatory context${visible.length === 1 ? '' : 's'} for ${agentName}` : `Showing all ${visible.length} mandatory contexts`}
            </div>
          </div>
        </Panel>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className="input text-xs" placeholder="Title" />
        <textarea value={content} onChange={(e) => setContent(e.target.value)} className="input text-xs min-h-36 font-mono" placeholder="Mandatory context to inject for this agent" />
        <button type="button" onClick={saveNew} disabled={saving || !agentName || !content.trim()} className="btn btn-primary btn-sm">Add mandatory context</button>
        {!agentName && <div className="text-[11px] text-theme-muted">Select an agent before adding new mandatory context.</div>}
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2 text-[11px] text-theme-muted font-mono">
          <span>{visible.length} mapping{visible.length === 1 ? '' : 's'} · page {currentPage}/{pageCount}</span>
          <div className="flex gap-1">
            <button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={currentPage <= 1} className="btn btn-ghost btn-sm">Previous</button>
            <button type="button" onClick={() => setPage((value) => Math.min(pageCount, value + 1))} disabled={currentPage >= pageCount} className="btn btn-ghost btn-sm">Next</button>
          </div>
        </div>
        {pageItems.length ? pageItems.map((mapping, index) => {
          const mappingId = String(mapping.mappingId ?? index);
          const draft = drafts[mappingId] ?? String(mapping.content ?? '');
          return (
            <Panel key={mappingId} title={String(mapping.title ?? mapping.sourcePath ?? mapping.agentName)}>
              <div className="space-y-2">
                <KeyValue rows={[
                  ['agent', mapping.agentName],
                  ['source', mapping.sourcePath],
                  ['source type', mapping.sourceType],
                  ['enabled', mapping.enabled === false ? 'no' : 'yes'],
                  ['updated', mapping.updatedAt],
                ]} />
                <textarea value={draft} onChange={(e) => setDrafts((prev) => ({ ...prev, [mappingId]: e.target.value }))} className="input text-xs min-h-32 font-mono" />
                <button type="button" onClick={() => void saveExisting(mapping)} disabled={saving} className="btn btn-ghost btn-sm">Save changes</button>
              </div>
            </Panel>
          );
        }) : <EmptyState text="No mandatory context mapped for this agent." />}
      </div>
    </div>
  );
}

function RefList({ title, refs }: { title: string; refs: Array<Record<string, any>> }) {
  return (
    <Panel title={title}>
      {refs.length ? (
        <div className="space-y-1.5 max-h-96 overflow-auto">
          {refs.slice(0, 80).map((ref, index) => (
            <div key={`${ref.refId ?? index}`} className="border border-app rounded p-2 text-[11px]">
              <div className="text-theme-primary break-all">{ref.title ?? ref.path ?? ref.refId}</div>
              <div className="text-theme-muted font-mono break-all">
                {[ref.refId, ref.providerId, ref.mandatory ? 'mandatory' : undefined, ref.rerank?.finalRank != null ? `rank ${ref.rerank.finalRank}` : undefined].filter(Boolean).join(' · ')}
              </div>
              <div className="text-theme-subtle">
                {[scoreLine(ref), ref.reason].filter(Boolean).join(' · ')}
              </div>
              <RefPlaygroundContent refItem={ref} />
            </div>
          ))}
        </div>
      ) : <EmptyState text="No refs." />}
    </Panel>
  );
}

function Diagnostics({ title, items }: { title: string; items: Array<Record<string, any>> }) {
  return (
    <Panel title={title}>
      {items.length ? (
        <div className="space-y-1 max-h-72 overflow-auto">
          {items.map((item, index) => (
            <details key={index} className="text-[11px] border border-app rounded p-2">
              <summary className="cursor-pointer">
                <span className="font-mono text-theme-secondary">{String(item.code ?? 'diagnostic')}</span>
                {item.message ? <span className="text-theme-muted"> · {String(item.message)}</span> : null}
              </summary>
              <pre className="mt-2 max-h-72 overflow-auto rounded bg-app-elevated/70 p-2 text-[10px] text-theme-muted whitespace-pre-wrap break-words">
                {JSON.stringify(item, null, 2)}
              </pre>
            </details>
          ))}
        </div>
      ) : <EmptyState text="No diagnostics." />}
    </Panel>
  );
}

function RefPlaygroundContent({ refItem }: { refItem: Record<string, any> }) {
  const playground = refItem.playgroundContent ?? {};
  const chunks = Array.isArray(playground.chunks) ? playground.chunks : [];
  if (playground.mandatoryOnly || refItem.mandatory === true) {
    return (
      <details className="mt-2">
        <summary className="cursor-pointer text-theme-secondary">View mandatory content</summary>
        <div className="mt-2 space-y-2">
          <KeyValue rows={[
            ['provider', refItem.providerId],
            ['path', playground.resolution?.path ?? refItem.path],
            ['agent', playground.resolution?.agentName],
            ['mapping', playground.resolution?.mappingId],
            ['priority', refItem.score],
          ]} />
          <TextBlock label="Mandatory context" text={playground.mandatoryContext ?? refItem.content} info={CONTEXT_FIELD_INFO.mandatoryContext} />
          <JsonPanel title="Ref JSON" value={refItem} compact />
        </div>
      </details>
    );
  }
  const hasDetails = Boolean(
    playground.cogneeChunkText
    || playground.curatedContext
    || playground.retrievalText
    || playground.selectedContent
    || playground.mandatoryContext
    || chunks.length
    || playground.resolution,
  );
  if (!hasDetails) return null;
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-theme-secondary">View resolved content and diagnostics</summary>
      <div className="mt-2 space-y-2">
        <KeyValue rows={[
          ['resolved entry', playground.resolution?.entryId],
          ['label', playground.resolution?.label],
          ['resolved path', playground.resolution?.path],
          ['resolution method', playground.resolution?.method],
          ['playground-only fallback', playground.resolution?.playgroundOnlyFallback],
          ['curation found', playground.resolution?.curationEntryFound],
          ['chunk id', refItem.providerMetadata?.cogneeChunkId ?? refItem.providerMetadata?.chunkId],
          ['dataset', refItem.providerMetadata?.datasetName],
        ]} />
        <TextBlock label="Cognee chunk text" text={playground.cogneeChunkText} info={CONTEXT_FIELD_INFO.cogneeChunkText} />
        <TextBlock label="Curated context" text={playground.curatedContext} info={CONTEXT_FIELD_INFO.curatedContext} />
        <TextBlock label="Retrieval text" text={playground.retrievalText} info={CONTEXT_FIELD_INFO.retrievalText} />
        <TextBlock label="Selected ref content" text={playground.selectedContent} info={CONTEXT_FIELD_INFO.selectedRefContent} />
        <TextBlock label="Mandatory context" text={playground.mandatoryContext} info={CONTEXT_FIELD_INFO.mandatoryContext} />
        {chunks.length ? (
          <div className="space-y-1">
            <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-theme-muted">
              <span>Curated chunks</span>
              <FieldInfo text={CONTEXT_FIELD_INFO.curatedChunks} compact />
            </div>
            {chunks.map((chunk: Record<string, any>, index: number) => (
              <TextBlock key={`${chunk.chunkId ?? index}`} label={chunk.heading ?? chunk.chunkId ?? `Chunk ${index + 1}`} text={chunk.text} info={CONTEXT_FIELD_INFO.curatedChunks} />
            ))}
          </div>
        ) : null}
        <JsonPanel title="Ref JSON" value={refItem} compact />
      </div>
    </details>
  );
}

function TextPanel({ title, text }: { title: string; text?: string }) {
  return (
    <Panel title={title}>
      <TextBlock label={title} text={text} />
    </Panel>
  );
}

function TextBlock({ label, text, info }: { label: string; text?: string; info?: string }) {
  if (!text) return null;
  return (
    <div>
      <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-theme-muted">
        <span>{label}</span>
        {info && <FieldInfo text={info} compact />}
      </div>
      <pre className="max-h-72 overflow-auto rounded border border-app bg-app-elevated/70 p-2 text-[10px] text-theme-primary whitespace-pre-wrap break-words">
        {text}
      </pre>
    </div>
  );
}

function JsonPanel({ title, value, compact = false }: { title: string; value: unknown; compact?: boolean }) {
  const body = JSON.stringify(value ?? {}, null, 2);
  const content = (
    <details>
      <summary className="cursor-pointer text-[11px] text-theme-secondary">View raw JSON</summary>
      <pre className="mt-2 max-h-96 overflow-auto rounded bg-app-elevated/70 p-2 text-[10px] text-theme-muted whitespace-pre-wrap break-words">
        {body}
      </pre>
    </details>
  );
  if (compact) return content;
  return <Panel title={title}>{content}</Panel>;
}

function RelatedNodes({ title = 'Related nodes', nodes }: { title?: string; nodes: Array<Record<string, any>> }) {
  return (
    <div className="rounded border border-app bg-app-card/60 p-2">
      <div className="text-[10px] uppercase tracking-wide text-theme-muted mb-1">{title}</div>
      <div className="space-y-1 max-h-56 overflow-auto">
        {nodes.slice(0, 12).map((node, index) => (
          <div key={String(node.id ?? index)} className="text-[11px]">
            <div className="text-theme-primary break-all">{displayGraphNodeLabel(node)}</div>
            <div className="text-theme-muted font-mono">{String(node.type ?? 'node')}</div>
            {node.description && <div className="text-theme-subtle line-clamp-2">{String(node.description)}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function KeyValue({ rows }: { rows: Array<[string, unknown]> }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
      {rows.filter(([, value]) => value !== undefined && value !== null && value !== '').map(([key, value]) => (
        <div key={key} className="rounded border border-app bg-app-card/60 p-2">
          <div className="text-[10px] uppercase tracking-wide text-theme-muted">{key}</div>
          <div className="text-[11px] text-theme-primary font-mono break-all">{String(value)}</div>
        </div>
      ))}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border border-app rounded bg-app-card/40 p-3">
      <h3 className="text-xs font-semibold text-theme-primary mb-2">{title}</h3>
      {children}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded border border-app bg-app-card/60 p-2">
      <div className="text-[10px] text-theme-muted uppercase tracking-wide">{label}</div>
      <div className="text-sm text-theme-primary font-mono truncate">{value}</div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="text-xs text-theme-muted">{text}</div>;
}

function CompactCountList({ items, labelKey }: { items: Array<Record<string, any>>; labelKey: string }) {
  return (
    <div className="flex flex-wrap gap-1">
      {items.slice(0, 12).map((item) => (
        <span key={String(item[labelKey])} className="rounded border border-app bg-app-card/60 px-1.5 py-0.5 text-[10px] text-theme-muted font-mono">
          {String(item[labelKey] ?? 'unknown')} {Number(item.count ?? 0).toLocaleString()}
        </span>
      ))}
      {!items.length && <span className="text-[11px] text-theme-muted">No counts.</span>}
    </div>
  );
}

function toAgentChatOptions(agents: Array<Record<string, any>>): AgentChatOption[] {
  return agents
    .filter((agent) => agent?.name)
    .map((agent) => ({
      name: String(agent.name),
      displayName: String(agent.name),
      icon: agent.icon ? String(agent.icon) : undefined,
      color: agent.color ? String(agent.color) : undefined,
      teamName: agent.teamName ? String(agent.teamName) : undefined,
      isBuiltIn: agent.isBuiltIn === true,
      sourceRepoPath: agent.sourceRepoPath ? String(agent.sourceRepoPath) : undefined,
    }));
}

function matchesCuratedEntrySearch(entry: Record<string, any>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const path = String(entry.path ?? '');
  const basename = path.split('/').filter(Boolean).pop() ?? path;
  return [
    path,
    basename,
    entry.title,
    entry.name,
    entry.entryId,
  ].some((value) => String(value ?? '').toLowerCase().includes(q));
}

function isContextLiveBuild(status?: CogneeStatus | null): boolean {
  return status?.status === 'running'
    || status?.stage === 'pulling'
    || status?.stage === 'collecting_curated_context'
    || status?.stage === 'collecting_markdown'
    || status?.stage === 'ingesting'
    || status?.stage === 'cognifying'
    || status?.workerActive === true;
}

function contextBuildStageLabel(status: CogneeStatus): string {
  if (status.status === 'failed') return 'Context build failed';
  if (status.status === 'partial') return 'Context build partially completed';
  if (status.status === 'stopped') return 'Context build stopped';
  if (status.stage === 'pulling') return 'Pulling latest repo context';
  if (status.stage === 'collecting_curated_context' || status.stage === 'collecting_markdown') return 'Collecting curated context entries';
  if (status.stage === 'ingesting') return 'Ingesting context documents';
  if (status.stage === 'cognifying') return 'Cognifying context graph';
  if (status.stage === 'completed' || status.status === 'completed') return 'Context build completed';
  return 'Context build running';
}

function contextBuildProgressPercent(status: CogneeStatus): number | undefined {
  if (status.status === 'completed') return 100;
  if (status.status === 'failed' || status.status === 'stopped') return undefined;
  if (status.stage === 'cognifying') {
    const total = statusNumber(status.documentCount);
    const done = statusNumber(status.cognifiedDocumentCount ?? status.processedDocumentCount);
    return progressPercent(done, total);
  }
  if (status.stage === 'ingesting') {
    const total = ingestProgressTotal(status);
    const done = statusNumber(status.ingestedDocumentCount ?? status.processedDocumentCount);
    return progressPercent(done, total);
  }
  if (status.stage === 'collecting_curated_context' || status.stage === 'collecting_markdown') return 10;
  if (status.stage === 'pulling') return 5;
  return undefined;
}

function progressPercent(done?: number, total?: number): number | undefined {
  if (done == null || total == null || total <= 0) return undefined;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

function statusNumber(value: unknown): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function formatCount(value: unknown): string {
  const num = statusNumber(value);
  return num == null ? '-' : num.toLocaleString();
}

function ingestProgressTotal(status: CogneeStatus): number | undefined {
  const toIngest = statusNumber(status.documentsToIngestCount);
  const ingested = statusNumber(status.ingestedDocumentCount);
  const documents = statusNumber(status.documentCount);
  if (toIngest != null && toIngest > 0) return toIngest;
  if (ingested != null && documents != null && (toIngest == null || ingested > toIngest)) return documents;
  return toIngest ?? documents;
}

function scoreLine(ref: Record<string, any>): string | undefined {
  if (ref.mandatory === true) {
    return ref.score != null ? `mandatory priority ${Number(ref.score).toFixed(0)}` : undefined;
  }
  const parts = [
    ref.score != null ? `score ${Number(ref.score).toFixed(3)}` : undefined,
    ref.rerank?.rerankScore != null ? `rerank ${Number(ref.rerank.rerankScore).toFixed(3)}` : undefined,
    ref.rerank?.finalRelevanceScore != null ? `final ${Number(ref.rerank.finalRelevanceScore).toFixed(3)}` : undefined,
    ref.providerMetadata?.rejectionReason ? `filtered ${String(ref.providerMetadata.rejectionReason)}` : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}
