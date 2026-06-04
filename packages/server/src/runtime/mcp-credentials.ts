import { getRuntimeConfigProvider, getRuntimeSecretsProvider } from './config.js';

export function mcpCredentialEnvKey(key: string): string {
  return key.startsWith('ALLEN_') ? key : `ALLEN_${key}`;
}

export async function resolveMcpCredentialSourceEnv(keys: string[]): Promise<Record<string, string>> {
  const config = getRuntimeConfigProvider();
  const secrets = getRuntimeSecretsProvider();
  const sourceEnv: Record<string, string> = {};

  for (const key of keys) {
    const envKey = mcpCredentialEnvKey(key);
    const value = await secrets.getSecret(envKey) ?? config.get(envKey);
    if (value !== undefined && value !== '') sourceEnv[envKey] = value;
  }

  return sourceEnv;
}

export async function listMissingMcpCredentialEnv(keys: string[]): Promise<string[]> {
  const sourceEnv = await resolveMcpCredentialSourceEnv(keys);
  return keys.map(mcpCredentialEnvKey).filter((key) => sourceEnv[key] === undefined || sourceEnv[key] === '');
}

export async function buildMcpSourceEnvForServer(server: {
  envKeys?: string[];
  argKeys?: string[];
}): Promise<Record<string, string>> {
  return resolveMcpCredentialSourceEnv([
    ...(server.envKeys ?? []),
    ...(server.argKeys ?? []),
  ]);
}
