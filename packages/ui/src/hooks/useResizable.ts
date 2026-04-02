import { useState, useCallback } from 'react';

type Direction = 'horizontal' | 'vertical';

interface UseResizableOptions {
  direction: Direction;
  initialSize: number;
  minSize: number;
  maxSize: number;
}

export function useResizable({ direction, initialSize, minSize, maxSize }: UseResizableOptions) {
  const [size, setSize] = useState(initialSize);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startPos = direction === 'horizontal' ? e.clientX : e.clientY;
    const startSize = size;

    const onMove = (ev: MouseEvent) => {
      const currentPos = direction === 'horizontal' ? ev.clientX : ev.clientY;
      // For horizontal: drag left = increase (panel is on right side)
      // For vertical: drag up = increase (panel is on bottom)
      const delta = startPos - currentPos;
      setSize(Math.max(minSize, Math.min(startSize + delta, maxSize)));
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [size, direction, minSize, maxSize]);

  return { size, handleMouseDown };
}
