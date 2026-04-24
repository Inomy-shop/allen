import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { artifacts as artifactsApi, type ArtifactDoc } from '../../services/api';
import { useResizable } from '../../hooks/useResizable';
import ArtifactsPanel from './ArtifactsPanel';
import ArtifactViewer from './ArtifactViewer';

interface Props {
  rootType: 'chat' | 'workflow' | 'agent';
  rootId: string;
  open: boolean;
  onClose: () => void;
}

/**
 * Right-side artifact browser. Single drawer, two panes inside:
 *
 *   ┌──────────┬───────────────────────────┐
 *   │   List   │  Viewer (appears when a   │
 *   │  (360px) │  file is selected; wider) │
 *   └──────────┴───────────────────────────┘
 *
 * Matches the Gmail/Finder pattern — clicking an artifact in the list
 * opens its detail NEXT TO the row (to the right of the list, not to
 * the left of it). The drawer grows leftward from the viewport's right
 * edge when the viewer opens, so the list stays against the drawer's
 * left edge and the viewer pinned against the right.
 *
 * Two drag handles:
 *   - Between list and viewer — resizes the list width.
 *   - Drawer's left edge       — resizes the viewer width (drawer as a whole).
 */
export default function ArtifactsDrawer({ rootType, rootId, open, onClose }: Props) {
  const [selected, setSelected] = useState<ArtifactDoc | null>(null);

  // Width of the list pane (left side of the drawer).
  const { size: listWidth, handleMouseDown: listResizeStart } = useResizable({
    direction: 'horizontal',
    initialSize: 360,
    minSize: 260,
    maxSize: 600,
    // The list lives on the LEFT of the drawer, so its resizer sits on
    // its RIGHT edge (between list and viewer). Dragging right expands
    // the list → use side: 'start' (delta increases with rightward drag).
    side: 'start',
  });

  // Width of the viewer pane (right side of the drawer). Only rendered
  // when a file is selected. The drag handle for this width sits on the
  // drawer's LEFT edge — dragging leftward expands the viewer.
  const { size: viewerWidth, handleMouseDown: viewerResizeStart } = useResizable({
    direction: 'horizontal',
    initialSize: 760,
    minSize: 360,
    maxSize: 1400,
    side: 'end',
  });

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

      {/* Single drawer envelope pinned to the viewport's right edge.
          Width grows leftward when a file is selected (list + viewer).
          The viewer is capped via min() so a user dragging the handle
          too far left can't push the drawer off the viewport's left. */}
      <aside
        className="absolute top-0 right-0 h-full bg-surface-50 border-l border-border/40 shadow-2xl flex"
        style={{
          width: selected
            ? `min(${listWidth + viewerWidth}px, calc(100vw - 40px))`
            : `${listWidth}px`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drawer's LEFT-edge drag handle — only present when the viewer
            is open. Resizes the viewer width. Wide (8px) invisible hit
            zone for easy grabbing; on hover a thin 1px line appears in
            the centre of the strip so the indicator stays visually
            unobtrusive. The `group` class lets the inner sliver react to
            hover on the wider parent. */}
        {selected && (
          <div
            className="absolute top-0 left-0 bottom-0 w-2 cursor-col-resize z-20 group"
            onMouseDown={viewerResizeStart}
            title="Drag to resize viewer"
          >
            <div className="absolute left-1/2 -translate-x-1/2 top-0 bottom-0 w-px bg-transparent group-hover:bg-accent-blue/60 transition-colors" />
          </div>
        )}

        {/* LIST pane (left side of drawer). */}
        <div
          className="h-full bg-surface-50 flex flex-col relative shrink-0"
          style={{ width: listWidth }}
        >
          <ArtifactsPanel
            rootType={rootType}
            rootId={rootId}
            selectedId={selected?.artifactId}
            onSelect={setSelected}
            onClose={onClose}
          />

          {/* Split drag handle — between list and viewer. Wide hit zone,
              thin centred hover indicator (same pattern as the drawer's
              left-edge handle above). */}
          {selected && (
            <div
              className="absolute top-0 right-0 bottom-0 w-2 cursor-col-resize z-20 group"
              onMouseDown={listResizeStart}
              title="Drag to resize list"
            >
              <div className="absolute left-1/2 -translate-x-1/2 top-0 bottom-0 w-px bg-transparent group-hover:bg-accent-blue/60 transition-colors" />
            </div>
          )}
        </div>

        {/* VIEWER pane (right side of drawer). Takes the remaining
            drawer width — `flex: 1` so whatever's left after the fixed
            list-width gets used. */}
        {selected && (
          <div className="h-full bg-surface-50 border-l border-border/40 flex flex-col flex-1 min-w-0">
            <ArtifactViewer
              artifact={selected}
              onClose={() => setSelected(null)}
              onDelete={() => handleDelete(selected.artifactId)}
            />
          </div>
        )}
      </aside>
    </div>,
    document.body,
  );
}
