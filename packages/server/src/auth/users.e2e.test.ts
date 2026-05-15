import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { makeTestApp, type TestContext } from './testHarness.js';

const BOOT_EMAIL = 'admin@test.local';
const BOOT_PW = 'BootAdmin!234';
const NEW_ADMIN_PW = 'NewAdmin!2345X';

async function loginAndReset(ctx: TestContext) {
  const login = await request(ctx.app)
    .post('/api/auth/login')
    .send({ email: BOOT_EMAIL, password: BOOT_PW });
  const reset = await request(ctx.app)
    .post('/api/auth/reset-password')
    .set('Authorization', `Bearer ${login.body.accessToken}`)
    .send({ currentPassword: BOOT_PW, newPassword: NEW_ADMIN_PW });
  return reset.body as {
    accessToken: string;
    refreshToken: string;
    user: { id: string; email: string; role: string };
  };
}

describe('users e2e: RBAC', () => {
  let ctx: TestContext;
  let adminToken: string;

  beforeAll(async () => {
    ctx = await makeTestApp();
    const s = await loginAndReset(ctx);
    adminToken = s.accessToken;
  });
  afterAll(async () => {
    await ctx.stop();
  });

  it('admin can list users', async () => {
    const res = await request(ctx.app)
      .get('/api/users')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('unauthenticated request to /api/users is 401', async () => {
    const res = await request(ctx.app).get('/api/users');
    expect(res.status).toBe(401);
  });

  it('non-admin (regular user) can list users but cannot mutate', async () => {
    // GET /api/users is open to any authenticated user (needed for client
    // dropdowns like the Threads page owner filter). Write endpoints
    // (POST/PATCH/DELETE) remain admin-only.

    // Create a regular user first.
    const create = await request(ctx.app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'alice@test.local', name: 'Alice' });
    expect(create.status).toBe(201);
    const tempPw = create.body.tempPassword as string;
    expect(tempPw).toBeTruthy();

    // Alice logs in, resets, gets a non-admin token.
    const login = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: 'alice@test.local', password: tempPw });
    const reset = await request(ctx.app)
      .post('/api/auth/reset-password')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ currentPassword: tempPw, newPassword: 'Alice-Pw!2345' });

    expect(reset.body.user.role).toBe('user');
    const aliceToken = reset.body.accessToken;

    // Alice can list users.
    const list = await request(ctx.app)
      .get('/api/users')
      .set('Authorization', `Bearer ${aliceToken}`);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);

    // Alice cannot create users.
    const create2 = await request(ctx.app)
      .post('/api/users')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ email: 'bob@test.local', name: 'Bob' });
    expect(create2.status).toBe(403);
  });
});

describe('users e2e: create user', () => {
  let ctx: TestContext;
  let adminToken: string;

  beforeAll(async () => {
    ctx = await makeTestApp();
    const s = await loginAndReset(ctx);
    adminToken = s.accessToken;
  });
  afterAll(async () => {
    await ctx.stop();
  });

  it('creates a user with role=user and mustResetPassword=true', async () => {
    const res = await request(ctx.app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'bob@test.local', name: 'Bob' });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('user');
    expect(res.body.user.mustResetPassword).toBe(true);
    expect(res.body.tempPassword).toMatch(/.{12}/);
  });

  it('rejects duplicate email', async () => {
    const res = await request(ctx.app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'bob@test.local', name: 'Other Bob' });
    expect(res.status).toBe(409);
  });

  it('rejects missing fields', async () => {
    const r1 = await request(ctx.app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'noname@test.local' });
    expect(r1.status).toBe(400);

    const r2 = await request(ctx.app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'not-an-email', name: 'X' });
    expect(r2.status).toBe(400);
  });
});

describe('users e2e: admin operations', () => {
  let ctx: TestContext;
  let adminToken: string;
  let adminId: string;
  let bobId: string;

  beforeAll(async () => {
    ctx = await makeTestApp();
    const s = await loginAndReset(ctx);
    adminToken = s.accessToken;
    adminId = s.user.id;

    const create = await request(ctx.app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'bob@test.local', name: 'Bob' });
    bobId = create.body.user.id;
  });
  afterAll(async () => {
    await ctx.stop();
  });

  it('resetting temp password returns a new temp and flips mustReset=true', async () => {
    const res = await request(ctx.app)
      .post(`/api/users/${bobId}/reset-temp-password`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.tempPassword).toMatch(/.{12}/);

    // Re-query by id via list (no raw _id exposed by the API).
    const list = await request(ctx.app)
      .get('/api/users')
      .set('Authorization', `Bearer ${adminToken}`);
    const bob = list.body.find((u: { id: string }) => u.id === bobId);
    expect(bob.mustResetPassword).toBe(true);
  });

  it('PATCH cannot demote the last admin', async () => {
    const res = await request(ctx.app)
      .patch(`/api/users/${adminId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'user' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/last admin/i);
  });

  it('admin cannot delete themselves', async () => {
    const res = await request(ctx.app)
      .delete(`/api/users/${adminId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it('promotes bob to admin, then demotes back (two-admin path)', async () => {
    const promote = await request(ctx.app)
      .patch(`/api/users/${bobId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'admin' });
    expect(promote.status).toBe(200);
    expect(promote.body.role).toBe('admin');

    const demote = await request(ctx.app)
      .patch(`/api/users/${bobId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'user' });
    expect(demote.status).toBe(200);
    expect(demote.body.role).toBe('user');
  });

  it('deletes bob and the record disappears', async () => {
    const del = await request(ctx.app)
      .delete(`/api/users/${bobId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(del.status).toBe(204);

    const list = await request(ctx.app)
      .get('/api/users')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.body.find((u: { id: string }) => u.id === bobId)).toBeUndefined();
  });
});
