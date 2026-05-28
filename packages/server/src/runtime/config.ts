export interface ConfigProvider {
  get(key: string): string | undefined;
  require(key: string): string;
}

export interface SecretsProvider {
  getSecret(key: string): Promise<string | undefined>;
  setSecret?(key: string, value: string): Promise<void>;
  deleteSecret?(key: string): Promise<void>;
}

export class EnvConfigProvider implements ConfigProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  get(key: string): string | undefined {
    const value = this.env[key];
    return value === '' ? undefined : value;
  }

  require(key: string): string {
    const value = this.get(key);
    if (value === undefined) throw new Error(`${key} is not set`);
    return value;
  }
}

export class EnvSecretsProvider implements SecretsProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async getSecret(key: string): Promise<string | undefined> {
    const value = this.env[key];
    return value === '' ? undefined : value;
  }

  async setSecret(key: string, value: string): Promise<void> {
    this.env[key] = value;
  }

  async deleteSecret(key: string): Promise<void> {
    delete this.env[key];
  }
}

let runtimeConfigProvider: ConfigProvider = new EnvConfigProvider();
let runtimeSecretsProvider: SecretsProvider = new EnvSecretsProvider();

export function getRuntimeConfigProvider(): ConfigProvider {
  return runtimeConfigProvider;
}

export function getRuntimeSecretsProvider(): SecretsProvider {
  return runtimeSecretsProvider;
}

export function setRuntimeConfigProvider(provider: ConfigProvider): void {
  runtimeConfigProvider = provider;
}

export function setRuntimeSecretsProvider(provider: SecretsProvider): void {
  runtimeSecretsProvider = provider;
}

export function configureRuntimeProviders(options: {
  configProvider?: ConfigProvider;
  secretsProvider?: SecretsProvider;
}): void {
  if (options.configProvider) setRuntimeConfigProvider(options.configProvider);
  if (options.secretsProvider) setRuntimeSecretsProvider(options.secretsProvider);
}

export function resetRuntimeProvidersForTests(): void {
  runtimeConfigProvider = new EnvConfigProvider();
  runtimeSecretsProvider = new EnvSecretsProvider();
}

export function getRuntimeApiBaseUrl(): string {
  const config = getRuntimeConfigProvider();
  return config.get('ALLEN_API_URL')
    ?? config.get('ALLEN_INTERNAL_API_URL')
    ?? `http://localhost:${config.get('PORT') ?? process.env.PORT ?? '4023'}`;
}

export function getRuntimePublicBaseUrl(): string {
  return getRuntimeConfigProvider().get('ALLEN_PUBLIC_URL') ?? getRuntimeApiBaseUrl();
}

export function getRuntimeJwtAccessSecret(): string {
  return getRuntimeConfigProvider().get('JWT_ACCESS_SECRET') ?? '';
}
