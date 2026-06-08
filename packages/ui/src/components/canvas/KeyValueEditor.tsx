import { useState } from 'react';
import { Plus, X } from 'lucide-react';

interface Props {
  /** Canonical key → value map. Used to seed the editor on mount. */
  value: Record<string, string> | undefined;
  onChange: (next: Record<string, string> | undefined) => void;
  /** Field label shown above the key input (e.g. "Output key"). */
  keyLabel?: string;
  /** Field label shown above the value input (e.g. "Description"). */
  valueLabel?: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** Render the value as a textarea instead of a single-line input. */
  valueMultiline?: boolean;
  emptyHint?: string;
}

type Row = { key: string; value: string };

function toRows(map: Record<string, string> | undefined): Row[] {
  if (!map || typeof map !== 'object') return [];
  return Object.entries(map).map(([key, value]) => ({ key, value: String(value ?? '') }));
}

function fromRows(rows: Row[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key) out[key] = row.value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Generic editor for an ordered string→string map (node `outputs`,
 * sub-workflow `input_map` / `output_map`). Each row is a labelled card —
 * "key" field on top, "value" field below — so a populated row reads clearly
 * (you can tell the identifier from its description). Emits the canonical
 * object form, or `undefined` when empty so the field is omitted from YAML.
 *
 * Rows live in local state (a blank key is legal mid-edit, dropped only on
 * serialize), so callers MUST pass a stable `key` prop tied to the owning
 * node/field to re-seed when the selection changes.
 */
export default function KeyValueEditor({
  value,
  onChange,
  keyLabel = 'Key',
  valueLabel = 'Value',
  keyPlaceholder = 'key',
  valuePlaceholder = 'value',
  valueMultiline = false,
  emptyHint,
}: Props) {
  const [rows, setRows] = useState<Row[]>(() => toRows(value));
  const commit = (next: Row[]) => {
    setRows(next);
    onChange(fromRows(next));
  };

  return (
    <div className="space-y-2">
      {rows.map((row, idx) => (
        <div key={idx} className="rounded-sm border border-app bg-surface-200/60 p-2.5 space-y-2">
          {/* Key */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="overline">{keyLabel}</label>
              <button
                onClick={() => commit(rows.filter((_, i) => i !== idx))}
                className="text-theme-muted hover:text-accent-red p-0.5 transition-colors"
                title="Remove"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
            <input
              className="input w-full text-xs font-mono"
              placeholder={keyPlaceholder}
              value={row.key}
              onChange={e => commit(rows.map((r, i) => i === idx ? { ...r, key: e.target.value } : r))}
            />
          </div>
          {/* Value */}
          <div>
            <label className="overline block mb-1">{valueLabel}</label>
            {valueMultiline ? (
              <textarea
                className="input w-full text-xs h-16 resize-none"
                placeholder={valuePlaceholder}
                value={row.value}
                onChange={e => commit(rows.map((r, i) => i === idx ? { ...r, value: e.target.value } : r))}
              />
            ) : (
              <input
                className="input w-full text-xs font-mono"
                placeholder={valuePlaceholder}
                value={row.value}
                onChange={e => commit(rows.map((r, i) => i === idx ? { ...r, value: e.target.value } : r))}
              />
            )}
          </div>
        </div>
      ))}
      {rows.length === 0 && emptyHint && (
        <p className="text-[10px] text-theme-subtle italic">{emptyHint}</p>
      )}
      <button onClick={() => commit([...rows, { key: '', value: '' }])} className="btn-ghost text-xs p-1 text-accent-blue inline-flex items-center gap-1" title="Add row">
        <Plus className="w-3 h-3" /> Add
      </button>
    </div>
  );
}
