# Authentication

Allen is **invite-only**. There is no public signup. An admin bootstraps
the first account from environment variables, then invites additional team
members from the UI.

## Setup (self-hosted)

1. Copy `.env.example` to `.env` and set the auth variables:

   ```env
   ADMIN_EMAIL=admin@yourco.com
   ADMIN_PASSWORD=ChangeMe!123
   JWT_ACCESS_SECRET=<openssl rand -hex 32>
   JWT_REFRESH_SECRET=<openssl rand -hex 32>
   ```

2. Start the server. On first boot it creates an admin user with the email
   and password from `.env` and flags the account as "must reset password".

3. Open the UI, sign in with those credentials. You will be immediately
   redirected to **Set your password** and forced to choose a new one that
   meets the strength policy (see below).

4. Visit **Users** (admin-only, in the sidebar) to invite team members.

## Inviting a team member

- Click **New user**, enter their email and name.
- The server generates a random temporary password and returns it **once**.
  Copy it and share with the user over whatever channel you trust (Slack,
  1Password, in person, etc.). It is never shown again.
- The new user signs in with the temp password and is immediately forced to
  set a new password before they can use the app.
- New users are created with role `user`. Only admins can create users.
- Admins can toggle another user's role between `admin` and `user` from the
  Users page. The last admin cannot be demoted or deleted.

## Password policy

Passwords must be at least **8 characters** and contain:

- one uppercase letter
- one lowercase letter
- one number
- one symbol

## Sessions & tokens

Allen uses JWT access + refresh tokens:

- **Access token**: 1 day (`ACCESS_TOKEN_TTL`). Held in memory in the browser.
- **Refresh token**: 7 days (`REFRESH_TOKEN_TTL`). Stored in `localStorage`.
  Rotated on every refresh (used-once); if a rotated token is presented
  again, all of that user's sessions are revoked.

When the access token expires, the UI transparently exchanges the refresh
token for a new pair. If the refresh token is also invalid or expired, the
user is redirected to `/login?from=<original-path>` and sent back to their
original page after signing in.

## Forgot admin password?

Because there is no email flow, password reset for the admin is manual:

1. Delete the admin document from MongoDB:
   `db.users.deleteOne({ email: "admin@yourco.com" })`
2. Restart the server — it will re-bootstrap the admin from `.env` with
   `mustResetPassword: true`.

For regular users, an admin can click **Reset temp password** on the Users
page to regenerate a temporary password and force another reset.
