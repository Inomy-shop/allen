interface ShortcutKeyProps {
  value: string;
  className?: string;
  ariaLabel?: string;
}

function readableShortcut(value: string): string {
  return value
    .replace(/⌘/g, 'Command ')
    .replace(/↵/g, 'Enter')
    .replace(/↑/g, 'Up')
    .replace(/↓/g, 'Down')
    .trim();
}

export default function ShortcutKey({ value, className = '', ariaLabel }: ShortcutKeyProps) {
  return (
    <span
      className={`inline-flex h-[22px] min-w-[34px] items-center justify-center gap-[2px] rounded-md border border-app bg-app-muted px-1.5 font-mono text-[13px] font-medium leading-none text-theme-subtle ${className}`}
      aria-label={ariaLabel ?? readableShortcut(value)}
    >
      {Array.from(value).map((char, index) => (
        char === '⌘' ? (
          <span key={`${char}-${index}`} className="font-sans text-[14px] font-medium leading-none -translate-y-px">
            {char}
          </span>
        ) : (
          <span key={`${char}-${index}`} className="text-[13px] leading-none">
            {char}
          </span>
        )
      ))}
    </span>
  );
}
