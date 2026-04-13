import type { Db } from 'mongodb';
import { UserService } from './user.service.js';

/**
 * On startup: if no admin exists, create one from ADMIN_EMAIL + ADMIN_PASSWORD.
 * The admin is flagged `mustResetPassword: true` so the deployer is forced to
 * rotate away from the env-file password at first login. Idempotent — once an
 * admin exists, subsequent boots are no-ops (env password changes are ignored).
 */
export async function bootstrapAdmin(db: Db): Promise<void> {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error(
      'Missing ADMIN_EMAIL and/or ADMIN_PASSWORD env vars — required to bootstrap the first admin user.',
    );
  }
  if (!process.env.JWT_ACCESS_SECRET || !process.env.JWT_REFRESH_SECRET) {
    throw new Error(
      'Missing JWT_ACCESS_SECRET and/or JWT_REFRESH_SECRET env vars — required for auth.',
    );
  }

  const users = new UserService(db);
  const existingAdminCount = await users.countAdmins();
  if (existingAdminCount > 0) {
    console.log('[auth] Admin already exists — skipping bootstrap');
    return;
  }

  const existing = await users.findByEmail(email);
  if (existing) {
    console.log(`[auth] User ${email} already exists — skipping bootstrap`);
    return;
  }

  await users.createUser({
    email,
    name: 'Admin',
    plainPassword: password,
    role: 'admin',
    mustResetPassword: true,
    createdBy: 'system',
  });
  console.log(`[auth] ✓ Admin bootstrapped: ${email}`);
  console.log('[auth]   You will be prompted to set a new password on first login.');
}
