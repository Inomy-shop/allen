import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFileDropZone } from '../useFileDropZone';

function createDragEvent({
  defaultPrevented = false,
  files = [] as File[],
}: {
  defaultPrevented?: boolean;
  files?: File[];
} = {}) {
  return {
    defaultPrevented,
    preventDefault: vi.fn(),
    dataTransfer: {
      types: ['Files'],
      files: files as unknown as FileList,
    },
  };
}

function createNonFileDragEvent() {
  return {
    defaultPrevented: false,
    preventDefault: vi.fn(),
    dataTransfer: {
      types: ['text/plain'],
      files: [] as unknown as FileList,
    },
  };
}

describe('useFileDropZone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls onFiles when defaultPrevented is false and files are present (b)', () => {
    const onFiles = vi.fn();
    const file = new File(['content'], 'test.txt', { type: 'text/plain' });
    const { result } = renderHook(() => useFileDropZone(onFiles));

    const event = createDragEvent({ files: [file] });

    act(() => {
      result.current.dropProps.onDrop(event as unknown as React.DragEvent);
    });

    // dragActive is reset to false
    expect(result.current.dragActive).toBe(false);
    // onFiles is called with the files
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onFiles when defaultPrevented is true, but resets dragActive (a)', () => {
    const onFiles = vi.fn();
    const file = new File(['content'], 'test.txt', { type: 'text/plain' });
    const { result } = renderHook(() => useFileDropZone(onFiles));

    const event = createDragEvent({ defaultPrevented: true, files: [file] });

    act(() => {
      result.current.dropProps.onDrop(event as unknown as React.DragEvent);
    });

    // dragActive is reset to false regardless
    expect(result.current.dragActive).toBe(false);
    // onFiles is NOT called because the drop was already handled by a child
    expect(onFiles).not.toHaveBeenCalled();
  });

  it('is a no-op when disabled is true (c)', () => {
    const onFiles = vi.fn();
    const file = new File(['content'], 'test.txt', { type: 'text/plain' });
    const { result } = renderHook(() => useFileDropZone(onFiles, true));

    const event = createDragEvent({ files: [file] });

    act(() => {
      result.current.dropProps.onDrop(event as unknown as React.DragEvent);
    });

    // dragActive remains false (was never set)
    expect(result.current.dragActive).toBe(false);
    // onFiles is not called
    expect(onFiles).not.toHaveBeenCalled();
    // preventDefault is not called either
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('clears dragActive after onDragEnter + child-handled onDrop (d)', () => {
    const onFiles = vi.fn();
    const file = new File(['content'], 'test.txt', { type: 'text/plain' });
    const { result } = renderHook(() => useFileDropZone(onFiles));

    // Simulate drag entering the zone
    const enterEvent = createDragEvent({ files: [] });
    act(() => {
      result.current.dropProps.onDragEnter(enterEvent as unknown as React.DragEvent);
    });

    // dragActive is now true
    expect(result.current.dragActive).toBe(true);

    // Simulate a child-handled drop (e.g. ChatInput handled it)
    const dropEvent = createDragEvent({ defaultPrevented: true, files: [file] });
    act(() => {
      result.current.dropProps.onDrop(dropEvent as unknown as React.DragEvent);
    });

    // dragActive was reset to false despite defaultPrevented = true
    expect(result.current.dragActive).toBe(false);
    // onFiles was NOT called because the child already handled it
    expect(onFiles).not.toHaveBeenCalled();
  });
});
