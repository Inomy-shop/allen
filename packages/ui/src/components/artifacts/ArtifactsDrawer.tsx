import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { artifacts as artifactsApi, type ArtifactDoc } from '../../services/api';
import ArtifactsPanel from './ArtifactsPanel';
import ArtifactViewer from './ArtifactViewer';

interface Props {
  rootType: 'chat' | 'workflow' | 'agent';
  rootId: string;
  open: boolean;
  onClose: () => void;
}

/**
 * Right-side artifact browser. Two slide-out panes:
 *
 *   ┌───────────────────────────┬──────────┐
 *   │  Viewer (appears when a   │   List   │
 *   │  file is selected; wider) │  (360px) │
 *   └───────────────────────────┴──────────┘
 *
 * The list stays narrow and always mounted when the drawer is open. The
 * viewer slides in to the LEFT of the list when the user picks a file;
 * clicking another file in the list swaps the viewer's content in place
 * without reanimating. Closing the drawer closes both.
 */
export default function ArtifactsDrawer({ rootType, rootId, open, onClose }: Props) {
  const [selected, setSelected] = useState<ArtifactDoc | null>(null);

  // Reset selection whenever the drawer is closed so reopens start clean.
  useEffect(() => { if (!open) setSelected(null); }, [open]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Layered Escape: close viewer first, then the drawer on the
      // second Escape. Matches finder/file-browser conventions.
      if (selected) setSelected(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, selected]);

  async function handleDelete(id: string) {
    if (!confirm('Delete this artifact? The file is removed from disk.')) return;
    try {
      await artifactsApi.delete(id);
      setSelected(null);
      // The list polls, but force a re-render via the key bump below too.
    } catch (err) {
      alert(`Failed to delete: ${(err as Error).message}`);
    }
  }

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[9999]">
      {/* Backdrop — click closes both panes. */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Viewer pane — slides in to the LEFT of the list when an artifact
          is selected. Wider (760px) so markdown / CSV tables have room. */}
      {selected && (
        <aside
          className="absolute top-0 h-full bg-surface-50 border-l border-border/40 shadow-2xl flex flex-col"
          style={{ right: 360, width: 'min(760px, calc(100vw - 360px))' }}
          onClick={(e) => e.stopPropagation()}
        >
          <ArtifactViewer
            artifact={selected}
            onClose={() => setSelected(null)}
            onDelete={() => handleDelete(selected.artifactId)}
          />
        </aside>
      )}

      {/* List pane — pinned to the right edge. Narrow (360px).
          ArtifactsPanel renders its own header (title + count + refresh +
          close) so we don't double-chrome it. */}
      <aside
        className="absolute top-0 right-0 h-full bg-surface-50 border-l border-border/40 shadow-2xl flex flex-col"
        style={{ width: 360 }}
        onClick={(e) => e.stopPropagation()}
      >
        <ArtifactsPanel
          rootType={rootType}
          rootId={rootId}
          selectedId={selected?.artifactId}
          onSelect={setSelected}
          onClose={onClose}
        />
      </aside>
    </div>,
    document.body,
  );
}
