import { useState } from 'react';
import { Copy, Check, Download } from 'lucide-react';

/** Small clipboard-copy button. Flashes a checkmark on success. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch { /* ignore */ }
      }}
      className="px-1.5 py-1 rounded-md hover:bg-surface-200/60 text-theme-muted hover:text-accent-blue transition-colors flex items-center gap-1 text-[11px]"
      title={label}
    >
      {copied ? <Check className="w-3 h-3 text-accent-green" /> : <Copy className="w-3 h-3" />}
      {copied ? 'Copied' : label}
    </button>
  );
}

/** Download-as-file button. Uses a blob URL; cleans up after. */
export function DownloadButton({
  content,
  filename,
  mime = 'application/json',
  label = 'Download',
}: {
  content: string;
  filename: string;
  mime?: string;
  label?: string;
}) {
  return (
    <button
      onClick={() => {
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }}
      className="px-1.5 py-1 rounded-md hover:bg-surface-200/60 text-theme-muted hover:text-accent-blue transition-colors flex items-center gap-1 text-[11px]"
      title={label}
    >
      <Download className="w-3 h-3" />
      {label}
    </button>
  );
}
