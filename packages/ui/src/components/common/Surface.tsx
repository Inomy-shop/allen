import type { HTMLAttributes, ReactNode } from 'react';

type SurfaceKind = 'card' | 'panel' | 'open';

interface SurfaceProps extends HTMLAttributes<HTMLElement> {
  as?: 'div' | 'section' | 'article';
  kind?: SurfaceKind;
  children: ReactNode;
}

export default function Surface({
  as: Component = 'div',
  kind = 'card',
  className = '',
  children,
  ...props
}: SurfaceProps) {
  return (
    <Component className={`v8-surface v8-surface-${kind} ${className}`.trim()} {...props}>
      {children}
    </Component>
  );
}
