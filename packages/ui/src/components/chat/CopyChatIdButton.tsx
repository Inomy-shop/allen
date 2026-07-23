import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';

type Props = {
  chatId: string;
  chatTitle?: string;
  className?: string;
};

async function writeClipboardText(text: string): Promise<void> {
  if (window.allenDesktop?.writeClipboardText) {
    const copied = await window.allenDesktop.writeClipboardText(text);
    if (!copied) throw new Error('Failed to copy chat ID');
    return;
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!copied) throw new Error('Failed to copy chat ID');
}

export default function CopyChatIdButton({ chatId, chatTitle, className }: Props) {
  const [copied, setCopied] = useState(false);
  const labelSuffix = chatTitle ? ` for ${chatTitle}` : '';

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  async function handleCopy(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    try {
      await writeClipboardText(chatId);
      setCopied(true);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to copy chat ID');
    }
  }

  const label = copied ? `Chat ID copied${labelSuffix}` : `Copy chat ID${labelSuffix}`;

  return (
    <button type="button" className={className} onClick={handleCopy} aria-label={label} title={label}>
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </button>
  );
}
