import { beforeEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { buildInternalApiHeaders } from './cron.service.js';

describe('buildInternalApiHeaders', () => {
  beforeEach(() => {
    process.env.JWT_ACCESS_SECRET = 'test-access-secret-do-not-use-in-prod';
  });

  it('mints an admin bearer token for internal cron self-calls', () => {
    const headers = buildInternalApiHeaders() as Record<string, string>;

    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toMatch(/^Bearer /);

    const token = headers.Authorization.replace(/^Bearer /, '');
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET!) as Record<string, unknown>;

    expect(decoded.sub).toBe('cron-system');
    expect(decoded.email).toBe('cron@internal.local');
    expect(decoded.role).toBe('admin');
    expect(decoded.mustResetPassword).toBe(false);
  });
});
