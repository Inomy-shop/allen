import { afterEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  EnvConfigProvider,
  EnvSecretsProvider,
  resetRuntimeProvidersForTests,
  setRuntimeConfigProvider,
  setRuntimeSecretsProvider,
  type ConfigProvider,
} from './config.js';
import { signAccessToken } from '../auth/jwt.js';
import { buildGhEnv, hasGithubToken } from '../services/github-auth.js';

describe('runtime config providers', () => {
  afterEach(() => {
    resetRuntimeProvidersForTests();
  });

  it('reads non-empty env values and treats empty values as missing', () => {
    const provider = new EnvConfigProvider({
      PRESENT: 'value',
      EMPTY: '',
    });

    expect(provider.get('PRESENT')).toBe('value');
    expect(provider.get('EMPTY')).toBeUndefined();
    expect(provider.get('MISSING')).toBeUndefined();
    expect(() => provider.require('MISSING')).toThrow('MISSING is not set');
  });

  it('lets JWT signing use an injected config provider', () => {
    const provider: ConfigProvider = {
      get: (key) => ({
        JWT_ACCESS_SECRET: 'phase-2-access-secret',
        JWT_REFRESH_SECRET: 'phase-2-refresh-secret',
      } as Record<string, string | undefined>)[key],
      require(key) {
        const value = this.get(key);
        if (!value) throw new Error(`${key} is not set`);
        return value;
      },
    };
    setRuntimeConfigProvider(provider);

    const token = signAccessToken({
      sub: 'user-1',
      email: 'user@example.com',
      role: 'user',
      mustResetPassword: false,
    });

    const decoded = jwt.verify(token, 'phase-2-access-secret') as Record<string, unknown>;
    expect(decoded.sub).toBe('user-1');
  });
});

describe('runtime secret providers', () => {
  afterEach(() => {
    resetRuntimeProvidersForTests();
  });

  it('lets GitHub auth use an injected secrets provider', async () => {
    setRuntimeSecretsProvider(new EnvSecretsProvider({
      ALLEN_GITHUB_PERSONAL_ACCESS_TOKEN: 'github-token-from-provider',
      PATH: '/usr/bin',
    }));

    await expect(hasGithubToken()).resolves.toBe(true);
    await expect(buildGhEnv()).resolves.toMatchObject({
      GH_TOKEN: 'github-token-from-provider',
      GITHUB_TOKEN: 'github-token-from-provider',
    });
  });

  it('lets the default env secrets provider accept runtime secret writes', async () => {
    const env: NodeJS.ProcessEnv = {};
    const provider = new EnvSecretsProvider(env);

    await provider.setSecret('ALLEN_MCP_TEST_TOKEN', 'token-from-dialog');
    await expect(provider.getSecret('ALLEN_MCP_TEST_TOKEN')).resolves.toBe('token-from-dialog');

    await provider.deleteSecret('ALLEN_MCP_TEST_TOKEN');
    await expect(provider.getSecret('ALLEN_MCP_TEST_TOKEN')).resolves.toBeUndefined();
  });
});
