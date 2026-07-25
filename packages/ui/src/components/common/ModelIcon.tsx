import ProviderIcon, { providerIconColor } from './ProviderIcon';

type ModelIconProps = {
  provider?: string | null;
  className?: string;
};

export function modelIconColor(provider?: string | null): string {
  return providerIconColor(provider);
}

export default function ModelIcon({ provider, className }: ModelIconProps) {
  return <ProviderIcon provider={provider} className={className} />;
}
