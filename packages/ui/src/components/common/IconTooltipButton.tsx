import type { ButtonHTMLAttributes, ReactNode } from 'react';

type TooltipSide = 'top' | 'right' | 'bottom' | 'left';
type TooltipTone = 'neutral' | 'danger' | 'accent' | 'warning';

interface IconTooltipButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  side?: TooltipSide;
  tone?: TooltipTone;
  children: ReactNode;
}

const sideClasses: Record<TooltipSide, { bubble: string; arrow: string }> = {
  top: {
    bubble: 'bottom-full left-1/2 mb-2 -translate-x-1/2 translate-y-1 group-hover:translate-y-0 group-focus-visible:translate-y-0',
    arrow: 'left-1/2 top-full -translate-x-1/2 border-l-[6px] border-r-[6px] border-t-[7px] border-l-transparent border-r-transparent border-t-[rgb(var(--color-text-primary))]',
  },
  right: {
    bubble: 'left-full top-1/2 ml-3 -translate-y-1/2 translate-x-1 group-hover:translate-x-0 group-focus-visible:translate-x-0',
    arrow: 'right-full top-1/2 -translate-y-1/2 border-y-[6px] border-r-[7px] border-y-transparent border-r-[rgb(var(--color-text-primary))]',
  },
  bottom: {
    bubble: 'left-1/2 top-full mt-2 -translate-x-1/2 -translate-y-1 group-hover:translate-y-0 group-focus-visible:translate-y-0',
    arrow: 'bottom-full left-1/2 -translate-x-1/2 border-b-[7px] border-l-[6px] border-r-[6px] border-b-[rgb(var(--color-text-primary))] border-l-transparent border-r-transparent',
  },
  left: {
    bubble: 'right-full top-1/2 mr-3 -translate-x-1 -translate-y-1/2 group-hover:translate-x-0 group-focus-visible:translate-x-0',
    arrow: 'left-full top-1/2 -translate-y-1/2 border-y-[6px] border-l-[7px] border-y-transparent border-l-[rgb(var(--color-text-primary))]',
  },
};

const toneClasses: Record<TooltipTone, string> = {
  neutral: 'text-theme-muted hover:bg-app-muted hover:text-theme-secondary',
  danger: 'text-theme-muted hover:bg-accent-red/10 hover:text-accent-red',
  accent: 'text-theme-muted hover:bg-app-muted hover:text-accent-blue',
  warning: 'text-theme-muted hover:bg-app-muted hover:text-accent-yellow',
};

export default function IconTooltipButton({
  label,
  side = 'top',
  tone = 'neutral',
  className = '',
  children,
  disabled,
  type = 'button',
  ...props
}: IconTooltipButtonProps) {
  const placement = sideClasses[side];
  const normalizedLabel = label.trim().toLowerCase();
  const showTooltip = !disabled && normalizedLabel !== 'close' && !normalizedLabel.startsWith('refresh');

  return (
    <button
      {...props}
      type={type}
      disabled={disabled}
      aria-label={props['aria-label'] ?? label}
      className={`group relative inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${toneClasses[tone]} ${className}`}
    >
      {children}
      {showTooltip && (
        <span
          className={`pointer-events-none absolute z-50 max-w-[180px] scale-[0.985] whitespace-nowrap rounded-md border-0 bg-[rgb(var(--color-text-primary))] px-2 py-1.5 text-[12px] font-medium leading-[1.2] text-[rgb(var(--color-surface-100))] opacity-0 shadow-lg transition-all duration-150 group-hover:scale-100 group-hover:opacity-100 group-focus-visible:scale-100 group-focus-visible:opacity-100 ${placement.bubble}`}
        >
          {label}
          <span className={`absolute h-0 w-0 ${placement.arrow}`} />
        </span>
      )}
    </button>
  );
}
