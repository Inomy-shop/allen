import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { makeTestApp, type TestContext } from './testHarness.js';

const BOOT_EMAIL = 'admin@test.local';
const BOOT_PW = 'BootAdmin!234';

describe('auth e2e: seeded admin + login', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await makeTestApp();
  });
  afterAll(async () => {
    await ctx.stop();
  });

  it('has a seeded admin user flagged mustResetPassword', async () => {
    const doc = await ctx.db.collection('users').findOne({ email: BOOT_EMAIL });
    expect(doc).toBeTruthy();
    expect(doc?.role).toBe('admin');
    expect(doc?.mustResetPassword).toBe(true);
  });

  it('rejects login with wrong password', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: BOOT_EMAIL, password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('rejects login for unknown email', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: 'ghost@nowhere.co', password: 'whatever' });
    expect(res.status).toBe(401);
  });

  it('rejects malformed login body', async () => {
    const res = await request(ctx.app).post('/api/auth/login').send({});
    expect(res.status).toBe(400);
  });

  it('logs in with correct credentials and returns session + user with mustReset flag', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: BOOT_EMAIL, password: BOOT_PW });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user.email).toBe(BOOT_EMAIL);
    expect(res.body.user.role).toBe('admin');
    expect(res.body.user.mustResetPassword).toBe(true);
  });
});

describe('auth e2e: UI first-admin bootstrap', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await makeTestApp({ seedAdmin: false });
  });
  afterAll(async () => {
    await ctx.stop();
  });

  it('reports first-run status before any user exists', async () => {
    const res = await request(ctx.app).get('/api/system/onboarding-status');
    expect(res.status).toBe(200);
    expect(res.body.isFirstRun).toBe(true);
    expect(res.body.step).toBe('account');
    expect(res.body.userCount).toBe(0);
    expect(res.body.adminCount).toBe(0);
  });

  it('creates the first admin through the public bootstrap endpoint and returns a session', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/bootstrap')
      .send({
        name: 'First Admin',
        email: 'first-admin@test.local',
        password: 'FirstAdmin!234',
      });

    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user.email).toBe('first-admin@test.local');
    expect(res.body.user.role).toBe('admin');
    expect(res.body.user.mustResetPassword).toBe(false);

    const doc = await ctx.db.collection('users').findOne({ email: 'first-admin@test.local' });
    expect(doc?.role).toBe('admin');
    expect(doc?.mustResetPassword).toBe(false);
  });

  it('closes bootstrap after the first user exists', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/bootstrap')
      .send({
        name: 'Second Admin',
        email: 'second-admin@test.local',
        password: 'SecondAdmin!234',
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('bootstrap_closed');

    const status = await request(ctx.app).get('/api/system/onboarding-status');
    expect(status.body.isFirstRun).toBe(false);
    expect(status.body.step).toBe('complete');
    expect(status.body.userCount).toBe(1);
    expect(status.body.adminCount).toBe(1);
  });
});

describe('auth e2e: blockIfMustReset gate', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await makeTestApp();
  });
  afterAll(async () => {
    await ctx.stop();
  });

  it('blocks arbitrary /api calls when mustResetPassword is true', async () => {
    const login = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: BOOT_EMAIL, password: BOOT_PW });
    const token = login.body.accessToken;

    const res = await request(ctx.app)
      .get('/api/protected')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('password_reset_required');
  });

  it('still allows /api/auth/me and /api/auth/reset-password while flagged', async () => {
    const login = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: BOOT_EMAIL, password: BOOT_PW });
    const token = login.body.accessToken;

    const me = await request(ctx.app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(BOOT_EMAIL);
  });
});

describe('auth e2e: reset-password flow', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await makeTestApp();
  });
  afterAll(async () => {
    await ctx.stop();
  });

  async function loginBoot() {
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: BOOT_EMAIL, password: BOOT_PW });
    return res.body;
  }

  it('rejects weak new passwords', async () => {
    const { accessToken } = await loginBoot();
    const res = await request(ctx.app)
      .post('/api/auth/reset-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: BOOT_PW, newPassword: 'weakpass' });
    expect(res.status).toBe(400);
  });

  it('rejects when new password equals current', async () => {
    const { accessToken } = await loginBoot();
    const res = await request(ctx.app)
      .post('/api/auth/reset-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: BOOT_PW, newPassword: BOOT_PW });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('new_password_must_differ');
  });

  it('rejects when currentPassword is wrong', async () => {
    const { accessToken } = await loginBoot();
    const res = await request(ctx.app)
      .post('/api/auth/reset-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: 'wrong', newPassword: 'Brand-NewPw!234' });
    expect(res.status).toBe(401);
  });

  it('accepts a valid reset, clears mustReset, returns fresh tokens, and unlocks /api/protected', async () => {
    const { accessToken, refreshToken } = await loginBoot();
    const reset = await request(ctx.app)
      .post('/api/auth/reset-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: BOOT_PW, newPassword: 'NewStrong!234X' });

    expect(reset.status).toBe(200);
    expect(reset.body.user.mustResetPassword).toBe(false);
    expect(reset.body.accessToken).toBeTruthy();
    expect(reset.body.accessToken).not.toBe(accessToken);
    expect(reset.body.refreshToken).not.toBe(refreshToken);

    // New token can now hit protected routes.
    const probe = await request(ctx.app)
      .get('/api/protected')
      .set('Authorization', `Bearer ${reset.body.accessToken}`);
    expect(probe.status).toBe(200);
    expect(probe.body.ok).toBe(true);

    // Old refresh token should have been revoked.
    const stale = await request(ctx.app)
      .post('/api/auth/refresh')
      .send({ refreshToken });
    expect(stale.status).toBe(401);

    // Old password no longer works.
    const bad = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: BOOT_EMAIL, password: BOOT_PW });
    expect(bad.status).toBe(401);
  });
});

describe('auth e2e: refresh token rotation + reuse detection', () => {
  let ctx: TestContext;
  // Fresh-user password used for every test in this block; created once so
  // mustReset is cleared and tests aren't dependent on each other.
  const USER_PW = 'RotateMe!234Z';

  beforeAll(async () => {
    ctx = await makeTestApp();
    // One-time admin bootstrap → reset so the admin has a stable password.
    const login = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: BOOT_EMAIL, password: BOOT_PW });
    await request(ctx.app)
      .post('/api/auth/reset-password')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ currentPassword: BOOT_PW, newPassword: USER_PW });
  });
  afterAll(async () => {
    await ctx.stop();
  });

  async function login() {
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: BOOT_EMAIL, password: USER_PW });
    return res.body as { accessToken: string; refreshToken: string };
  }

  it('rotates: new refresh token is issued and works', async () => {
    const s = await login();

    const r1 = await request(ctx.app)
      .post('/api/auth/refresh')
      .send({ refreshToken: s.refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(s.refreshToken);
    expect(r1.body.accessToken).toBeTruthy();

    // New token continues to work.
    const r2 = await request(ctx.app)
      .post('/api/auth/refresh')
      .send({ refreshToken: r1.body.refreshToken });
    expect(r2.status).toBe(200);
  });

  it('reusing a revoked refresh token nukes all sessions for that user', async () => {
    const s = await login();

    const r1 = await request(ctx.app)
      .post('/api/auth/refresh')
      .send({ refreshToken: s.refreshToken });
    expect(r1.status).toBe(200);

    // Attacker replays the rotated-out token.
    const replay = await request(ctx.app)
      .post('/api/auth/refresh')
      .send({ refreshToken: s.refreshToken });
    expect(replay.status).toBe(401);

    // Even the legitimate new token is now invalid (all sessions revoked).
    const r2 = await request(ctx.app)
      .post('/api/auth/refresh')
      .send({ refreshToken: r1.body.refreshToken });
    expect(r2.status).toBe(401);
  });

  it('rejects a completely bogus refresh token', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/refresh')
      .send({ refreshToken: 'not-a-token' });
    expect(res.status).toBe(401);
  });
});

describe('auth e2e: requireAuth middleware', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await makeTestApp();
  });
  afterAll(async () => {
    await ctx.stop();
  });

  it('401 unauthorized when Authorization header is absent', async () => {
    const res = await request(ctx.app).get('/api/protected');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  it('401 unauthorized when a garbage token is supplied', async () => {
    const res = await request(ctx.app)
      .get('/api/protected')
      .set('Authorization', 'Bearer totally-not-a-jwt');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });
});

describe('auth e2e: logout', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await makeTestApp();
  });
  afterAll(async () => {
    await ctx.stop();
  });

  it('revokes the supplied refresh token', async () => {
    const login = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: BOOT_EMAIL, password: BOOT_PW });
    const reset = await request(ctx.app)
      .post('/api/auth/reset-password')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ currentPassword: BOOT_PW, newPassword: 'LogMeOut!2345' });

    const out = await request(ctx.app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${reset.body.accessToken}`)
      .send({ refreshToken: reset.body.refreshToken });
    expect(out.status).toBe(200);

    const replay = await request(ctx.app)
      .post('/api/auth/refresh')
      .send({ refreshToken: reset.body.refreshToken });
    expect(replay.status).toBe(401);
  });
});
