import { Sparkles } from 'lucide-react';
import type { SVGProps } from 'react';
import BrandMarkIcon from './BrandMarkIcon';
import { getBrandMark } from './brandMarks';

type ProviderIconProps = {
  provider?: string | null;
  className?: string;
};

/**
 * Nearest theme token to each vendor's official brand colour. Marks render with
 * `fill: currentColor`, so these keep a mark legible in both themes rather than
 * painting a near-black logo onto a dark background.
 */
const PROVIDER_ICON_COLORS: Record<string, string> = {
  openai: 'text-accent-green',
  chatgpt: 'text-accent-green',
  codex: 'text-accent-green',
  anthropic: 'text-accent',
  claude: 'text-accent',
  'claude-cli': 'text-accent',
  deepseek: 'text-accent-blue',
  // Z.AI ships GLM under provider id 'zai'. Mark is near-black (#2D2D2D).
  zai: 'text-theme-primary',
  // Xiaomi is orange (#FF6900) and Kimi is black — both previously rendered blue.
  'xiaomi-mimo': 'text-accent-orange',
  kimi: 'text-theme-primary',
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

/**
 * OpenAI is the one provider with no authentic mark available — simple-icons
 * carries no OpenAI logo — so this approximation is retained rather than
 * regressing Codex to a generic sparkle. Replace it if an official mark lands.
 */
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

export default function ProviderIcon({ provider, className }: ProviderIconProps) {
  const iconProvider = normalizeProviderIconId(provider);

  if (getBrandMark(iconProvider)) {
    return <BrandMarkIcon id={iconProvider} className={className} data-provider-icon={iconProvider} />;
  }

  const props = { className, 'data-provider-icon': iconProvider };
  if (iconProvider === 'openai') return <OpenAIIcon {...props} />;
  return <Sparkles aria-hidden="true" {...props} />;
}
