# Open-Source Onboarding Flow Implementation Plan

Linear: ENG-1606 - Build best-in-class open-source onboarding flow for Allen

PRD: PRD-001 - Allen New-Team Onboarding Flow

## Goal

Ship an onboarding flow that takes a fresh open-source Allen instance from first UI launch to first completed workflow run on a real repository, without requiring external documentation.

The first release should prioritize trust and activation over breadth:

1. Detect fresh instances before login.
2. Let the first admin create the account in the UI.
3. Verify runtime dependencies with actionable fixes.
4. Connect a repository safely.
5. Launch `understand-and-plan` with the connected repo prefilled.
6. Persist progress so refreshes and restarts resume cleanly.

## Current Repo Fit

The repo already has most of the underlying primitives:

| Capability | Existing area |
| --- | --- |
| Server route registration | `packages/server/src/app.ts` |
| Auth/login/session refresh | `packages/server/src/routes/auth.routes.ts`, `packages/server/src/services/user.service.ts` |
| UI first-admin bootstrap | `POST /api/auth/bootstrap`, `/onboarding/account` |
| User indexes | `packages/server/src/database/indexes.ts` |
| Repo registration and clone | `packages/server/src/routes/repo.routes.ts`, `packages/server/src/services/repo.service.ts` |
| Workflow launch | `packages/server/src/routes/execution.routes.ts`, `packages/server/src/services/execution.service.ts` |
| Execution context/progress | `/api/executions/:id/context`, `packages/ui/src/hooks/useExecution.ts` |
| Frontend routing | `packages/ui/src/main.tsx` |
| API client | `packages/ui/src/services/api.ts` |
| Setup script with basic dependency checks | `scripts/setup.sh` |

Main gaps:

- No public `system` route for onboarding status or structured dependency health.
- No persisted onboarding state collection beyond first-run account status.
- No persisted onboarding state collection.
- Repo creation validates basic path/clone behavior, but not complete onboarding readiness.
- No first-run routing or `/onboarding` route family.
- No `npm run health`.
- No invite/member onboarding path.
- Empty states exist ad hoc, not as a shared onboarding-aware pattern.

## Phase 0: Decisions Before Implementation

Resolve these first because they affect the architecture:

1. Is Codex required for activation, or optional with a clear warning because workflows primarily require Claude?
2. Is Docker Compose for MongoDB part of launch day, or a documented fallback?
3. Should the first run always use the user's repo, or allow Allen's own repo as an escape hatch?
4. Should invite links be link-only in v1, avoiding SMTP setup?

Recommendation:

- Treat Claude CLI/auth as required for first workflow execution.
- Treat Codex CLI/auth as optional but warn that default chat may not work.
- Ship Docker Compose MongoDB as a launch-day fallback if it is already acceptable operationally.
- Make invites link-only in the first version.

## Phase 1: Foundation For OSS Launch

Purpose: eliminate silent setup failures and make the first-launch path coherent.

### Backend

Add `packages/server/src/services/system-health.service.ts`.

Checks should return a stable shape:

```ts
type HealthCheckStatus = 'pass' | 'warn' | 'fail' | 'checking';

interface SystemHealthCheck {
  id: 'node' | 'npm' | 'mongodb' | 'git' | 'claude_cli' | 'claude_auth' | 'codex_cli' | 'codex_auth';
  label: string;
  required: boolean;
  status: HealthCheckStatus;
  version?: string;
  detail?: string;
  fix?: {
    summary: string;
    commands?: string[];
    docsPath?: string;
  };
}
```

Add `packages/server/src/services/onboarding.service.ts`.

Persist one singleton row in `system_settings`:

```ts
interface OnboardingStatus {
  isFirstRun: boolean;
  userCount: number;
  adminCount: number;
  complete: boolean;
  step: 'account' | 'health' | 'repository' | 'first_run' | 'complete';
  connectedRepoId?: string;
  firstExecutionId?: string;
  updatedAt: string;
}
```

Add `packages/server/src/routes/system.routes.ts` mounted before global auth:

- `GET /api/system/onboarding-status`
- `GET /api/system/health`
- `PATCH /api/system/onboarding-status`

Security rules:

- Public status can expose counts and coarse state only, not user emails or env details.
- Public health must not leak absolute sensitive paths, secrets, tokens, or full command output.
- Mutating onboarding state should require auth except for the initial account step.

Add `POST /api/auth/bootstrap`:

- Public route.
- Guard with `users.countDocuments({}) === 0`, not admin count only.
- Create first admin, validate password strength, issue access/refresh tokens, update onboarding step to `health`.
- Return `409` if any user already exists.
- Use a unique email index plus the no-users guard to handle race attempts.

Startup behavior:

- Server should boot with zero users and report `isFirstRun: true`.
- Still require JWT secrets, or generate them in setup as today.

Indexes:

- Add `system_settings.name` unique.
- Add `invite_tokens.tokenHash` unique and `invite_tokens.expiresAt` TTL later in Phase 3.
- Add `onboarding_events.createdAt` only if local analytics are implemented.

### CLI And Setup

Add `npm run health`.

Implementation path:

- Prefer a TypeScript script, `scripts/health.ts`, that can reuse the same checks as the server if exported cleanly.
- If importing server code is too awkward because of ESM/build boundaries, create a small shared `packages/server/src/services/system-health.service.ts` CLI entry point.

Update `scripts/setup.sh`:

- Add a final structured health summary.
- Avoid trying to force interactive CLI auth.
- Print exact next command for failed required checks.
- Add `--non-interactive` and `--skip-mongodb` once the health script exists.

### Frontend

Add public routes in `packages/ui/src/main.tsx`:

- `/onboarding`
- `/onboarding/account`
- `/onboarding/health`
- `/onboarding/repository`
- `/onboarding/first-run`

Add an onboarding gate:

- On app boot, call `GET /api/system/onboarding-status`.
- If `isFirstRun` or `!complete`, route to the correct onboarding path.
- The gate must run outside `ProtectedRoute` for account creation.
- Existing logged-in users should be able to resume onboarding if incomplete.

New UI modules:

- `packages/ui/src/pages/onboarding/OnboardingPage.tsx`
- `packages/ui/src/components/onboarding/OnboardingShell.tsx`
- `packages/ui/src/components/onboarding/AccountStep.tsx`
- `packages/ui/src/components/onboarding/HealthStep.tsx`
- `packages/ui/src/components/onboarding/DependencyRow.tsx`

Design constraints:

- One primary action per step.
- Use compact operational UI, not a marketing hero.
- Health rows must use icon plus text status, not color alone.
- Every failed check gets a retry and copyable command.

Acceptance for Phase 1:

- Fresh DB opens `/onboarding/account`, not `/login`.
- First admin can be created through UI and receives a session.
- Race attempts after first user receive `409`.
- Health UI shows Node, npm, MongoDB, git, Claude CLI/auth, Codex CLI/auth.
- Required checks block only where required.
- Existing instances with users continue to show login.
- `npm run health` exits non-zero only when required checks fail.

## Phase 2: Guided Activation

Purpose: get users from healthy instance to first completed workflow.

### Backend

Extend repo readiness validation rather than duplicating logic in the UI.

Add to `RepoService`:

- `validateLocalPath(path)` for exists, directory, `.git`, readable, default branch, remote, dirty status.
- `validateCloneUrl(url, branch)` for URL parse, SSH host allowlist/sanitization, duplicate path/name, branch viability where possible.
- `verifyWorkspaceViability(repoId)` by creating a non-mutating dry-run check against workspace root permissions.

Add routes:

- `POST /api/system/verify-ssh`
- `POST /api/repos/validate-local`
- `POST /api/repos/validate-clone`
- `GET /api/system/first-workflow-suggestion?repoId=...`

`verify-ssh` should:

- Allow only sanitized hostnames.
- Default to `github.com`.
- Run with a timeout.
- Return a high-level verdict and fix guidance, not raw stderr dumps.

First workflow suggestion:

- Prefer repo `defaultWorkflow` when set.
- Otherwise prefer `understand-and-plan` if present.
- Return the workflow id, required input fields, and suggested starter prompts.

### Frontend

Add:

- `RepoConnector`
- `SSHVerifier`
- `FirstWorkflowLauncher`
- `FirstExecutionGuide`
- `HelpPanel`

Reuse existing APIs where possible:

- `repos.create` for local path.
- `repos.clone` for GitHub SSH clone.
- `workflows.list/get` to resolve `understand-and-plan`.
- `executions.start` to create the first run.
- `executions.context` and existing execution stream to render progress.

On successful repo connection:

- Persist `connectedRepoId`.
- Advance to `first_run`.
- Preselect the connected repo in the first workflow launcher.

On first run launch:

- Start the workflow with repo input populated.
- Store `firstExecutionId`.
- Route into guided execution view.
- Mark onboarding complete when execution reaches `completed`, or let user skip with explicit acknowledgement.

Acceptance for Phase 2:

- Local path invalid states are caught before create.
- GitHub SSH clone path verifies SSH readiness before clone attempt.
- First workflow launcher preselects the connected repo.
- User can start `understand-and-plan` without navigating to Workflows manually.
- The guided first execution shows live progress and a clear success/failure state.
- Refreshing mid-onboarding resumes the same step and selected repo/execution.

## Phase 3: Team Activation

Purpose: support team leads inviting members after first activation.

Backend:

- Add invite token service.
- Add `POST /api/users/invite` admin-only.
- Add `GET /api/users/invite/:token` public.
- Add `POST /api/users/invite/:token/accept` public.
- Hash invite tokens at rest.
- TTL expired invites.
- Mark accepted invites immutable.

Frontend:

- Add `/join/:token`.
- Add invite UI in the completion panel and Settings/Users.
- Member onboarding should skip admin bootstrap and show a shorter health check focused on local CLI readiness.

Acceptance:

- Admin creates a link-only invite.
- Invite acceptance creates a normal user and session.
- Expired/accepted/invalid tokens show explicit states.
- Joined users land on a team-aware dashboard with connected repos visible.

## Phase 4: Polish And Retention

Purpose: improve first-week retention and open-source trust.

Scope:

- Context-aware help panel per route.
- Re-entry banner for skipped onboarding.
- Local-only onboarding funnel in admin settings.
- `TELEMETRY.md` before any external telemetry.
- Cross-platform hardening for Linux, WSL2, and cloud VMs.
- First-week recommendations after first run.

Analytics stance:

- Local analytics can be on by default only if stored locally and disclosed.
- External telemetry must be opt-in and disabled by default.
- Never send repository paths, prompt contents, secrets, or command output externally.

## Test Plan

Backend unit/integration:

- `SystemHealthService` with mocked command results.
- `OnboardingService` state transitions.
- `POST /api/auth/bootstrap` success, validation failures, and race guard.
- Public `GET /api/system/onboarding-status` does not leak sensitive data.
- Repo validation for non-existent path, non-git path, dirty repo, no default branch, duplicate path.
- SSH verifier timeout, bad host rejection, missing key guidance.

Frontend unit:

- Onboarding route gate.
- Account form validation.
- Health row rendering for pass/warn/fail.
- Repo connector validation states.
- First workflow launcher input mapping.

E2E:

- Fresh DB redirects to onboarding.
- First admin bootstrap logs user in.
- Failed health checks show fixes and retry.
- Local repo connection advances to first-run step.
- First workflow launch creates execution with selected repo.
- Refresh mid-flow resumes.
- Existing instance with users routes to login.

Manual QA:

- macOS fresh clone.
- Ubuntu with MongoDB installed.
- Ubuntu without MongoDB.
- Claude missing.
- Claude installed but unauthenticated.
- Codex missing.
- GitHub SSH not configured.

## Suggested Linear Breakdown

Split ENG-1606 into implementation tickets:

1. Backend: onboarding status and health APIs.
2. Backend: first-admin account API and startup first-run status.
3. CLI: `npm run health` and setup summary.
4. Frontend: onboarding route gate and shell.
5. Frontend: account and health steps.
6. Backend: repo validation and SSH verification.
7. Frontend: repo connector.
8. Backend/frontend: first workflow suggestion and launcher.
9. Frontend: guided first execution state.
10. Empty states across repos, workflows, executions, tickets, workspaces, and settings.
11. Team invite token backend.
12. Team invite and member join UI.
13. Local onboarding analytics and admin funnel.
14. Playwright onboarding coverage.

## Implementation Order

1. Backend status/health/bootstrap first, because routing depends on it.
2. UI gate and account/health steps second.
3. CLI health script in parallel with health service once the check shape is stable.
4. Repo validation and connector third.
5. Workflow launcher and guided execution fourth.
6. Empty states before OSS launch.
7. Invites and analytics after first activation path is stable.

## Risks

- Auth bootstrap is security-sensitive. Guard by total user count and database uniqueness, not frontend state.
- Health checks can hang if CLI auth commands become interactive. Every subprocess needs a timeout.
- Public health endpoints can accidentally leak paths or command output. Normalize all responses.
- Setup script and UI can drift. Keep server health checks as the source of truth.
- First workflow input schema may change. Launcher should inspect workflow details instead of hardcoding only field names.

## Definition Of Done For Launch-Day Scope

- Fresh clone can reach onboarding before any user exists.
- First admin creation through UI is secure and idempotent.
- Health checks are structured, actionable, and shared with `npm run health`.
- Onboarding is persisted in MongoDB and resumes after refresh/server restart.
- User can connect a local repo or see clear SSH clone guidance.
- User can start the recommended first workflow from onboarding.
- Major empty states route to the next productive action.
- Tests cover bootstrap, health, route gate, and first-run happy path.
