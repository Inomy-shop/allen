export function isSeedOverrideEnabled(): boolean {
  return process.env.SEED_OVERRIDE?.trim().toLowerCase() === 'true';
}
