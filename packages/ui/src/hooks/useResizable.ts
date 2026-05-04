import { useState, useCallback } from 'react';

type Direction = 'horizontal' | 'vertical';

interface UseResizableOptions {
  direction: Direction;
  initialSize: number;
  minSize: number;
  maxSize: number;
  /** 'right' or 'bottom' = drag towards origin increases size (default). 'left' or 'top' = drag away from origin increases size. */
  side?: 'start' | 'end';
  /** 'px' (default) or 'percent' — when percent, delta is converted relative to container */
  unit?: 'px' | 'percent';
}

export function useResizable({ direction, initialSize, minSize, maxSize, side = 'end', unit = 'px' }: UseResizableOptions) {
  const [size, setSize] = useState(initialSize);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startPos = direction === 'horizontal' ? e.clientX : e.clientY;
    const startSize = size;
    const containerSize = direction === 'horizontal' ? window.innerWidth : window.innerHeight;

    const onMove = (ev: MouseEvent) => {
      const currentPos = direction === 'horizontal' ? ev.clientX : ev.clientY;
      const rawDelta = side === 'end' ? startPos - currentPos : currentPos - startPos;
      const delta = unit === 'percent' ? (rawDelta / containerSize) * 100 : rawDelta;
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
