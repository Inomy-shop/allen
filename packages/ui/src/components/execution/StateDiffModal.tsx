import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X as XIcon } from 'lucide-react';
import { CopyButton, DownloadButton } from '../common/CopyDownload';

interface Props {
  titleLeft: string;
  titleRight: string;
  left: Record<string, unknown>;
  right: Record<string, unknown>;
  onClose: () => void;
}

/**
 * Side-by-side diff of two state blobs. Color-codes added / removed /
 * modified keys. Used for:
 *   - Attempt-to-attempt diff (within one node's retry history)
 *   - Checkpoint-to-checkpoint diff (CheckpointsPanel multi-select)
 *   - Before/after diff (any pair of state snapshots the caller provides)
 */
export default function StateDiffModal({ titleLeft, titleRight, left, right, onClose }: Props) {
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

  const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).sort();
  const added = keys.filter((k) => !(k in left));
  const removed = keys.filter((k) => !(k in right));
  const modified = keys.filter((k) => k in left && k in right && JSON.stringify(left[k]) !== JSON.stringify(right[k]));
  const unchanged = keys.filter((k) => k in left && k in right && JSON.stringify(left[k]) === JSON.stringify(right[k]));

  const summary = `+${added.length} ~${modified.length} −${removed.length} · ${unchanged.length} unchanged`;

  return createPortal(
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-start justify-center z-[9999] p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-surface-50 border border-border/40 rounded-lg w-full max-w-6xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl mt-[5vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border/20">
          <div>
            <h3 className="font-heading text-sm text-theme-primary tracking-wider">State diff</h3>
            <p className="text-[11px] text-theme-muted font-mono">
              <span className="text-theme-subtle">{titleLeft}</span>
              <span className="mx-2">→</span>
              <span className="text-theme-secondary">{titleRight}</span>
              <span className="ml-3 text-theme-subtle">{summary}</span>
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-surface-200/60 text-theme-muted hover:text-theme-secondary transition-colors"
            title="Close diff"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-3">
          {added.length > 0 && (
            <DiffSection title="Added" variant="added" keys={added} left={left} right={right} side="right" />
          )}
          {modified.length > 0 && (
            <DiffSection title="Modified" variant="modified" keys={modified} left={left} right={right} side="both" />
          )}
          {removed.length > 0 && (
            <DiffSection title="Removed" variant="removed" keys={removed} left={left} right={right} side="left" />
          )}
          {added.length === 0 && modified.length === 0 && removed.length === 0 && (
            <div className="text-center py-8 text-[11px] text-theme-subtle font-mono">
              No differences — both sides are identical.
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border/20 bg-surface-100/40">
          <CopyButton text={JSON.stringify({ left, right }, null, 2)} label="Copy diff" />
          <DownloadButton
            content={JSON.stringify({ left, right, added, modified, removed }, null, 2)}
            filename="state-diff.json"
            label="Download"
          />
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md border border-border/40 text-theme-secondary hover:bg-surface-200/60 text-sm font-body transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Tailwind's JIT compiler only picks up classes it can see literally in
// source. Dynamic classes like `bg-${color}/10` get purged. Use an explicit
// lookup so every variant's classes appear as static strings.
const VARIANT_STYLES = {
  added:    { bg: 'bg-accent-green/10', text: 'text-accent-green' },
  modified: { bg: 'bg-amber-400/10',     text: 'text-amber-400'    },
  removed:  { bg: 'bg-red-400/10',       text: 'text-red-400'      },
} as const;
type DiffVariant = keyof typeof VARIANT_STYLES;

function DiffSection({
  title, variant, keys, left, right, side,
}: {
  title: string;
  variant: DiffVariant;
  keys: string[];
  left: Record<string, unknown>;
  right: Record<string, unknown>;
  side: 'left' | 'right' | 'both';
}) {
  const styles = VARIANT_STYLES[variant];
  return (
    <div className="border border-border/30 rounded-md overflow-hidden">
      <div className={`px-3 py-1.5 ${styles.bg} border-b border-border/20`}>
        <span className={`text-[11px] font-label uppercase tracking-[0.15em] ${styles.text}`}>
          {title} ({keys.length})
        </span>
      </div>
      <div className="divide-y divide-border/10">
        {keys.map((k) => (
          <div key={k} className="p-2">
            <div className="text-[11px] font-mono text-theme-primary mb-1">{k}</div>
            {(side === 'left' || side === 'both') && (
              <pre className="text-[10px] font-mono text-red-400 bg-red-500/5 rounded p-1.5 whitespace-pre-wrap break-all mb-1">
                − {JSON.stringify(left[k], null, 2)}
              </pre>
            )}
            {(side === 'right' || side === 'both') && (
              <pre className="text-[10px] font-mono text-accent-green bg-accent-green/5 rounded p-1.5 whitespace-pre-wrap break-all">
                + {JSON.stringify(right[k], null, 2)}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
