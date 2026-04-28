import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Play, X, ArrowRight, Loader2 } from 'lucide-react';
import { workflows as wfApi, executions as execApi, repos as repoApi } from '../../services/api';
import Select from '../common/Select';
import { useToast } from '../common/Toast';

type InputWidget = 'text' | 'textarea' | 'checkbox' | 'select' | 'repo_picker' | 'number';

/**
 * Decide which form widget to render for a workflow input field.
 * Priority:
 *   1. `widget:` explicitly set on the schema (new, preferred).
 *   2. `enum: [...]` present → select dropdown.
 *   3. `type: boolean` → checkbox.
 *   4. `type: number` → number input.
 *   5. Heuristic fallback by field name (legacy workflows without `widget:`).
 */
function resolveWidget(key: string, schema: any): InputWidget {
  if (schema?.widget) return schema.widget as InputWidget;
  if (Array.isArray(schema?.enum) && schema.enum.length > 0) return 'select';
  if (schema?.type === 'boolean') return 'checkbox';
  if (schema?.type === 'number') return 'number';
  if (/^(repo_path|repoPath|repo|path|worktree_path|worktreePath)$/.test(key)) {
    return 'repo_picker';
  }
  const longFields = new Set([
    'task', 'topic', 'question', 'problem', 'description',
    'user_request', 'bug_report', 'greeting', 'feedback',
  ]);
  if (longFields.has(key)) return 'textarea';
  return 'text';
}

export interface WorkflowRunDialogProps {
  /** Workflow to run. Can be a partial `{ _id }` — the dialog fetches the
   *  full record via `workflows.get` before rendering. */
  workflow: { _id: string; name?: string; description?: string; parsed?: any };
  onClose: () => void;
  /** Called with the started execution row so the caller can navigate. */
  onStarted: (exec: { id: string }) => void;
}

/**
 * Schema-driven "Run Workflow" dialog — collects input per the workflow's
 * declared `parsed.input` schema, casts types before POST, and hands the
 * started execution back to the caller via `onStarted`.
 *
 * Extracted from WorkflowListPage so both the list page AND the workflow
 * builder/edit page can use the same collection flow. Portal-rendered so
 * ancestor backdrop-filter contexts can't trap it.
 */
export default function WorkflowRunDialog({ workflow, onClose, onStarted }: WorkflowRunDialogProps) {
  const toast = useToast();
  const [fullWf, setFullWf] = useState<any | null>(workflow.parsed ? workflow : null);
  const [loadingWf, setLoadingWf] = useState(!workflow.parsed);
  const [runInput, setRunInput] = useState<Record<string, string>>({});
  const [repoList, setRepoList] = useState<any[]>([]);
  const [repoMode, setRepoMode] = useState<'select' | 'manual'>('select');
  const [submitting, setSubmitting] = useState(false);

  // Fetch full workflow + repo list on open.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const wf = workflow.parsed ? workflow : await wfApi.get(workflow._id);
        if (cancelled) return;
        setFullWf(wf);

        const defaults: Record<string, string> = {};
        if (wf.parsed?.input) {
          for (const [key, schema] of Object.entries(wf.parsed.input) as [string, any][]) {
            defaults[key] = schema?.default != null ? String(schema.default) : '';
          }
        }
        setRunInput(defaults);
      } catch (e) {
        if (!cancelled) toast.error(`Failed to load workflow: ${(e as Error).message}`);
      } finally {
        if (!cancelled) setLoadingWf(false);
      }
    })();

    repoApi.list().then((list) => { if (!cancelled) setRepoList(list ?? []); })
      .catch(() => { if (!cancelled) setRepoList([]); });

    return () => { cancelled = true; };
  }, [workflow._id]);

  // Body-scroll lock + Escape to close
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const handleRun = useCallback(async () => {
    if (!fullWf) return;
    setSubmitting(true);
    try {
      // Cast string form values to the right types per the schema. Mirrors
      // the logic from the old inline version in WorkflowListPage.
      const schemaByKey = (fullWf.parsed?.input ?? {}) as Record<string, any>;
      const input: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(runInput)) {
        const schema = schemaByKey[k];
        const type = schema?.type ?? 'string';
        const trimmed = typeof v === 'string' ? v.trim() : v;
        if (type === 'boolean') {
          input[k] = trimmed === 'true';
        } else if (type === 'number') {
          if (trimmed === '' || trimmed == null) continue;
          const n = Number(trimmed);
          if (!Number.isNaN(n)) input[k] = n;
        } else {
          if (trimmed === '' || trimmed == null) continue;
          input[k] = trimmed;
        }
      }
      const exec = await execApi.start(fullWf._id, input);
      toast.success(`Workflow "${fullWf.name ?? 'run'}" started`);
      onStarted(exec);
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to start workflow');
      setSubmitting(false);
    }
  }, [fullWf, runInput, onStarted, toast]);

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-md p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-lg overflow-hidden shadow-popover"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-5 border-b border-app">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-accent-blue/10 flex items-center justify-center">
                <Play className="w-5 h-5 text-accent-blue" />
              </div>
              <div>
                <h2 className="text-[14px] font-semibold text-theme-primary tracking-tight">
                  Run Workflow
                </h2>
                <p className="text-[11px] text-theme-muted font-mono">
                  {fullWf?.name ?? workflow.name ?? '…'}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-sm hover:bg-surface-200 text-theme-muted hover:text-theme-secondary transition-colors"
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          {(fullWf?.description ?? workflow.description) && (
            <p className="text-xs text-theme-secondary mt-3 leading-relaxed font-body">
              {fullWf?.description ?? workflow.description}
            </p>
          )}
        </div>

        {loadingWf ? (
          <div className="px-6 py-10 flex items-center justify-center text-theme-muted text-sm">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> loading…
          </div>
        ) : (
          <div className="px-6 py-5 space-y-4 max-h-[50vh] overflow-auto">
            {Object.entries(runInput).map(([key, value]) => {
              const schema = fullWf?.parsed?.input?.[key] as any;
              const isRequired = schema?.required !== false;
              const widget = resolveWidget(key, schema);
              const requires = fullWf?.parsed?.context?.requires;
              if (widget === 'repo_picker' && requires && Array.isArray(requires) && !requires.includes('repo')) {
                return null;
              }
              const label = schema?.label ?? key.replace(/_/g, ' ');
              const description = schema?.description;
              const placeholder = schema?.placeholder ?? schema?.description ?? `Enter ${key.replace(/_/g, ' ')}...`;

              return (
                <div key={key}>
                  <label className="text-xs font-label font-semibold text-theme-secondary mb-1 uppercase tracking-widest flex items-center gap-1">
                    {label}
                    {isRequired && <span className="text-accent-red normal-case text-[10px]">*</span>}
                  </label>
                  {description && widget !== 'checkbox' && (
                    <p className="text-[11px] text-theme-subtle font-body mb-2 leading-relaxed">{description}</p>
                  )}

                  {widget === 'repo_picker' && (
                    repoMode === 'select' ? (
                      <div className="space-y-2">
                        <Select
                          value={value}
                          placeholder="Select a repository..."
                          options={[
                            ...repoList.map((repo: any) => ({
                              value: repo.path,
                              label: repo.name,
                              sublabel: repo.path,
                            })),
                            { value: '__manual__', label: 'Enter path manually...' },
                          ]}
                          onChange={(v) => {
                            if (v === '__manual__') {
                              setRepoMode('manual');
                              setRunInput((prev) => ({ ...prev, [key]: '' }));
                            } else {
                              setRunInput((prev) => ({ ...prev, [key]: v }));
                            }
                          }}
                        />
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <input
                          type="text"
                          value={value}
                          onChange={(e) => setRunInput((prev) => ({ ...prev, [key]: e.target.value }))}
                          placeholder="/path/to/your/project"
                          className="input w-full font-mono text-sm"
                        />
                        <button
                          type="button"
                          onClick={() => { setRepoMode('select'); setRunInput((prev) => ({ ...prev, [key]: '' })); }}
                          className="text-[10px] text-accent-blue hover:text-accent-cyan font-mono uppercase tracking-wider"
                        >
                          Back to repo list
                        </button>
                      </div>
                    )
                  )}

                  {widget === 'checkbox' && (
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={value === 'true'}
                        onChange={(e) => setRunInput((prev) => ({ ...prev, [key]: e.target.checked ? 'true' : 'false' }))}
                        className="mt-0.5 cursor-pointer"
                      />
                      {description && (
                        <span className="text-[11px] text-theme-subtle font-body leading-relaxed">{description}</span>
                      )}
                    </label>
                  )}

                  {widget === 'select' && (
                    <select
                      value={value}
                      onChange={(e) => setRunInput((prev) => ({ ...prev, [key]: e.target.value }))}
                      className="input w-full text-sm"
                    >
                      {!isRequired && <option value="">— none —</option>}
                      {(schema?.enum ?? []).map((opt: string) => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                    </select>
                  )}

                  {widget === 'number' && (
                    <input
                      type="number"
                      value={value}
                      onChange={(e) => setRunInput((prev) => ({ ...prev, [key]: e.target.value }))}
                      placeholder={placeholder}
                      min={schema?.min}
                      max={schema?.max}
                      className="input w-full text-sm"
                    />
                  )}

                  {widget === 'textarea' && (
                    <textarea
                      value={value}
                      onChange={(e) => setRunInput((prev) => ({ ...prev, [key]: e.target.value }))}
                      placeholder={placeholder}
                      rows={6}
                      className="input w-full text-sm resize-y font-body leading-relaxed"
                    />
                  )}

                  {widget === 'text' && (
                    <input
                      type="text"
                      value={value}
                      onChange={(e) => setRunInput((prev) => ({ ...prev, [key]: e.target.value }))}
                      placeholder={placeholder}
                      className="input w-full text-sm"
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-3 px-6 py-5 border-t border-app bg-app-card/50">
          <button onClick={onClose} className="flex-1 btn-ghost" disabled={submitting}>
            Cancel
          </button>
          <button
            onClick={handleRun}
            disabled={submitting || loadingWf}
            className="flex-1 btn-primary inline-flex items-center justify-center gap-2 disabled:opacity-60"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {submitting ? 'Starting…' : 'Run Workflow'}
            {!submitting && <ArrowRight className="w-3.5 h-3.5 opacity-60" />}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
