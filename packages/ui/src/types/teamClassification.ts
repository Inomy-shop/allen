export const TEAM_CLASSIFICATIONS = [
  'engineering',
  'marketing',
  'product',
  'design',
] as const;

export type TeamClassification = typeof TEAM_CLASSIFICATIONS[number];
export type TeamClassificationSource = 'manual' | 'studio_default' | 'inherited';
export type TeamClassificationValue = TeamClassification | null;
export type TeamClassificationKey = TeamClassification | 'unknown';
export type TeamClassificationFilter = TeamClassification | 'unknown' | 'all';

export const TEAM_CLASSIFICATION_META: Record<
  TeamClassification | 'unknown',
  { label: string; short: string; color: string }
> = {
  engineering: { label: 'Engineering', short: 'eng', color: '#5B7FC7' },
  marketing: { label: 'Marketing', short: 'mkt', color: '#B0568F' },
  product: { label: 'Product', short: 'prod', color: '#3C9D8A' },
  design: { label: 'Design', short: 'dsgn', color: '#8B6CC9' },
  unknown: { label: 'Unknown', short: '—', color: '#7B8190' },
};

export function effectiveTeamClassification(
  value?: TeamClassification | null,
  studioWorkspaceId?: string | null,
): TeamClassification | null {
  if (value) return value;
  return studioWorkspaceId ? 'design' : null;
}

export function teamClassificationKey(
  value?: TeamClassification | null,
  studioWorkspaceId?: string | null,
): TeamClassification | 'unknown' {
  return effectiveTeamClassification(value, studioWorkspaceId) ?? 'unknown';
}
