import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { FileText } from 'lucide-react';
import type { ArtifactDoc } from '../../services/api';
import { useResizable } from '../../hooks/useResizable';
import ArtifactsPanel from './ArtifactsPanel';
import { resourceScopeKey, useDocumentTabStore } from '../../stores/documentTabStore';

interface Props {
  rootType: 'chat' | 'workflow' | 'agent';
  rootId: string;
  open: boolean;
  onClose: () => void;
}

export default function ArtifactsDrawer({ rootType, rootId, open, onClose }: Props) {
  const openDocument = useDocumentTabStore(state => state.openDocument);

  const { size: listWidth, handleMouseDown: listResizeStart } = useResizable({
    direction: 'horizontal',
    initialSize: 340,
    minSize: 280,
    maxSize: 520,
    side: 'start',
  });

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
            rootType={rootType}
            rootId={rootId}
            onSelect={(artifact: ArtifactDoc) => {
              openDocument(artifact, {
                sourceLabel: rootType === 'chat' ? 'Chat' : 'Execution',
                scopeKey: rootType === 'chat'
                  ? resourceScopeKey('chat', rootId)
                  : resourceScopeKey('execution', rootId),
              });
              onClose();
            }}
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
          <div className="flex h-full items-center justify-center p-8 text-center">
            <div className="max-w-sm">
              <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-md border border-app bg-app-muted text-theme-subtle">
                <FileText className="h-5 w-5" />
              </div>
              <div className="text-sm font-semibold text-theme-primary">Open a document</div>
              <div className="mt-1 text-xs leading-relaxed text-theme-muted">
                Select a saved file to open it as a document tab with comments and history.
              </div>
            </div>
          </div>
        </div>
      </aside>
    </div>,
    document.body,
  );
}
