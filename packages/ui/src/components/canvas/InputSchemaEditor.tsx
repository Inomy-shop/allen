import { useEffect, useRef, useState } from 'react';
import { CheckCircle, Plus, X } from 'lucide-react';
import Select from '../common/Select';
import WorkflowInputPreviewDialog from '../workflow/WorkflowInputPreviewDialog';

interface InputFieldDef {
  type?: string;
  required?: boolean;
  default?: unknown;
  description?: string;
  enum?: string[];
  widget?: string;
  min?: number;
  max?: number;
}

interface Props {
  value: Record<string, InputFieldDef> | undefined;
  onChange: (next: Record<string, InputFieldDef> | undefined) => void;
}

const TYPES = ['string', 'number', 'boolean', 'object', 'array'];
const WIDGETS = ['text', 'textarea', 'checkbox', 'select', 'repo_picker', 'number'];
const LABEL_CLASS = 'text-[10px] font-mono uppercase tracking-[0.12em] text-theme-muted';

type Row = { name: string; def: InputFieldDef };

function stableValue(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function coerceDefaultValue(value: unknown, type: string | undefined): unknown {
  if (value === '' || value === undefined) return undefined;
  if (type === 'number') {
    const n = Number(value);
    return Number.isNaN(n) ? undefined : n;
  }
  if (type === 'boolean') {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return undefined;
  }
  return value;
}

function inferredWidget(def: InputFieldDef): string {
  if (def.widget) return def.widget;
  if ((def.enum ?? []).length > 0) return 'select';
  if (def.type === 'boolean') return 'checkbox';
  if (def.type === 'number') return 'number';
  return 'text';
}

export function normalizeInputFieldDef(def: InputFieldDef): InputFieldDef {
  const next: InputFieldDef = {
    ...def,
    default: coerceDefaultValue(def.default, def.type),
  };

  if (next.type === 'number') {
    next.min = next.min === undefined || Number.isNaN(Number(next.min)) ? undefined : Number(next.min);
    next.max = next.max === undefined || Number.isNaN(Number(next.max)) ? undefined : Number(next.max);
  } else {
    delete next.min;
    delete next.max;
  }

  if (next.type === 'boolean' && !next.widget) next.widget = 'checkbox';
  if (next.type === 'number' && !next.widget) next.widget = 'number';
  if (Array.isArray(next.enum)) {
    next.enum = next.enum.map(option => String(option).trim()).filter(Boolean);
  }
  if (Array.isArray(next.enum) && next.enum.length > 0 && !next.widget) next.widget = 'select';
  if (next.widget === 'select' && next.default != null && Array.isArray(next.enum) && !next.enum.includes(String(next.default))) {
    delete next.default;
  }

  for (const k of Object.keys(next) as (keyof InputFieldDef)[]) {
    const v = next[k];
    if (v === '' || v === undefined || (Array.isArray(v) && v.length === 0)) delete next[k];
  }
  return next;
}

function toRows(map: Record<string, InputFieldDef> | undefined): Row[] {
  if (!map || typeof map !== 'object') return [];
  return Object.entries(map).map(([name, def]) => ({ name, def: def ?? {} }));
}

function fromRows(rows: Row[]): Record<string, InputFieldDef> | undefined {
  const out: Record<string, InputFieldDef> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name) out[name] = normalizeInputFieldDef(row.def);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Editor for the workflow-level `input:` schema — the fields a user is
 * prompted for when running the workflow. Mirrors InputFieldDef in
 * packages/engine/src/types.ts. Previously this was read-only ("edit in YAML").
 */
export default function InputSchemaEditor({ value, onChange }: Props) {
  // Local rows so a freshly-added input (blank name) survives until named;
  // blank names are dropped only on serialize. Seeded once on mount.
  const [rows, setRows] = useState<Row[]>(() => toRows(value));
  const [previewOpen, setPreviewOpen] = useState(false);
  const [optionDrafts, setOptionDrafts] = useState<Record<number, string>>({});
  const lastEmittedRef = useRef(stableValue(value));

  useEffect(() => {
    const incoming = stableValue(value);
    if (incoming !== lastEmittedRef.current) {
      setRows(toRows(value));
      lastEmittedRef.current = incoming;
    }
  }, [value]);

  const commit = (next: Row[]) => {
    setRows(next);
    const serialized = fromRows(next);
    lastEmittedRef.current = stableValue(serialized);
    onChange(serialized);
  };
  const setDef = (idx: number, patch: Partial<InputFieldDef>) => {
    const next = normalizeInputFieldDef({ ...rows[idx].def, ...patch });
    for (const k of Object.keys(next) as (keyof InputFieldDef)[]) {
      const v = next[k];
      if (v === '' || v === undefined || (Array.isArray(v) && v.length === 0)) delete next[k];
    }
    commit(rows.map((r, i) => i === idx ? { ...r, def: next } : r));
  };

  const setDropdownOption = (idx: number, optionIdx: number, value: string) => {
    const current = rows[idx].def.enum ?? [];
    const nextOptions = [...current];
    nextOptions[optionIdx] = value;
    setDef(idx, { enum: nextOptions, widget: 'select' });
  };

  const addDropdownOption = (idx: number) => {
    const current = rows[idx].def.enum ?? [];
    const draft = optionDrafts[idx]?.trim();
    setDef(idx, { enum: [...current, draft || `option-${current.length + 1}`], widget: 'select' });
    setOptionDrafts(prev => ({ ...prev, [idx]: '' }));
  };

  const removeDropdownOption = (idx: number, optionIdx: number) => {
    const current = rows[idx].def.enum ?? [];
    setDef(idx, { enum: current.filter((_, i) => i !== optionIdx), widget: 'select' });
  };

  return (
    <div className="space-y-2">
      {rows.map((row, idx) => {
        const def = row.def;
        const widget = inferredWidget(def);
        const dropdownOptions = def.enum ?? [];
        return (
          <div key={idx} className="bg-app-muted/40 rounded-sm p-2.5 space-y-1.5 border border-app">
            <div className="flex items-end gap-1">
              <label className="flex-1 space-y-1">
                <span className={LABEL_CLASS}>Field name</span>
                <input
                  className="input w-full text-xs font-mono"
                  placeholder="user_question"
                  value={row.name}
                  onChange={e => commit(rows.map((r, i) => i === idx ? { ...r, name: e.target.value } : r))}
                />
              </label>
              <button type="button" onClick={() => commit(rows.filter((_, i) => i !== idx))} className="text-theme-muted hover:text-accent-red p-1 transition-colors" title="Remove field">
                <X className="w-3 h-3" />
              </button>
            </div>
            <label className="block space-y-1">
              <span className={LABEL_CLASS}>Description</span>
              <input
                className="input w-full text-xs"
                placeholder="Shown to the user when running this workflow"
                value={def.description ?? ''}
                onChange={e => setDef(idx, { description: e.target.value })}
              />
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              <div className="space-y-1">
                <span className={LABEL_CLASS}>Value type</span>
                <Select
                  value={def.type ?? 'string'}
                  onChange={(v) => setDef(idx, { type: v })}
                  searchable={false}
                  options={TYPES.map(t => ({ value: t, label: t }))}
                />
              </div>
              <div className="space-y-1">
                <span className={LABEL_CLASS}>Input control</span>
                <Select
                  value={def.widget ?? ''}
                  onChange={(v) => setDef(idx, { widget: v || undefined })}
                  searchable={false}
                  options={[{ value: '', label: 'Automatic' }, ...WIDGETS.map(w => ({ value: w, label: w }))]}
                />
              </div>
            </div>

            {widget === 'select' && (
              <>
                <div className="space-y-1.5 rounded border border-app bg-app p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className={LABEL_CLASS}>Dropdown options</span>
                    <span className="text-[10px] text-theme-subtle">One row per option</span>
                  </div>
                  {dropdownOptions.length === 0 ? (
                    <p className="text-[10px] text-theme-subtle italic">Add at least one option to show a dropdown.</p>
                  ) : (
                    dropdownOptions.map((option, optionIdx) => (
                      <div key={optionIdx} className="flex items-center gap-1">
                        <input
                          className="input flex-1 text-xs font-mono"
                          placeholder="option value"
                          value={option}
                          onChange={e => setDropdownOption(idx, optionIdx, e.target.value)}
                        />
                        <button
                          type="button"
                          onClick={() => removeDropdownOption(idx, optionIdx)}
                          className="text-theme-muted hover:text-accent-red p-0.5 transition-colors"
                          title="Remove option"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))
                  )}
                  <div className="flex items-center gap-1">
                    <input
                      className="input flex-1 text-xs font-mono"
                      placeholder="New option"
                      value={optionDrafts[idx] ?? ''}
                      onChange={e => setOptionDrafts(prev => ({ ...prev, [idx]: e.target.value }))}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addDropdownOption(idx);
                        }
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => addDropdownOption(idx)}
                      className="btn-ghost p-1 text-[11px] text-accent-blue inline-flex items-center gap-1"
                      title="Add dropdown option"
                    >
                      <Plus className="w-3 h-3" /> Add
                    </button>
                  </div>
                </div>
                <div className="space-y-1">
                  <span className={LABEL_CLASS}>Default option</span>
                  <Select
                    value={def.default != null ? String(def.default) : ''}
                    onChange={(v) => setDef(idx, { default: v || undefined })}
                    searchable={dropdownOptions.length > 6}
                    options={[
                      { value: '', label: dropdownOptions.length > 0 ? 'No default' : 'Add options first' },
                      ...dropdownOptions.map(option => ({ value: option, label: option })),
                    ]}
                  />
                </div>
              </>
            )}

            {widget === 'checkbox' && (
              <div className="space-y-1">
                <span className={LABEL_CLASS}>Default value</span>
                <label className="flex items-center gap-1.5 rounded border border-app bg-app px-2 py-1.5">
                  <input
                    type="checkbox"
                    checked={def.default === true}
                    onChange={e => setDef(idx, { default: e.target.checked })}
                    className="w-3 h-3 rounded-sm bg-surface border-border accent-accent-blue"
                  />
                  <span className="text-[11px] text-theme-secondary">Checked by default</span>
                </label>
              </div>
            )}

            {widget === 'number' && (
              <label className="block space-y-1">
                <span className={LABEL_CLASS}>Default number</span>
                <input
                  type="number"
                  className="input w-full text-xs font-mono"
                  placeholder="No default"
                  value={def.default != null ? String(def.default) : ''}
                  onChange={e => setDef(idx, { default: e.target.value === '' ? undefined : e.target.value })}
                />
              </label>
            )}

            {widget !== 'select' && widget !== 'checkbox' && widget !== 'number' && (
              <label className="block space-y-1">
                <span className={LABEL_CLASS}>Default value</span>
                <input
                  className="input w-full text-xs font-mono"
                  placeholder="No default"
                  value={def.default != null ? String(def.default) : ''}
                  onChange={e => setDef(idx, { default: e.target.value === '' ? undefined : e.target.value })}
                />
              </label>
            )}

            {def.type === 'number' && (
              <div className="grid grid-cols-2 gap-1.5">
                <label className="block space-y-1">
                  <span className={LABEL_CLASS}>Minimum</span>
                  <input type="number" className="input w-full text-xs" placeholder="No minimum" value={def.min ?? ''} onChange={e => setDef(idx, { min: e.target.value === '' ? undefined : Number(e.target.value) })} />
                </label>
                <label className="block space-y-1">
                  <span className={LABEL_CLASS}>Maximum</span>
                  <input type="number" className="input w-full text-xs" placeholder="No maximum" value={def.max ?? ''} onChange={e => setDef(idx, { max: e.target.value === '' ? undefined : Number(e.target.value) })} />
                </label>
              </div>
            )}
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={def.required === true} onChange={e => setDef(idx, { required: e.target.checked })} className="w-3 h-3 rounded-sm bg-surface border-border accent-accent-blue" />
              <span className="overline">Required</span>
            </label>
          </div>
        );
      })}
      {rows.length === 0 && (
        <p className="text-[10px] text-theme-subtle italic">No inputs declared.</p>
      )}
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => commit([...rows, { name: '', def: { type: 'string', required: false } }])} className="btn-ghost text-xs p-1 text-accent-blue inline-flex items-center gap-1" title="Add input">
          <Plus className="w-3 h-3" /> Add input
        </button>
        <button type="button" onClick={() => setPreviewOpen(true)} className="btn-ghost text-xs p-1 text-accent-green inline-flex items-center gap-1" title="Preview and test input capture">
          <CheckCircle className="w-3 h-3" /> Preview/test
        </button>
      </div>
      {previewOpen && (
        <WorkflowInputPreviewDialog
          inputSchema={fromRows(rows) ?? {}}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </div>
  );
}
