import { useState, useCallback, useRef, useEffect } from 'react';

interface PanelLayoutOptions {
  storageKey: string;
  direction: 'horizontal' | 'vertical';
  defaultSize: number;
  minSize: number;
  maxSize: number;
  defaultCollapsed?: boolean;
  invertDelta?: boolean; // true for right-anchored panels (chat, services, activity)
}

export interface PanelLayoutResult {
  size: number;
  collapsed: boolean;
  toggle: () => void;
  collapse: () => void;
  expand: () => void;
  onMouseDown: (e: React.MouseEvent) => void;
}

const PREFIX = 'allen-panel-';

export function usePanelLayout({
  storageKey,
  direction,
  defaultSize,
  minSize,
  maxSize,
  defaultCollapsed = false,
  invertDelta = false,
}: PanelLayoutOptions): PanelLayoutResult {
  const sizeKey = PREFIX + storageKey + '-size';
  const collapsedKey = PREFIX + storageKey + '-collapsed';

  const [size, setSize] = useState<number>(() => {
    try {
      const v = localStorage.getItem(sizeKey);
      if (v !== null) {
        const n = parseFloat(v);
        if (!isNaN(n) && n >= minSize && n <= maxSize) return n;
      }
    } catch {}
    return defaultSize;
  });

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(collapsedKey);
      if (v !== null) return v === '1';
    } catch {}
    return defaultCollapsed;
  });

  const dragging = useRef(false);
  const lastPos = useRef(0);

  // Persist size whenever it changes
  useEffect(() => {
    try { localStorage.setItem(sizeKey, String(size)); } catch {}
  }, [sizeKey, size]);

  // Persist collapsed whenever it changes
  useEffect(() => {
    try { localStorage.setItem(collapsedKey, collapsed ? '1' : '0'); } catch {}
  }, [collapsedKey, collapsed]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    document.body.style.userSelect = 'none';
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
    dragging.current = true;
    lastPos.current = direction === 'horizontal' ? e.clientX : e.clientY;

    function onMouseMove(ev: MouseEvent) {
      if (!dragging.current) return;
      const pos = direction === 'horizontal' ? ev.clientX : ev.clientY;
      const delta = invertDelta ? lastPos.current - pos : pos - lastPos.current;
      lastPos.current = pos;
      setSize(prev => Math.min(maxSize, Math.max(minSize, prev + delta)));
    }

    function onMouseUp() {
      dragging.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    }

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [direction, invertDelta, minSize, maxSize]);

  const toggle = useCallback(() => setCollapsed(c => !c), []);
  const collapse = useCallback(() => setCollapsed(true), []);
  const expand = useCallback(() => setCollapsed(false), []);

  return { size, collapsed, toggle, collapse, expand, onMouseDown };
}
