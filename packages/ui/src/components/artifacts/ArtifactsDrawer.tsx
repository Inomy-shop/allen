import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText } from 'lucide-react';
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

export default function ArtifactsDrawer({ rootType, rootId, open, onClose }: Props) {
  const [selected, setSelected] = useState<ArtifactDoc | null>(null);
  const [panelKey, setPanelKey] = useState(0);

  const { size: listWidth, handleMouseDown: listResizeStart } = useResizable({
    direction: 'horizontal',
    initialSize: 340,
    minSize: 280,
    maxSize: 520,
    side: 'start',
  });

  useEffect(() => { if (!open) setSelected(null); }, [open]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  function syncSelection(artifacts: ArtifactDoc[]) {
    if (artifacts.length === 0) {
      setSelected(null);
      return;
    }
    setSelected(current => {
      if (current && artifacts.some(item => item.artifactId === current.artifactId)) return current;
      return artifacts[0];
    });
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this artifact? The file is removed from disk.')) return;
    try {
      await artifactsApi.delete(id);
      setSelected(null);
      setPanelKey(value => value + 1);
    } catch (err) {
      alert(`Failed to delete: ${(err as Error).message}`);
    }
  }

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/30 p-6" role="dialog" aria-modal="true" aria-label="Artifacts">
      <button className="absolute inset-0" type="button" onClick={onClose} aria-label="Close artifacts" />

      <aside
        className="relative ml-auto flex h-full w-[min(1440px,calc(100vw-32px))] overflow-hidden rounded-lg border border-app-strong bg-app-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="relative flex h-full shrink-0 flex-col bg-app-card"
          style={{ width: listWidth }}
        >
          <ArtifactsPanel
            key={panelKey}
            rootType={rootType}
            rootId={rootId}
            selectedId={selected?.artifactId}
            onSelect={setSelected}
            onItemsChange={syncSelection}
            onClose={onClose}
          />

          <div
            className="group absolute bottom-0 right-0 top-0 z-20 w-2 cursor-col-resize"
            onMouseDown={listResizeStart}
            title="Drag to resize list"
          >
            <div className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-accent-blue/60" />
          </div>
        </div>

        <div className="flex h-full min-w-0 flex-1 flex-col border-l border-app bg-app-card">
          {selected ? (
            <ArtifactViewer
              artifact={selected}
              onClose={() => setSelected(null)}
              onDelete={() => handleDelete(selected.artifactId)}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-center">
              <div className="max-w-sm">
                <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-md border border-app bg-app-muted text-theme-subtle">
                  <FileText className="h-5 w-5" />
                </div>
                <div className="text-sm font-semibold text-theme-primary">No artifact selected</div>
                <div className="mt-1 text-xs leading-relaxed text-theme-muted">
                  Select a saved file from the list to preview its content here.
                </div>
              </div>
            </div>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}
