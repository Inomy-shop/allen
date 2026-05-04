export const SELF_HEALING_LINEAR_ENV_KEYS = [
  'ALLEN_SELF_HEALING_LINEAR_TEAM_KEY',
  'ALLEN_SELF_HEALING_LINEAR_PROJECT_NAME',
  'ALLEN_SELF_HEALING_ASSIGNEE_EMAIL',
] as const;

export interface SelfHealingLinearConfig {
  teamKey: string;
  projectName: string;
  assigneeEmail: string;
}

export function getSelfHealingLinearConfig(): SelfHealingLinearConfig | null {
  const teamKey = process.env.ALLEN_SELF_HEALING_LINEAR_TEAM_KEY?.trim();
  const projectName = process.env.ALLEN_SELF_HEALING_LINEAR_PROJECT_NAME?.trim();
  const assigneeEmail = process.env.ALLEN_SELF_HEALING_ASSIGNEE_EMAIL?.trim();
  if (!teamKey || !projectName || !assigneeEmail) return null;
  return { teamKey, projectName, assigneeEmail };
}

export function missingSelfHealingLinearEnv(): string[] {
  return SELF_HEALING_LINEAR_ENV_KEYS.filter((key) => !process.env[key]?.trim());
}

export function assertSelfHealingLinearConfig(): SelfHealingLinearConfig {
  const config = getSelfHealingLinearConfig();
  if (config) return config;
  const missing = missingSelfHealingLinearEnv();
  throw new Error(`Self-healing monitoring is disabled. Missing required env vars: ${missing.join(', ')}`);
}

export function isSelfHealingWorkflowName(name: string | undefined): boolean {
  return name === 'allen-self-healing-monitor-hourly';
}
