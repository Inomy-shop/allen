import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Check, Inbox, Play } from 'lucide-react';
import { executions as executionsApi, workflows as workflowsApi } from '../services/api';
import { mergeExecutionSnapshot, snapshotFromExecution, useExecutionStore } from '../stores/executionStore';
import WorkflowRunDialog from '../components/workflow/WorkflowRunDialog';
import WorkflowBuilderPage from './WorkflowBuilderPage';
import {
  workflowDescription,
  workflowEdges,
  workflowInput,
  workflowName,
  workflowNodes,
} from '../utils/workflowShape';

type WorkflowTab = 'description' | 'visual' | 'runs' | 'edit';

type NormalizedEdge = { from: string; to: string; condition?: string; parallel?: boolean };

function DetailIcon({ name }: { name: 'back' | 'refresh' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      {name === 'back'
        ? <><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></>
        : <><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></>}
    </svg>
  );
}

function normalizedEdges(workflow: any): NormalizedEdge[] {
  return workflowEdges(workflow).flatMap((edge: any) => {
    const from = Array.isArray(edge?.from ?? edge?.source) ? (edge.from ?? edge.source) : [edge?.from ?? edge?.source];
    const to = Array.isArray(edge?.to ?? edge?.target) ? (edge.to ?? edge.target) : [edge?.to ?? edge?.target];
    return from.flatMap((source: unknown) => to.map((target: unknown) => ({
      from: String(source ?? ''),
      to: String(target ?? ''),
      condition: edge?.condition ?? edge?.when ?? edge?.label,
      parallel: Boolean(edge?.parallel),
    }))).filter((item: NormalizedEdge) => item.from && item.to);
  });
}

function conditionLabel(condition?: string): string {
  if (!condition) return '';
  const values = Array.from(condition.matchAll(/(?:==|===)\s*['"]([^'"]+)['"]/g)).map(match => match[1]);
  if (values.length > 0) return Array.from(new Set(values)).join(' · ');
  return condition
    .replace(/human\.([^.]+)\.latest\.decision\s*==\s*/g, '')
    .replace(/__retry_exhausted_from\s*==\s*/g, 'retry exhausted: ')
    .replace(/["']/g, '')
    .replace(/\s+(AND|OR)\s+/gi, ' · ')
    .slice(0, 46);
}

function orderedNodeEntries(workflow: any): Array<[string, any]> {
  const nodes = workflowNodes(workflow);
  const entries = Object.entries(nodes) as Array<[string, any]>;
  const order = new Map(entries.map(([key], index) => [key, index]));
  const incoming = new Map(entries.map(([key]) => [key, 0]));
  const outgoing = new Map(entries.map(([key]) => [key, [] as string[]]));
  for (const edge of normalizedEdges(workflow)) {
    if (!nodes[edge.from] || !nodes[edge.to] || edge.from === edge.to) continue;
    outgoing.get(edge.from)?.push(edge.to);
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }
  const queue = entries.filter(([key]) => incoming.get(key) === 0).map(([key]) => key);
  const result: string[] = [];
  while (queue.length) {
    queue.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    const key = queue.shift()!;
    result.push(key);
    for (const next of outgoing.get(key) ?? []) {
      incoming.set(next, (incoming.get(next) ?? 1) - 1);
      if (incoming.get(next) === 0) queue.push(next);
    }
  }
  for (const [key] of entries) if (!result.includes(key)) result.push(key);
  return result.map(key => [key, nodes[key]]);
}

function routeLanes(workflow: any): Array<{ label: string; path: string; note: string }> {
  const nodes = workflowNodes(workflow);
  const edges = normalizedEdges(workflow);
  const values = Array.from(new Set(edges.flatMap(edge =>
    Array.from((edge.condition ?? '').matchAll(/(?:==|===)\s*['"]([^'"]+)['"]/g)).map(match => match[1]),
  ))).filter(value => !['approve', 'reject', 'request_changes', 'pass', 'fail', 'true', 'false'].includes(value));
  return values.slice(0, 6).map(value => {
    const relevant = edges.filter(edge => !edge.condition || edge.condition.includes(`'${value}'`) || edge.condition.includes(`"${value}"`));
    const next = new Map<string, string[]>();
    for (const edge of relevant) next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
    const starts = next.get('START') ?? orderedNodeEntries(workflow).slice(0, 1).map(([key]) => key);
    const seen = new Set<string>();
    const queue = [...starts];
    while (queue.length && seen.size < Object.keys(nodes).length) {
      const key = queue.shift()!;
      if (key === 'END' || seen.has(key) || !nodes[key]) continue;
      seen.add(key);
      queue.push(...(next.get(key) ?? []));
    }
    const ordered = orderedNodeEntries(workflow).map(([key]) => key);
    const path = ordered.filter(key => seen.has(key)).map(key => nodeTitle(key, nodes[key]).toLowerCase()).join(' → ');
    const skipped = ordered.filter(key => !seen.has(key));
    return { label: value, path: path || 'evaluated at runtime', note: skipped.length ? `skips ${skipped.slice(0, 4).map(key => nodeTitle(key, nodes[key]).toLowerCase()).join(', ')}${skipped.length > 4 ? ', …' : ''}` : 'every node runs' };
  });
}

function runId(run: any): string {
  return String(run?.id ?? run?._id ?? '');
}

function runStatus(run: any): string {
  return String(run?.status ?? 'queued').toLowerCase();
}

function runSummary(run: any, fallback: string): string {
  return String(
    run?.title
    ?? run?.summary
    ?? run?.input?.title
    ?? run?.input?.task
    ?? run?.meta?.title
    ?? run?.workflowName
    ?? fallback,
  );
}

function runSource(run: any): string {
  if (run?.chat?.sessionId ?? run?.meta?.chatSessionId) return 'chat';
  if (run?.linearIssueId ?? run?.meta?.linearIssueId) return 'linear';
  return String(run?.source ?? run?.meta?.source ?? 'manual');
}

function runTokens(run: any): string {
  const tokens = Number(
    run?.tokenUsage?.totalTokens
    ?? run?.usage?.totalTokens
    ?? run?.tokens
    ?? 0,
  );
  if (!Number.isFinite(tokens) || tokens <= 0) return '—';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tok`;
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tok` : `${tokens} tok`;
}

function runDate(run: any): string {
  const date = new Date(run?.startedAt ?? run?.createdAt ?? 0);
  if (!Number.isFinite(date.getTime()) || date.getTime() === 0) return '—';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function nodeActor(node: any): string {
  return String(node?.agent ?? node?.agentName ?? node?.config?.agent ?? (node?.type === 'human' ? 'you' : node?.provider ?? 'engine'));
}

function nodeModel(node: any): string | null {
  const model = node?.model ?? node?.runtime_model ?? node?.config?.model ?? node?.config?.runtime_model;
  return model ? String(model) : null;
}

function nodeTitle(key: string, node: any): string {
  return String(node?.label ?? node?.title ?? node?.name ?? key)
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}

function nodeType(node: any): 'agent' | 'human' | 'cond' | 'code' {
  const type = String(node?.type ?? 'agent').toLowerCase();
  if (type === 'human') return 'human';
  if (type === 'condition' || type === 'conditional' || type === 'branch') return 'cond';
  if (type === 'code' || type === 'script') return 'code';
  return 'agent';
}

function WorkflowVisual({ workflow, id }: { workflow: any; id: string }) {
  const entries = orderedNodeEntries(workflow);
  const nodes = workflowNodes(workflow);
  const edges = normalizedEdges(workflow).filter(edge => nodes[edge.from] && nodes[edge.to]);
  const dense = entries.length > 10;
  const cardWidth = 220;
  const cardHeight = 52;
  const colGap = dense ? 70 : 54;
  const rowGap = 62;
  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const incoming = new Map(entries.map(([key]) => [key, edges.filter(edge => edge.to === key).map(edge => edge.from)]));
  const getRank = (key: string): number => {
    if (rank.has(key)) return rank.get(key)!;
    if (visiting.has(key)) return 0;
    visiting.add(key);
    const predecessors = incoming.get(key) ?? [];
    const value = predecessors.length ? Math.max(...predecessors.map(getRank)) + 1 : 0;
    visiting.delete(key);
    rank.set(key, Math.min(value, entries.length));
    return rank.get(key)!;
  };
  entries.forEach(([key]) => getRank(key));
  const layers = new Map<number, string[]>();
  entries.forEach(([key]) => layers.set(rank.get(key) ?? 0, [...(layers.get(rank.get(key) ?? 0) ?? []), key]));
  const renderLayers = Array.from(layers.entries()).sort(([a], [b]) => a - b).flatMap(([layerRank, keys]) => {
    const maxPerRow = dense ? 3 : Math.max(1, keys.length);
    return Array.from({ length: Math.ceil(keys.length / maxPerRow) }, (_, index) => [layerRank, keys.slice(index * maxPerRow, (index + 1) * maxPerRow)] as const);
  });
  const maxCols = Math.max(1, ...renderLayers.map(([, layer]) => layer.length));
  const width = dense ? 856 : Math.max(640, 48 * 2 + maxCols * cardWidth + (maxCols - 1) * colGap);
  const height = Math.max(160, 30 * 2 + renderLayers.length * cardHeight + (renderLayers.length - 1) * rowGap);
  const markerId = `v8-flow-arrow-${id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const positions = new Map<string, { x: number; y: number; row: number }>();
  renderLayers.forEach(([, keys], row) => {
    const rowWidth = keys.length * cardWidth + (keys.length - 1) * colGap;
    keys.forEach((key, column) => positions.set(key, { x: (width - rowWidth) / 2 + column * (cardWidth + colGap), y: 30 + row * (cardHeight + rowGap), row }));
  });

  return (
    <div className={`v8-workflow-visual ${dense ? 'ensemble' : ''}`}>
      {entries.length === 0 ? <div className="v8-filter-empty">No nodes are defined.</div> : (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${workflowName(workflow)} flow`}>
          <defs>
            <marker id={markerId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path className="v8-flow-arrow" d="M0 0 L8 4 L0 8 z" />
            </marker>
          </defs>
          {edges.map((edge, index) => {
            const from = positions.get(edge.from)!;
            const to = positions.get(edge.to)!;
            const down = to.y > from.y;
            const startX = from.x + cardWidth / 2;
            const startY = down ? from.y + cardHeight : from.y + cardHeight / 2;
            const endX = to.x + cardWidth / 2;
            const endY = down ? to.y - 4 : to.y + cardHeight / 2;
            const isSkipPath = Math.abs(to.row - from.row) > 1;
            if (isSkipPath) {
              const useRight = index % 2 === 0;
              const gutterX = useRight ? width - 38 - (index % 3) * 10 : 38 + (index % 3) * 10;
              const branchStartX = useRight ? from.x + cardWidth : from.x;
              const branchEndX = useRight ? to.x + cardWidth + 4 : to.x - 4;
              const branchStartY = from.y + cardHeight / 2;
              const branchEndY = to.y + cardHeight / 2;
              const label = conditionLabel(edge.condition);
              const labelX = useRight ? gutterX - 8 : gutterX + 8;
              const labelY = branchStartY + (branchEndY - branchStartY) / 2;
              return <g key={`${edge.from}-${edge.to}-${index}`}><path className="v8-flow-edge conditional branch" d={`M${branchStartX} ${branchStartY} H${gutterX} V${branchEndY} H${branchEndX}`} markerEnd={`url(#${markerId})`} />{label && <text className={`v8-flow-edge-label ${useRight ? 'right' : 'left'}`} x={labelX} y={labelY}>{label}</text>}</g>;
            }
            const midY = down ? startY + (endY - startY) / 2 : startY - 18 - (index % 3) * 9;
            const d = `M${startX} ${startY} V${midY} H${endX} V${endY}`;
            const label = conditionLabel(edge.condition);
            return <g key={`${edge.from}-${edge.to}-${index}`}><path className={`v8-flow-edge ${edge.condition ? 'conditional' : ''}`} d={d} markerEnd={`url(#${markerId})`} />{label && <text className="v8-flow-edge-label" x={(startX + endX) / 2 + 4} y={midY - 5}>{label}</text>}</g>;
          })}
          {entries.map(([key, node], index) => {
            const position = positions.get(key)!;
            const type = nodeType(node);
            return (
              <g key={key} className={`v8-flow-node ${type}`} transform={`translate(${position.x},${position.y})`}>
                <rect width={cardWidth} height={cardHeight} rx="10" />
                <text className="kind" x="12" y="15">{type === 'cond' ? 'condition' : type}</text>
                <text className="title" x="12" y="31">{nodeTitle(key, node).slice(0, 29)}</text>
                <text className="actor" x="12" y="44">{nodeActor(node).slice(0, 34)}</text>
              </g>
            );
          })}
        </svg>
      )}
      <div className="v8-workflow-legend">
        <span><i className="agent" />agent</span><span><i className="human" />human gate</span>
        <span><i className="cond" />condition</span><span><i className="code" />code / conditional path</span>
      </div>
    </div>
  );
}

export default function WorkflowDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const tab: WorkflowTab = requestedTab === 'visual' || requestedTab === 'runs' || requestedTab === 'edit'
    ? requestedTab
    : 'description';
  const [workflow, setWorkflow] = useState<any | null>(null);
  const [runs, setRuns] = useState<any[]>([]);
  const [runsTotal, setRunsTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runsLoading, setRunsLoading] = useState(true);
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const snapshots = useExecutionStore(state => state.entities);

  const loadWorkflow = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try { setWorkflow(await workflowsApi.get(id)); setLoadError(null); }
    catch (error) { setWorkflow(null); setLoadError(error instanceof Error ? error.message : 'Failed to load workflow'); }
    finally { setLoading(false); }
  }, [id]);

  const loadRuns = useCallback(async () => {
    if (!id) return;
    setRunsLoading(true);
    try {
      const result = await executionsApi.listPaged({ workflowId: id, type: 'workflow', limit: 100, offset: 0, includeTotal: true, enrich: true });
      setRuns(result.items);
      setRunsTotal(result.total ?? result.items.length);
      useExecutionStore.getState().ingestMany(result.items.map(item => snapshotFromExecution(item)).filter(Boolean) as any[]);
    } finally { setRunsLoading(false); }
  }, [id]);

  useEffect(() => { void loadWorkflow(); }, [loadWorkflow]);
  useEffect(() => { void loadRuns(); }, [loadRuns]);

  const liveRuns = useMemo(() => runs.map(run => mergeExecutionSnapshot(run, snapshots[runId(run)])), [runs, snapshots]);
  const nodes = useMemo(() => workflowNodes(workflow), [workflow]);
  const edges = useMemo(() => workflowEdges(workflow), [workflow]);
  const input = useMemo(() => workflowInput(workflow), [workflow]);
  const nodeEntries = orderedNodeEntries(workflow);
  const inputs = Object.keys(input);
  const agents = Array.from(new Set(nodeEntries.filter(([, node]) => nodeType(node) === 'agent').map(([, node]) => nodeActor(node))));
  const humanGates = nodeEntries.filter(([, node]) => nodeType(node) === 'human').length;
  const name = workflow ? workflowName(workflow) : 'Workflow';
  const description = workflow ? workflowDescription(workflow) : '';
  const isValid = workflow?.validation?.valid !== false;
  const isEnsemble = nodeEntries.length > 10 || /ensemble|multi-model/i.test(name);
  const isReviewedGrowthEnsemble = name === 'growth-strategy-reviewed-ensemble';
  const models = Array.from(new Set(nodeEntries.map(([, node]) => nodeModel(node)).filter((model): model is string => Boolean(model))));
  const lanes = routeLanes(workflow);
  const ensembleStages = isEnsemble
    ? [
      { title: 'Stage 1 — ground it in research', nodes: nodeEntries.slice(0, Math.ceil(nodeEntries.length / 3)) },
      { title: 'Stage 2 — parallel drafts and cross-model reviews', nodes: nodeEntries.slice(Math.ceil(nodeEntries.length / 3), Math.ceil(nodeEntries.length * 2 / 3)) },
      { title: 'Stage 3 — synthesize and approve', nodes: nodeEntries.slice(Math.ceil(nodeEntries.length * 2 / 3)) },
    ]
    : [];

  function setTab(next: WorkflowTab) {
    const params = new URLSearchParams(searchParams);
    if (next === 'description') params.delete('tab'); else params.set('tab', next);
    setSearchParams(params);
  }

  async function downloadYaml() {
    const yaml = await workflowsApi.exportYaml(id);
    const url = URL.createObjectURL(new Blob([yaml], { type: 'text/yaml' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${name}.yaml`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (tab === 'edit') return <div className="h-full w-full overflow-hidden"><WorkflowBuilderPage embedded onBack={() => setTab('description')} /></div>;

  if (loading) return <div className="v8-page"><div className="v8-page__wrap v8-workflow-detail__loading">Loading workflow…</div></div>;
  if (!workflow) return (
    <div className="v8-page"><div className="v8-page__wrap"><Link className="v8-workflow-detail__crumb" to="/workflows"><DetailIcon name="back" />Workflows</Link><div className="v8-empty v8-empty--visible"><span className="glyph"><Inbox /></span><h2>{loadError ? 'Couldn’t load workflow' : 'Workflow not found'}</h2>{loadError && <p>{loadError}</p>}<button className="v8-btn v8-btn--ghost" type="button" onClick={() => void loadWorkflow()}>Try again</button></div></div></div>
  );

  return (
    <div className={`v8-page v8-workflow-detail ${isEnsemble ? 'ensemble' : ''}`} data-screen-label="workflow-detail">
      <div className="v8-page__wrap">
        <Link className="v8-workflow-detail__crumb" to="/workflows"><DetailIcon name="back" />Workflows</Link>
        <header className="v8-pagehead v8-workflow-detail__head">
          <div>
            <h1>{name} <span className={isValid ? 'valid' : 'invalid'}><Check />{isValid ? 'valid' : 'invalid'}</span></h1>
            <p>{nodeEntries.length} nodes · {edges.length} edges · v{workflow.version ?? 1} · {runsTotal} runs{isEnsemble && humanGates === 1 ? ' · one human gate' : ''}</p>
          </div>
          <button className="v8-icon-chip" type="button" aria-label="Refresh" onClick={() => { void loadWorkflow(); void loadRuns(); }}><DetailIcon name="refresh" /></button>
          <button className="v8-btn v8-btn--ghost" type="button" onClick={() => void downloadYaml()}>YAML</button>
          <button className="v8-btn v8-btn--ghost" type="button" onClick={() => setTab('edit')}>Edit</button>
          <button className="v8-btn v8-btn--ink" type="button" disabled={!isValid} onClick={() => setRunDialogOpen(true)}>Run</button>
        </header>

        <nav className="v8-tabs v8-workflow-detail__tabs">
          <button type="button" className={tab === 'description' ? 'on' : ''} onClick={() => setTab('description')}>Description</button>
          <button type="button" className={tab === 'visual' ? 'on' : ''} onClick={() => setTab('visual')}>Visual</button>
          <button type="button" className={tab === 'runs' ? 'on' : ''} onClick={() => setTab('runs')}>Runs <span>{runsTotal}</span></button>
        </nav>

        {tab === 'description' && (
          <div className="v8-workflow-detail__description">
            <section className="v8-workflow-detail__copy">
              {isReviewedGrowthEnsemble ? (
                <>
                  <p><b>What it does:</b> turns one growth objective into a single reviewed strategy — by making three models compete on the same brief and letting a different model criticize each draft. You approve exactly once, at the end.</p>
                  <div className="v8-workflow-stage-copy">
                    <h2>Stage 1 — ground it in research</h2>
                    <p>It loads your growth briefs from Drive, runs live market research (<b>market-intelligence-analyst</b>), and fact-checks it (<b>marketing-analyst</b>). At most one revision — must-fix items only.</p>
                  </div>
                  <div className="v8-workflow-stage-copy">
                    <h2>Stage 2 — three drafts, cross-model reviews</h2>
                    <p>Three <b>strategy-brainstormers</b> draft the identical brief in parallel on <span className="v8-provider-dot claude">●</span> Opus 4.8, <span className="v8-provider-dot openai">●</span> GPT-5.5, and <span className="v8-provider-dot glm">●</span> GLM-5.2. Each draft is reviewed by a <i>different</i> model than wrote it — GLM judges the Opus draft, Claude judges GPT, GPT judges GLM — so no model grades its own homework. Each branch gets at most one revision, then marks itself complete.</p>
                  </div>
                  <div className="v8-workflow-stage-copy">
                    <h2>Stage 3 — synthesize &amp; approve</h2>
                    <p>A consistency check audits the surviving drafts, the <b>marketing-lead</b> merges them into one strategy, the <b>ceo</b> agent gives an executive review, and then it waits for <b>you</b>. &quot;Request changes&quot; loops back to the marketing-lead without re-triggering the AI critics.</p>
                  </div>
                  <div className="v8-workflow-stage-copy">
                    <h2>If things fail</h2>
                    <p>Every draft branch tolerates failure — a crashed or timed-out model never blocks the others. The guard needs only <b>one usable draft</b> to proceed; if all three die, the run ends cleanly instead of synthesizing from nothing. Unresolved review feedback is carried forward into synthesis rather than looping forever.</p>
                  </div>
                </>
              ) : (
                <p><b>What it does:</b> {description || 'No description provided.'}</p>
              )}
              {!isReviewedGrowthEnsemble && (isEnsemble ? ensembleStages.map(stage => (
                <div className="v8-workflow-stage-copy" key={stage.title}>
                  <h2>{stage.title}</h2>
                  <p>{stage.nodes.map(([key, node]) => `${nodeTitle(key, node)} (${nodeActor(node)}${nodeModel(node) ? ` · ${nodeModel(node)}` : ''})`).join(' · ')}</p>
                </div>
              )) : nodeEntries.length > 0 && <><h2>The flow</h2><ol>{nodeEntries.map(([key, node]) => <li key={key}><b>{nodeActor(node)}</b> — {nodeTitle(key, node)}</li>)}</ol></>)}
              {!isEnsemble && lanes.length > 0 && <><h2>Routing by condition</h2>{lanes.map(lane => <div className="v8-workflow-lane" key={lane.label}><span><i />{lane.label}</span><b>{lane.path}</b><em>{lane.note}</em></div>)}</>}
            </section>
            <aside className="v8-workflow-detail__aside">
              <section><h3>structure</h3><dl><div><dt>nodes</dt><dd>{nodeEntries.length}</dd></div><div><dt>edges</dt><dd>{edges.length}</dd></div>{!isEnsemble && <div><dt>inputs</dt><dd>{inputs.length}</dd></div>}<div><dt>human gates</dt><dd>{humanGates}</dd></div><div><dt>version</dt><dd>v{workflow.version ?? 1}</dd></div>{isEnsemble && <><div><dt>runs</dt><dd>{runsTotal}</dd></div><div><dt>parallel branches</dt><dd>3</dd></div></>}</dl></section>
              {isEnsemble && <section><h3>models</h3>{isReviewedGrowthEnsemble ? (
                <>
                  <p className="model model-0">claude-opus-4.8 · draft + synth</p>
                  <p className="model model-1">gpt-5.5 · draft + review</p>
                  <p className="model model-2">glm-5.2 · draft + review</p>
                </>
              ) : models.length > 0 ? models.map((model, index) => <p className={`model model-${index % 3}`} key={model}>{model}</p>) : <p className="muted">runtime defaults</p>}</section>}
              <section><h3>inputs</h3>{inputs.length > 0 ? inputs.map(key => <p key={key}>{key}{input[key]?.required === true ? ' *' : ''}</p>) : <p className="muted">none</p>}</section>
              {isReviewedGrowthEnsemble && <section><h3>limits</h3><dl><div><dt>draft timeout</dt><dd>8 min</dd></div><div><dt>review timeout</dt><dd>5 min</dd></div><div><dt>revisions / review</dt><dd>≤ 1</dd></div></dl></section>}
              {!isEnsemble && <section><h3>agents · {agents.length}</h3>{agents.length > 0 ? agents.map(agent => <p key={agent}>{agent}</p>) : <p className="muted">none</p>}</section>}
              {!isEnsemble && <section><h3>recent runs</h3>{liveRuns.slice(0, 3).map(run => <button key={runId(run)} type="button" onClick={() => navigate(`/executions/${runId(run)}`)}>{runId(run).slice(0, 12)} · {runStatus(run)}</button>)}{!runsLoading && liveRuns.length === 0 && <p className="muted">none yet</p>}</section>}
            </aside>
          </div>
        )}

        {tab === 'visual' && <WorkflowVisual workflow={workflow} id={id} />}

        {tab === 'runs' && (
          <div className="v8-workflow-runs">
            {runsLoading ? <div className="v8-filter-empty">Loading runs…</div> : liveRuns.length > 0 ? liveRuns.map(run => {
              const status = runStatus(run);
              return <button className={`v8-workflow-run ${status}`} key={runId(run)} type="button" onClick={() => navigate(`/executions/${runId(run)}`)}><i /><code>{runId(run).slice(0, 12)}</code><span className="status">{status}</span><span className="summary">{runSummary(run, name)}</span><span className="source">{runSource(run)}</span><span className="tokens">{runTokens(run)}</span><time>{runDate(run)}</time></button>;
            }) : <div className="v8-empty"><span className="glyph"><Inbox /></span><h2>No runs yet</h2><p>Run this workflow and every execution lands here with tokens, cost, and checkpoints.</p><button className="v8-btn v8-btn--ink" type="button" onClick={() => setRunDialogOpen(true)}><Play />Run workflow</button></div>}
            <p className="v8-page-foot">{liveRuns.length} most recent of {runsTotal} · from live executions</p>
          </div>
        )}
      </div>

      {runDialogOpen && <WorkflowRunDialog workflow={workflow} onClose={() => setRunDialogOpen(false)} onStarted={execution => { setRunDialogOpen(false); navigate(`/executions/${execution.id}`); }} />}
    </div>
  );
}
