import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  resetRuntimeProvidersForTests,
  setRuntimeConfigProvider,
  type ConfigProvider,
} from '../runtime/config.js';

beforeAll(() => {
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-do-not-use-in-prod';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-do-not-use-in-prod';
});

afterEach(() => {
  resetRuntimeProvidersForTests();
});

async function freshImport() {
  // Vitest caches ESM modules, but our module reads env lazily inside each
  // function so a single import is fine for most tests.
  return import('./jwt.js');
}

describe('jwt: signAccessToken + verifyAccessToken', () => {
  it('round-trips a valid access token', async () => {
    const { signAccessToken, verifyAccessToken } = await freshImport();
    const payload = {
      sub: 'user-1',
      email: 'a@b.co',
      role: 'user' as const,
      mustResetPassword: false,
    };
    const token = signAccessToken(payload);
    const decoded = verifyAccessToken(token);
    expect(decoded.sub).toBe('user-1');
    expect(decoded.email).toBe('a@b.co');
    expect(decoded.role).toBe('user');
    expect(decoded.mustResetPassword).toBe(false);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const { verifyAccessToken } = await freshImport();
    const bad = jwt.sign({ sub: 'x' }, 'some-other-secret');
    expect(() => verifyAccessToken(bad)).toThrow();
  });

  it('rejects garbage input', async () => {
    const { verifyAccessToken } = await freshImport();
    expect(() => verifyAccessToken('not-a-jwt')).toThrow();
  });

  it('rejects an expired access token', async () => {
    const { verifyAccessToken } = await freshImport();
    const expired = jwt.sign(
      { sub: 'x', email: 'x@y.z', role: 'user', mustResetPassword: false },
      process.env.JWT_ACCESS_SECRET!,
      { expiresIn: -1 },
    );
    expect(() => verifyAccessToken(expired)).toThrow(/jwt expired/i);
  });

  it('defaults access tokens to seven days when no TTL override is configured', async () => {
    const { signAccessToken } = await freshImport();
    setRuntimeConfigProvider(configProviderWithoutTtls());

    const token = signAccessToken({
      sub: 'user-1',
      email: 'a@b.co',
      role: 'user',
      mustResetPassword: false,
    });
    const decoded = jwt.decode(token) as { iat: number; exp: number };

    expect(decoded.exp - decoded.iat).toBe(7 * 24 * 60 * 60);
  });
});

describe('jwt: createRefreshToken + verifyRefreshToken', () => {
  it('creates a token with jti, tokenHash, and a future expiry', async () => {
    const { createRefreshToken, verifyRefreshToken, hashToken } = await freshImport();
    const { token, jti, tokenHash, expiresAt } = createRefreshToken('user-42');

    expect(jti).toMatch(/^[a-f0-9]{32}$/);
    expect(tokenHash).toBe(hashToken(token));
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const payload = verifyRefreshToken(token);
    expect(payload.sub).toBe('user-42');
    expect(payload.jti).toBe(jti);
  });

  it('two refresh tokens for the same user get different jtis and hashes', async () => {
    const { createRefreshToken } = await freshImport();
    const a = createRefreshToken('u1');
    const b = createRefreshToken('u1');
    expect(a.jti).not.toBe(b.jti);
    expect(a.tokenHash).not.toBe(b.tokenHash);
    expect(a.token).not.toBe(b.token);
  });

  it('defaults refresh tokens to thirty days when no TTL override is configured', async () => {
    const { createRefreshToken } = await freshImport();
    setRuntimeConfigProvider(configProviderWithoutTtls());

    const { token, expiresAt } = createRefreshToken('user-42');
    const decoded = jwt.decode(token) as { iat: number; exp: number };

    expect(decoded.exp - decoded.iat).toBe(30 * 24 * 60 * 60);
    expect(expiresAt.getTime()).toBe(decoded.exp * 1000);
  });
});

describe('jwt: hashToken', () => {
  it('is deterministic and hex-encoded sha256', async () => {
    const { hashToken } = await freshImport();
    const a = hashToken('hello');
    const b = hashToken('hello');
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken('hello')).not.toBe(hashToken('world'));
  });
});

function configProviderWithoutTtls(): ConfigProvider {
  return {
    get: (key) => ({
      JWT_ACCESS_SECRET: 'test-access-secret-do-not-use-in-prod',
      JWT_REFRESH_SECRET: 'test-refresh-secret-do-not-use-in-prod',
    } as Record<string, string | undefined>)[key],
    require(key) {
      const value = this.get(key);
      if (!value) throw new Error(`${key} is not set`);
      return value;
    },
  };
}
