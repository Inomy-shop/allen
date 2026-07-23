import type { HTMLAttributes, ReactNode } from 'react';

interface TypeProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
}

export function Eyebrow({ children, className = '', ...props }: TypeProps) {
  return <div className={`type-eyebrow ${className}`.trim()} {...props}>{children}</div>;
}

export function DisplayTitle({ children, className = '', ...props }: TypeProps) {
  return <h1 className={`type-display ${className}`.trim()} {...props}>{children}</h1>;
}

export function SectionTitle({ children, className = '', ...props }: TypeProps) {
  return <h2 className={`type-section ${className}`.trim()} {...props}>{children}</h2>;
}

export function Meta({ children, className = '', ...props }: TypeProps) {
  return <span className={`type-meta ${className}`.trim()} {...props}>{children}</span>;
}
