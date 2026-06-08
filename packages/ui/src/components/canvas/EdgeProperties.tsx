import { useEffect, useState } from 'react';
import type { Edge } from '@xyflow/react';
import { Trash2, Plus, X } from 'lucide-react';
import Select from '../common/Select';
import type { EdgeSemantics } from '../../lib/edge-semantics';

interface Props {
  edge: Edge;
  onUpdate: (id: string, data: EdgeSemantics) => void;
  onDelete: (id: string) => void;
  /** Collapse (hide) the properties sidebar. */
  onClose?: () => void;
}

const JOIN_OPTIONS = [
  { value: 'wait-all', label: 'wait-all', sublabel: 'continue when every branch finishes' },
  { value: 'wait-any', label: 'wait-any', sublabel: 'continue when the first branch finishes' },
  { value: 'fail-fast', label: 'fail-fast', sublabel: 'abort the join if any branch fails' },
];

const MERGE_STRATEGIES = ['last', 'concat', 'min', 'max', 'all', 'any'];

type MergeRow = { key: string; strategy: string };

function mergeToRows(merge: EdgeSemantics['merge']): MergeRow[] {
  if (!merge || typeof merge !== 'object') return [];
  return Object.entries(merge).map(([key, strategy]) => ({ key, strategy: String(strategy) }));
}

function rowsToMerge(rows: MergeRow[]): EdgeSemantics['merge'] {
  const out: Record<string, any> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key) out[key] = row.strategy;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Right-rail editor for the control-flow semantics carried on a workflow
 * edge: condition, parallel fan-out + join/merge, and retry loops
 * (max_retries + retry_context). Mirrors the `EdgeDef` schema so anything
 * authorable in YAML is authorable here.
 */
export default function EdgeProperties({ edge, onUpdate, onDelete, onClose }: Props) {
  const [local, setLocal] = useState<EdgeSemantics>({});
  // Merge rows kept locally so a blank key survives mid-edit (blank keys are
  // dropped only when serialized to the edge's merge map). Re-seeded per edge.
  const [mergeRows, setMergeRowsState] = useState<MergeRow[]>([]);

  // Seed when a different edge is selected. Deliberately keyed to edge.id
  // only: re-seeding on every edge.data change would re-strip the merge rows
  // (dropping blank keys mid-edit) and clobber in-progress typing.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setLocal({ ...(edge.data as EdgeSemantics) });
    setMergeRowsState(mergeToRows((edge.data as EdgeSemantics)?.merge));
  }, [edge.id]);

  const update = (patch: Partial<EdgeSemantics>) => {
    const next: EdgeSemantics = { ...local, ...patch };
    setLocal(next);
    onUpdate(edge.id, next);
  };

  const isRetry = local.max_retries != null;
  const isParallel = !!local.parallel;
  const routingKind = isRetry ? 'retry' : local.condition ? 'conditional' : isParallel ? 'parallel' : 'auto';

  const setMergeRows = (rows: MergeRow[]) => {
    setMergeRowsState(rows);
    update({ merge: rowsToMerge(rows) });
  };

  return (
    <div className="p-4 space-y-4 overflow-auto h-full">
      <div className="flex items-center justify-between">
        <h3 className="font-heading text-sm font-semibold text-theme-primary tracking-wider">Edge</h3>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={() => onDelete(edge.id)} className="btn-ghost text-xs text-accent-red hover:text-accent-red/80 p-1" title="Delete edge">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          {onClose && (
            <button onClick={onClose} title="Close panel" className="btn-ghost p-1 text-theme-muted hover:text-theme-primary">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* From → To */}
      <div className="flex items-center gap-2 text-xs font-mono">
        <span className="px-1.5 py-0.5 rounded-sm bg-app-muted text-theme-secondary truncate">{edge.source}</span>
        <span className="text-theme-muted">→</span>
        <span className="px-1.5 py-0.5 rounded-sm bg-app-muted text-theme-secondary truncate">{edge.target}</span>
      </div>

      <div className="flex items-center gap-2">
        <span className="overline">routing</span>
        <span className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded-sm bg-accent-blue/10 text-accent-blue">
          {routingKind}
        </span>
      </div>

      {/* Condition */}
      <div>
        <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Condition</label>
        <textarea
          className="input w-full text-xs h-20 resize-none font-mono"
          value={local.condition ?? ''}
          onChange={e => update({ condition: e.target.value || undefined })}
          placeholder={'e.g. nodes.review.status == "approved"'}
        />
        <p className="text-[10px] text-theme-subtle font-body mt-1 leading-relaxed">
          Filtrex expression. The edge is only taken when it evaluates truthy. Supports
          <code className="bg-app-muted px-1 rounded mx-0.5">and / or / not</code>,
          comparisons, <code className="bg-app-muted px-1 rounded">in</code>, and dotted state paths.
        </p>
      </div>

      {/* Parallel fan-out */}
      <div className="border-t border-app pt-3">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={isParallel}
            onChange={e => update({
              parallel: e.target.checked || undefined,
              join: e.target.checked ? (local.join ?? 'wait-all') : undefined,
              merge: e.target.checked ? local.merge : undefined,
            })}
            className="w-3.5 h-3.5 rounded-sm bg-surface-200 border-accent-blue/30 accent-accent-blue"
          />
          <label className="text-xs text-theme-secondary font-label">Parallel branch</label>
        </div>
        <p className="text-[10px] text-theme-subtle font-body mt-1 leading-relaxed">
          Mark every edge leaving <span className="font-mono">{edge.source}</span> as parallel to fork into
          concurrent branches. Join + merge below apply where the branches reconverge.
        </p>

        {isParallel && (
          <div className="mt-3 space-y-3">
            {/* Join */}
            <div>
              <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Join policy</label>
              <Select
                value={local.join ?? 'wait-all'}
                onChange={(value) => update({ join: value as EdgeSemantics['join'] })}
                searchable={false}
                options={JOIN_OPTIONS}
              />
            </div>

            {/* Merge */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-xs font-label font-medium text-theme-secondary uppercase tracking-wider">Merge strategy</label>
                <button onClick={() => setMergeRows([...mergeRows, { key: '', strategy: 'last' }])} className="btn-ghost text-xs p-1 text-accent-blue" title="Add merge key">
                  <Plus className="w-3 h-3" />
                </button>
              </div>
              <div className="space-y-1.5">
                {mergeRows.map((row, idx) => (
                  <div key={idx} className="flex items-center gap-1">
                    <input
                      className="input flex-1 text-xs font-mono"
                      placeholder="output key"
                      value={row.key}
                      onChange={e => setMergeRows(mergeRows.map((r, i) => i === idx ? { ...r, key: e.target.value } : r))}
                    />
                    <Select
                      className="w-24"
                      value={row.strategy}
                      onChange={(value) => setMergeRows(mergeRows.map((r, i) => i === idx ? { ...r, strategy: value } : r))}
                      searchable={false}
                      options={MERGE_STRATEGIES.map(s => ({ value: s, label: s }))}
                    />
                    <button onClick={() => setMergeRows(mergeRows.filter((_, i) => i !== idx))} className="text-theme-muted hover:text-accent-red p-0.5 transition-colors" title="Remove key">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
                {mergeRows.length === 0 && (
                  <p className="text-[10px] text-theme-subtle italic">No per-key merge strategy — branch outputs use the engine default.</p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Retry loop */}
      <div className="border-t border-app pt-3">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={isRetry}
            onChange={e => update({
              max_retries: e.target.checked ? (local.max_retries ?? 1) : undefined,
              retry_context: e.target.checked ? local.retry_context : undefined,
            })}
            className="w-3.5 h-3.5 rounded-sm bg-surface-200 border-accent-blue/30 accent-accent-blue"
          />
          <label className="text-xs text-theme-secondary font-label">Retry loop (backward edge)</label>
        </div>
        <p className="text-[10px] text-theme-subtle font-body mt-1 leading-relaxed">
          Routes back to an earlier node to re-run it. Bounded by max retries to avoid infinite loops.
        </p>

        {isRetry && (
          <div className="mt-3 space-y-3">
            <div>
              <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Max retries</label>
              <input
                type="number"
                min={1}
                max={20}
                className="input w-20 text-xs"
                value={local.max_retries ?? 1}
                onChange={e => update({ max_retries: Math.max(1, parseInt(e.target.value) || 1) })}
              />
            </div>
            <div>
              <label className="block text-xs font-label font-medium text-theme-secondary mb-1 uppercase tracking-wider">Retry context</label>
              <textarea
                className="input w-full text-xs h-20 resize-none font-mono"
                value={local.retry_context ?? ''}
                onChange={e => update({ retry_context: e.target.value || undefined })}
                placeholder="Templated feedback injected into the retried node, e.g. {{review.feedback}}"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
