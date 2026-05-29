import { useState } from 'react';
import { AlertTriangle, Trash2, X } from 'lucide-react';

interface Props {
  open: boolean;
  resourceType: string;     // "role", "workflow", "repo", "learning"
  resourceName: string;     // the name user must type to confirm
  onConfirm: () => void;
  onCancel: () => void;
}

export default function DeleteConfirmDialog({ open, resourceType, resourceName, onConfirm, onCancel }: Props) {
  const [typed, setTyped] = useState('');

  if (!open) return null;

  const matches = typed === resourceName;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm" onClick={onCancel}>
      <div className="w-full max-w-md overflow-hidden rounded-md border border-app bg-app-card shadow-[0_24px_80px_rgba(0,0,0,0.34)] animate-in fade-in zoom-in-95 duration-200" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-3 border-b border-app px-5 py-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-accent-red/25 bg-accent-red/10">
            <AlertTriangle className="h-5 w-5 text-accent-red" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold tracking-tight text-theme-primary">Delete {resourceType}</h2>
            <p className="mt-0.5 text-[12px] text-theme-muted">This action cannot be undone.</p>
          </div>
          <button
            type="button"
            title="Close"
            aria-label="Close"
            onClick={onCancel}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          <p className="mb-4 text-[13px] leading-5 text-theme-secondary">
            To confirm, type <span className="font-mono font-semibold text-accent">{resourceName}</span> below.
          </p>
          <input
            type="text"
            value={typed}
            onChange={e => setTyped(e.target.value)}
            placeholder={resourceName}
            className="h-9 w-full rounded-md border border-app bg-app px-3 font-mono text-[13px] text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent focus:shadow-[var(--focus-ring)]"
            autoFocus
            onKeyDown={e => { if (e.key === 'Enter' && matches) { onConfirm(); setTyped(''); } }}
          />
        </div>

        <div className="flex justify-end gap-3 border-t border-app px-5 py-3">
          <button
            type="button"
            onClick={() => { onCancel(); setTyped(''); }}
            className="inline-flex h-9 items-center justify-center rounded-md border border-app bg-app px-3 text-[13px] font-medium text-theme-secondary transition-colors hover:border-app-strong hover:bg-app-muted hover:text-theme-primary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => { if (matches) { onConfirm(); setTyped(''); } }}
            disabled={!matches}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-accent-red px-3 text-[13px] font-medium text-white transition-colors hover:bg-accent-red/90 disabled:cursor-not-allowed disabled:opacity-35"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete {resourceType}
          </button>
        </div>
      </div>
    </div>
  );
}
