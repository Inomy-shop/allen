export type RecoveryModelOption = {
  fullId: string;
  tier?: string | null;
};

export function pickRecoveryDefaultModel(provider: string, models: RecoveryModelOption[]): string {
  if (models.length === 0) return '';

  if (provider === 'claude') {
    return models.find((model) => model.fullId === 'claude-opus-4-8')?.fullId
      ?? models.find((model) => model.tier === 'opus')?.fullId
      ?? models.find((model) => model.tier === 'default')?.fullId
      ?? models[0]?.fullId
      ?? '';
  }

  return models.find((model) => model.tier === 'default')?.fullId
    ?? models[0]?.fullId
    ?? '';
}
