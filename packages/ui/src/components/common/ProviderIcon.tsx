import { Sparkles } from 'lucide-react';
import type { SVGProps } from 'react';

type ProviderIconProps = {
  provider?: string | null;
  className?: string;
};

const PROVIDER_ICON_COLORS: Record<string, string> = {
  openai: 'text-accent-green',
  chatgpt: 'text-accent-green',
  codex: 'text-accent-green',
  anthropic: 'text-accent',
  claude: 'text-accent',
  'claude-cli': 'text-accent',
  deepseek: 'text-accent-blue',
  'xiaomi-mimo': 'text-accent-blue',
  kimi: 'text-accent-blue',
};

export function normalizeProviderIconId(provider?: string | null): string {
  const normalized = provider?.trim().toLowerCase() || 'unknown';
  if (normalized === 'openai' || normalized === 'chatgpt' || normalized === 'codex') return 'openai';
  if (normalized === 'anthropic' || normalized === 'claude' || normalized === 'claude-cli') return 'claude';
  return normalized;
}

export function providerIconColor(provider?: string | null): string {
  return PROVIDER_ICON_COLORS[provider?.trim().toLowerCase() || ''] ?? 'text-theme-muted';
}

function OpenAIIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M12 3.4a4.1 4.1 0 0 1 3.9 2.8 4.1 4.1 0 0 1 4.2 4.1 4.2 4.2 0 0 1-1.8 3.4 4.1 4.1 0 0 1-5.9 5.5 4.1 4.1 0 0 1-6.3-2.3 4.1 4.1 0 0 1-2.2-7.5A4.1 4.1 0 0 1 8.6 4a4.1 4.1 0 0 1 3.4-.6Z"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinejoin="round"
      />
      <path
        d="M8.7 4.1 15 7.7v7.2l-6.3 3.6M4 9.4l6.3 3.6 6.2-3.6M6.1 16.9V9.8l6.2-3.6M18.3 13.7l-6.2-3.6-6.2 3.6M12.3 19.2v-7.1l6.2-3.6"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ClaudeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="12" r="2.4" fill="currentColor" />
    </svg>
  );
}

function DeepSeekIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M4.2 12.3c0-4.3 3.4-7.8 7.7-7.8 3.1 0 5.8 1.8 7 4.4.5 1.1.8 2.3.8 3.5 0 4.3-3.4 7.7-7.8 7.7-1.8 0-3.5-.6-4.8-1.6l-2.8.8.8-2.7a7.6 7.6 0 0 1-.9-4.3Z"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinejoin="round"
      />
      <path
        d="M7.7 11.5c1.7 1.5 3.4 2.1 5.3 1.8 1.3-.2 2.4-.8 3.3-1.8M8.3 9.2c1.9-.9 3.8-.8 5.7.2M8.8 14.9c1.5.7 3.2.8 5 .2"
        stroke="currentColor"
        strokeWidth="1.45"
        strokeLinecap="round"
      />
      <circle cx="8.4" cy="8.7" r="0.85" fill="currentColor" />
    </svg>
  );
}

function XiaomiMimoIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <rect x="3.8" y="4.6" width="16.4" height="14.8" rx="3.4" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M7.7 15.5V9.3h2.4l1.9 3.3 1.9-3.3h2.4v6.2M10.1 15.5v-3.2M13.9 15.5v-3.2"
        stroke="currentColor"
        strokeWidth="1.45"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function KimiIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="8.1" stroke="currentColor" strokeWidth="1.65" />
      <path
        d="M8.7 7.8v8.4M15.6 8.1l-6.2 5 6.7 3.1M13.2 10.6l3.2-2.8M13.5 13.9l3.1 2.5"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M17.9 5.7 19.2 4.4M6.1 18.3l-1.3 1.3" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}

export default function ProviderIcon({ provider, className }: ProviderIconProps) {
  const iconProvider = normalizeProviderIconId(provider);
  const props = { className, 'data-provider-icon': iconProvider };

  if (iconProvider === 'openai') return <OpenAIIcon {...props} />;
  if (iconProvider === 'claude') return <ClaudeIcon {...props} />;
  if (iconProvider === 'deepseek') return <DeepSeekIcon {...props} />;
  if (iconProvider === 'xiaomi-mimo') return <XiaomiMimoIcon {...props} />;
  if (iconProvider === 'kimi') return <KimiIcon {...props} />;
  return <Sparkles aria-hidden="true" {...props} />;
}
