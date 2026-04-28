import { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onCancel}>
      <div className="bg-surface-100 border border-accent-red/30 rounded-sm w-full max-w-md shadow-lg" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border/50">
          <div className="w-9 h-9 rounded-sm bg-accent-red/10 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5 text-accent-red" />
          </div>
          <div className="flex-1">
            <h2 className="text-[14px] font-semibold text-theme-primary tracking-tight">Delete {resourceType}</h2>
            <p className="text-xs text-theme-secondary font-body mt-0.5">This action cannot be undone</p>
          </div>
          <button title="Close" onClick={onCancel} className="text-theme-secondary hover:text-theme-primary shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          <p className="text-sm text-theme-secondary font-body mb-4">
            To confirm, type <span className="font-mono text-accent-red font-semibold">{resourceName}</span> below:
          </p>
          <input
            type="text"
            value={typed}
            onChange={e => setTyped(e.target.value)}
            placeholder={resourceName}
            className="w-full bg-surface-200 border border-accent-red/30 rounded-sm px-3 py-2 text-sm text-gray-100 font-mono focus:outline-none focus:border-accent-red focus:shadow-glow-red transition-all"
            autoFocus
            onKeyDown={e => { if (e.key === 'Enter' && matches) { onConfirm(); setTyped(''); } }}
          />
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border/50">
          <button onClick={() => { onCancel(); setTyped(''); }} className="btn-ghost text-xs inline-flex items-center whitespace-nowrap">
            Cancel
          </button>
          <button
            onClick={() => { if (matches) { onConfirm(); setTyped(''); } }}
            disabled={!matches}
            className="btn-danger text-xs inline-flex items-center whitespace-nowrap disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Delete {resourceType}
          </button>
        </div>
      </div>
    </div>
  );
}
