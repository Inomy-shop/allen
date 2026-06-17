import { useCallback, useRef, useState, type DragEvent, type DragEventHandler } from 'react';
import { Paperclip } from 'lucide-react';

export interface FileDropZoneProps {
  onDragEnter: DragEventHandler;
  onDragOver: DragEventHandler;
  onDragLeave: DragEventHandler;
  onDrop: DragEventHandler;
}

export interface FileDropZone {
  /** True while files are being dragged anywhere over the zone. */
  dragActive: boolean;
  /** Spread onto the element that should accept drops (e.g. a page root). */
  dropProps: FileDropZoneProps;
}

function isFileDrag(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

/**
 * Turns any element into a file drop zone. Tracks drag enter/leave with a
 * counter so moving the cursor across nested children does not flicker the
 * overlay, and ignores non-file drags (text, links, internal DnD).
 *
 * The composer (ChatInput) stops propagation on its own drop, so dropping
 * directly on it is handled there and never reaches this zone — no double
 * upload.
 */
export function useFileDropZone(
  onFiles: (files: FileList | File[]) => void,
  disabled = false,
): FileDropZone {
  const [dragActive, setDragActive] = useState(false);
  const counter = useRef(0);

  const onDragEnter = useCallback((e: DragEvent) => {
    if (disabled || !isFileDrag(e)) return;
    e.preventDefault();
    counter.current += 1;
    setDragActive(true);
  }, [disabled]);

  const onDragOver = useCallback((e: DragEvent) => {
    if (disabled || !isFileDrag(e)) return;
    e.preventDefault();
  }, [disabled]);

  const onDragLeave = useCallback((e: DragEvent) => {
    if (disabled || !isFileDrag(e)) return;
    e.preventDefault();
    counter.current -= 1;
    if (counter.current <= 0) {
      counter.current = 0;
      setDragActive(false);
    }
  }, [disabled]);

  const onDrop = useCallback((e: DragEvent) => {
    if (disabled) return;
    e.preventDefault();
    counter.current = 0;
    setDragActive(false);
    if (e.dataTransfer.files?.length) onFiles(e.dataTransfer.files);
  }, [disabled, onFiles]);

  return { dragActive, dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}

/**
 * Overlay shown while a file is dragged over a drop zone. `pointer-events-none`
 * lets the drop fall through to the real target underneath (page root or
 * composer).
 *
 * Defaults to full-viewport (`fixed`), which suits full-page drop zones. Pass
 * `contained` for a zone that occupies only part of the screen (e.g. an
 * embedded panel) — the overlay then covers just the zone via `absolute`, so
 * the zone's root must be positioned (e.g. `relative`).
 */
export function FileDropOverlay({ label = 'Drop files to attach', contained = false }: { label?: string; contained?: boolean }) {
  return (
    <div className={`pointer-events-none z-[120] flex items-center justify-center bg-app/70 backdrop-blur-sm ${contained ? 'absolute inset-0' : 'fixed inset-0'}`}>
      <div className="flex items-center gap-2 rounded-lg border-2 border-dashed border-accent-blue bg-app-card px-6 py-4 text-sm font-mono text-accent-blue shadow-2xl">
        <Paperclip className="h-4 w-4" />
        {label}
      </div>
    </div>
  );
}
