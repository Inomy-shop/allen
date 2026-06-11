import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle, X } from 'lucide-react';
import { repos as repoApi } from '../../services/api';
import Select from '../common/Select';
import {
  castWorkflowRunInput,
  defaultWorkflowRunInput,
  enumOptions,
  isRequiredWorkflowInput,
  resolveWorkflowInputWidget,
} from './WorkflowRunDialog';

interface Props {
  inputSchema: Record<string, any>;
  onClose: () => void;
}

export default function WorkflowInputPreviewDialog({ inputSchema, onClose }: Props) {
  const [values, setValues] = useState<Record<string, string>>(() => defaultWorkflowRunInput(inputSchema));
  const [captured, setCaptured] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repoList, setRepoList] = useState<any[]>([]);
  const [repoModes, setRepoModes] = useState<Record<string, 'select' | 'manual'>>({});
  const entries = useMemo(() => Object.entries(inputSchema), [inputSchema]);

  useEffect(() => {
    let cancelled = false;
    repoApi.list()
      .then((list) => { if (!cancelled) setRepoList(list ?? []); })
      .catch(() => { if (!cancelled) setRepoList([]); });
    return () => { cancelled = true; };
  }, []);

  const update = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setCaptured(null);
    setError(null);
  };

  const capture = () => {
    const result = castWorkflowRunInput(inputSchema, values);
    if (result.error) {
      setError(result.error);
      setCaptured(null);
      return;
    }
    setError(null);
    setCaptured(result.input);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 p-4 backdrop-blur-md"
      onClick={onClose}
    >
      <div className="card w-full max-w-lg overflow-hidden shadow-popover" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-app px-5 py-4">
          <div>
            <h2 className="text-[14px] font-semibold text-theme-primary">Preview Workflow Input</h2>
            <p className="mt-1 text-[11px] text-theme-muted">Enter sample values to inspect the captured run payload.</p>
          </div>
          <button onClick={onClose} className="btn-ghost p-1 text-theme-muted hover:text-theme-primary" title="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[58vh] space-y-4 overflow-auto px-5 py-4">
          {entries.length === 0 ? (
            <p className="text-[12px] text-theme-subtle">No workflow inputs declared.</p>
          ) : entries.map(([key, schema]) => {
            const widget = resolveWorkflowInputWidget(key, schema);
            const required = isRequiredWorkflowInput(schema);
            const label = schema?.label ?? key.replace(/_/g, ' ');
            const description = schema?.description;
            const placeholder = schema?.placeholder ?? schema?.description ?? `Enter ${key.replace(/_/g, ' ')}`;
            const value = values[key] ?? '';

            return (
              <div key={key}>
                <label className="mb-1 flex items-center gap-1 text-xs font-label font-semibold uppercase tracking-widest text-theme-secondary">
                  {label}
                  {required && <span className="text-[10px] text-accent-red">*</span>}
                </label>
                {description && widget !== 'checkbox' && (
                  <p className="mb-2 text-[11px] leading-relaxed text-theme-subtle">{description}</p>
                )}

                {widget === 'select' && (
                  <Select
                    value={value}
                    onChange={(next) => update(key, next)}
                    searchable={enumOptions(schema).length > 6}
                    placeholder="Select value"
                    options={[
                      ...(!required ? [{ value: '', label: 'None' }] : []),
                      ...enumOptions(schema).map((option) => ({ value: option, label: option })),
                    ]}
                  />
                )}

                {widget === 'checkbox' && (
                  <label className="flex cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      checked={value === 'true'}
                      onChange={(event) => update(key, event.target.checked ? 'true' : 'false')}
                      className="mt-0.5"
                    />
                    <span className="text-[11px] leading-relaxed text-theme-subtle">{description ?? key}</span>
                  </label>
                )}

                {widget === 'number' && (
                  <input
                    type="number"
                    value={value}
                    onChange={(event) => update(key, event.target.value)}
                    min={schema?.min}
                    max={schema?.max}
                    placeholder={placeholder}
                    className="input w-full text-sm"
                  />
                )}

                {widget === 'textarea' && (
                  <textarea
                    value={value}
                    onChange={(event) => update(key, event.target.value)}
                    placeholder={placeholder}
                    rows={4}
                    className="input w-full resize-y text-sm leading-relaxed"
                  />
                )}

                {widget === 'repo_picker' && (
                  (repoModes[key] ?? 'select') === 'select' ? (
                    <Select
                      value={value}
                      placeholder="Select repository"
                      searchable={repoList.length > 6}
                      options={[
                        ...repoList.map((repo: any) => ({
                          value: repo.path,
                          label: repo.name,
                          sublabel: repo.path,
                        })),
                        { value: '__manual__', label: 'Enter path manually...' },
                      ]}
                      onChange={(next) => {
                        if (next === '__manual__') {
                          setRepoModes((prev) => ({ ...prev, [key]: 'manual' }));
                          update(key, '');
                          return;
                        }
                        update(key, next);
                      }}
                    />
                  ) : (
                    <div className="space-y-2">
                      <input
                        type="text"
                        value={value}
                        onChange={(event) => update(key, event.target.value)}
                        placeholder="/path/to/repo"
                        className="input w-full font-mono text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setRepoModes((prev) => ({ ...prev, [key]: 'select' }));
                          update(key, '');
                        }}
                        className="text-[10px] font-mono uppercase tracking-wider text-accent-blue hover:text-accent-cyan"
                      >
                        Back to repo list
                      </button>
                    </div>
                  )
                )}

                {widget === 'text' && (
                  <input
                    type="text"
                    value={value}
                    onChange={(event) => update(key, event.target.value)}
                    placeholder={placeholder}
                    className="input w-full text-sm"
                  />
                )}
              </div>
            );
          })}

          {error && <div className="badge badge-err">{error}</div>}
          {captured && (
            <pre className="max-h-56 overflow-auto rounded border border-app bg-app-muted/40 p-3 font-mono text-[11px] text-theme-secondary">
              {JSON.stringify(captured, null, 2)}
            </pre>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-app bg-app-card/50 px-5 py-4">
          <button onClick={onClose} className="btn btn-secondary btn-sm rounded-sm">Close</button>
          <button onClick={capture} className="btn btn-primary btn-sm rounded-sm">
            <CheckCircle className="h-3.5 w-3.5" /> Capture test input
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
