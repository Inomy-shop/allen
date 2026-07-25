import type { SVGProps } from 'react';
import { getBrandMark } from './brandMarks';

type BrandMarkIconProps = Omit<SVGProps<SVGSVGElement>, 'id'> & {
  /** Provider id or MCP preset name, e.g. 'claude', 'zai', 'linear'. */
  id?: string | null;
  /**
   * 'current' inherits the surrounding text colour — use inline, where the mark
   * has to stay legible in both themes. 'brand' paints the official colour, for
   * tiles and other places the mark sits on a neutral background.
   */
  tone?: 'current' | 'brand';
};

/**
 * Renders a vendor's real logo. Returns null when no authentic mark exists for
 * the id, so callers can fall back to a neutral icon rather than a made-up one.
 */
export default function BrandMarkIcon({ id, tone = 'current', ...props }: BrandMarkIconProps) {
  const mark = getBrandMark(id);
  if (!mark) return null;

  return (
    <svg
      viewBox="0 0 24 24"
      fill={tone === 'brand' ? mark.hex : 'currentColor'}
      role="img"
      aria-label={mark.title}
      data-brand-mark={mark.id}
      {...props}
    >
      <path d={mark.path} />
    </svg>
  );
}
