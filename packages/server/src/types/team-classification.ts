export const TEAM_CLASSIFICATIONS = [
  'engineering',
  'marketing',
  'product',
  'design',
] as const;

export type TeamClassification = typeof TEAM_CLASSIFICATIONS[number];
export type TeamClassificationSource = 'manual' | 'studio_default' | 'inherited';

export function isTeamClassification(value: unknown): value is TeamClassification {
  return typeof value === 'string'
    && (TEAM_CLASSIFICATIONS as readonly string[]).includes(value);
}

export function parseTeamClassification(
  value: unknown,
  fieldName = 'teamClassification',
): TeamClassification | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (!isTeamClassification(value)) {
    throw Object.assign(
      new Error(`${fieldName} must be engineering | marketing | product | design | null`),
      { statusCode: 400 },
    );
  }
  return value;
}
