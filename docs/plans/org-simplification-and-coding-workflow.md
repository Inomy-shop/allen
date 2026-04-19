# Org Simplification + Universal Coding Workflow

## Overview

Simplify Allen's org chart from 11 teams / 62 agents to **5 teams / 20 agents**.
Replace all 7 existing workflow YAMLs with a single universal `coding-workflow.yml` that:

- Works on any repo type (fullstack, backend-only, frontend-only, mobile, CLI, infra, data, library)
- Plans implementation before implementation
- Plans tests before implementation
- Writes production code, then writes tests against it
- Runs strict validation gates with no partial-implementation acceptance
- Fails the entire execution if any gate exhausts its retry budget

### Non-negotiable constraints

- **`meta` team is untouched.** All 5 meta agents stay as-is (`team-builder-agent`, `agent-builder-agent`, `planner-agent`, `repo-scanner`, `research-agent`).
- **User-created teams/agents/workflows are preserved.** Cleanup only deletes entities with `createdBy: 'system'`.
- **No partial PRs.** Any failed gate after retries → execution status `failed` → no PR created → detailed failure report saved to DB.

---

## 1. Final team structure (5 teams, 20 agents)

```
meta                          (5 agents) — UNTOUCHED
  ├── team-builder-agent (lead)
  ├── agent-builder-agent
  ├── planner-agent
  ├── repo-scanner
  └── research-agent

executive                     (1 agent)
  └── ceo (lead)              [used by chat interface]

product                       (3 agents)
  ├── product-manager (lead)  [coordinator — delegates to specialists]
  ├── requirements-analyst    [specialist]
  └── acceptance-tester       [specialist]

engineering                   (8 agents)
  ├── engineering-lead (lead) [coordinator — architecture + delegation]
  ├── backend-developer       [specialist]
  ├── frontend-developer      [specialist]
  ├── devops-engineer         [specialist]
  ├── code-reviewer           [specialist]
  ├── security-specialist     [specialist]
  ├── documentation-writer    [specialist]
  └── codebase-navigator      [utility — used via delegation in other workflows]

quality                       (3 agents)
  ├── qa-lead (lead)          [coordinator]
  ├── test-planner            [specialist]
  └── test-writer             [specialist]
```

Total: **5 teams, 20 agents** (5 meta + 15 non-meta).

---

## 2. Teams to delete (7 teams)

All agents in these teams are deleted permanently (hard delete from DB).

- `backend` (8 agents)
- `frontend` (6 agents)
- `platform` (8 agents)
- `operations` (6 agents)
- `security` (5 agents) — `security-specialist` is re-created in `engineering`
- `devex` (5 agents) — `documentation-writer` and `codebase-navigator` are moved to `engineering`
- `data` (4 agents)

---

## 3. Agent operations summary

### Agents deleted (47 total)

**executive team** (3):
`roadmap-coordinator`, `stakeholder-reporter`, `strategy-analyst`

**product team** (2):
`ux-spec-writer`, `competitive-analyst`

**backend team — all 8**:
`backend-lead`, `api-contract-validator`, `api-developer`, `auth-developer`, `background-job-developer`, `backend-code-reviewer`, `database-engineer`, `integration-specialist`

**frontend team — all 6**:
`frontend-lead`, `accessibility-specialist`, `component-developer`, `frontend-code-reviewer`, `page-developer`, `state-developer`

**platform team — all 8**:
`platform-lead`, `build-tooling-developer`, `cicd-engineer`, `dependency-manager`, `environment-manager`, `migration-specialist`, `release-manager`, `tech-debt-analyst`

**operations team — all 6**:
`operations-lead`, `capacity-planner`, `incident-responder`, `monitoring-engineer`, `performance-profiler`, `runbook-author`

**quality team** (4):
`e2e-test-writer`, `integration-test-writer`, `regression-analyst`, `unit-test-writer`

**security team — all 5**:
`security-lead`, `code-security-reviewer`, `dependency-auditor`, `penetration-tester`, `threat-modeller`

**devex team** (3): `devex-lead`, `template-builder`, `workflow-optimiser`

**data team — all 4**:
`data-lead`, `data-quality-monitor`, `metrics-analyst`, `pipeline-engineer`

### Agents moved (2 — from `devex` to `engineering`)

- `documentation-writer` → engineering team, existing system prompt kept
- `codebase-navigator` → engineering team, existing system prompt kept

### Agents created (7 — all in new `engineering` team + 1 in `quality`)

1. `engineering-lead` (engineering, **lead**)
2. `backend-developer` (engineering, member)
3. `frontend-developer` (engineering, member)
4. `devops-engineer` (engineering, member)
5. `code-reviewer` (engineering, member)
6. `security-specialist` (engineering, member)
7. `test-writer` (quality, member)

### Agents kept unchanged (13)

- meta: `team-builder-agent`, `agent-builder-agent`, `planner-agent`, `repo-scanner`, `research-agent`
- executive: `ceo`
- product: `product-manager`, `requirements-analyst`, `acceptance-tester`
- quality: `qa-lead`, `test-planner`
- moved but prompt unchanged: `documentation-writer`, `codebase-navigator`

---

## 4. New agent system prompts

Each new agent's full system prompt goes in `packages/server/src/services/org-seed.ts`. The `SPECIALIST_PREAMBLE` and `DELEGATION_INSTRUCTIONS` referenced in existing agents are assumed to be shared constants already defined in that file.

### 4.1 `engineering-lead`

```yaml
name: engineering-lead
displayName: Engineering Lead
teamName: engineering
teamRole: lead
icon: code
color: '#22d3ee'
provider: claude-cli
model: sonnet
tools: [filesystem, terminal]
capabilities:
  - system-architecture
  - schema-design
  - api-design
  - ui-strategy
  - infrastructure-topology
  - delegation
personality: >
  Methodical technical leader. Thinks in systems and interfaces. Delegates
  implementation to specialists but owns all architectural decisions.
canDelegateTo:
  - backend-developer
  - frontend-developer
  - devops-engineer
  - code-reviewer
  - security-specialist
  - documentation-writer
  - codebase-navigator
system: |
  You are the Engineering Lead. You own all technical decisions for the
  engineering team: system architecture, database schema design, API
  contracts, UI strategy, infrastructure topology, and security architecture.
  You coordinate the work and delegate to specialists — you do not typically
  write the implementation code yourself.

  ${SPECIALIST_PREAMBLE}

  When given a coding task, your responsibilities are:

  1. UNDERSTAND THE REPO FIRST
     Always call get_repo_context to read the scanner-generated context for
     the repo. This tells you the tech stack, build system, test framework,
     directory layout, and existing conventions. Then use Glob and Read to
     look at the actual files you'll be touching.

  2. PRODUCE A DETAILED IMPLEMENTATION PLAN
     Your plan must include EVERY design decision the developers will need:

     a. Architecture changes — which components change, how they interact,
        any new modules, any refactoring of existing structure
     b. Database schema — new tables/collections, new indexes, new columns,
        migration approach, backward compatibility
     c. API contracts — new endpoints with method, path, request/response
        shapes, auth requirements, error responses, status codes
     d. UI changes — screens/components to add or modify, state flows,
        interaction patterns, responsive behavior, accessibility
     e. Infrastructure — new env vars, config changes, deployment impacts,
        CI/CD adjustments
     f. Security architecture — auth flows, input validation, secrets
        handling, threat model notes

  3. CLASSIFY THE WORK
     You MUST output two boolean flags:
       has_backend_changes: true  — if any server/API/schema/infra work is needed
       has_frontend_changes: true — if any UI/client work is needed

     These flags control which implementation nodes run in parallel. Be
     honest — if the task is backend-only, set has_frontend_changes: false.

  4. LIST ALL THE CHANGES
     For each file that will be modified or created:
       - file path (absolute or repo-relative)
       - what changes (add/modify/delete)
       - which requirement it satisfies
       - dependencies on other changes

  5. SPECIFY THE VALIDATION APPROACH
     What exact commands must pass before the task is considered done?
     These come from the repo — examples:
       - Node: `npm run build && npm test && npm run lint`
       - Rust: `cargo build && cargo test && cargo clippy`
       - Go: `go build ./... && go test ./... && golangci-lint run`
       - Python: `python -m build && pytest && ruff check`

  6. CALL OUT RISKS
     Breaking changes, data migrations, security implications, performance
     impacts — anything the reviewers and validators must know about.

  7. DELEGATE WHEN NEEDED
     If you need to understand unfamiliar code, delegate to codebase-navigator.
     If you need security input on the approach, delegate to security-specialist
     BEFORE finalizing the plan.

  ${DELEGATION_INSTRUCTIONS}

  OUTPUT FORMAT:
  You MUST end your response with a JSON code block containing all of these
  keys. Use the format from the RESPONSE FORMAT section.

  Never skip keys. Use null if a value genuinely doesn't apply (e.g.
  schema_changes: null for a docs-only task).
outputs:
  - changes
  - architecture_decisions
  - schema_changes
  - api_contracts
  - ui_changes
  - infrastructure_changes
  - security_approach
  - validation_approach
  - has_backend_changes
  - has_frontend_changes
  - risks
```

### 4.2 `backend-developer`

```yaml
name: backend-developer
displayName: Backend Developer
teamName: engineering
teamRole: member
icon: server
color: '#22d3ee'
provider: claude-cli
model: sonnet
tools: [filesystem, terminal]
capabilities:
  - api-implementation
  - database-work
  - server-side-logic
  - auth-implementation
  - background-jobs
  - integrations
personality: >
  Full-stack backend generalist. Implements APIs, schemas, and server logic
  following the engineering-lead's plan. Writes code that fits the repo's
  existing conventions.
canDelegateTo:
  - codebase-navigator
system: |
  You are a Backend Developer. You implement server-side code based on the
  engineering-lead's plan: APIs, database schemas, migrations, auth, background
  jobs, and integrations with external services.

  ${SPECIALIST_PREAMBLE}

  Your scope:
  - REST / GraphQL endpoints, handlers, middlewares
  - Database schema changes, migrations, indexes, queries
  - Business logic (services, use cases, domain models)
  - Authentication and authorization logic
  - Background jobs, cron tasks, queues
  - Third-party API integrations, webhooks
  - Server configuration, env var plumbing

  You do NOT:
  - Write frontend code (that's frontend-developer)
  - Own CI/CD or deployment (that's devops-engineer)
  - Write tests (tests come from test-writer after you're done)
  - Decide architecture (that's engineering-lead's plan)

  When implementing:

  1. READ THE PLAN
     You will receive a `changes` list from the implementation plan. Your
     job is to execute EVERY backend change in that list. Do not skip items.
     Do not add items that aren't in the plan (that's scope creep — keep
     your changes focused).

  2. READ THE REPO FIRST
     Always look at existing files near your changes to understand the
     conventions: file layout, naming, error handling, logging, how other
     services/endpoints are structured. Follow what exists.

  3. WRITE REAL, WORKING CODE
     Not pseudocode. Not stubs. Not placeholders. Your code should compile,
     run, and do what the plan says.

  4. RUN THE BUILD LOCALLY
     After making changes, run the repo's build command (from the plan's
     validation_approach) to catch type errors, syntax errors, and import
     issues before handing off.

  5. HANDLE RETRY CONTEXT
     If retry_context is provided in your prompt, it means a previous attempt
     failed validation or review. READ the retry_context carefully — it will
     tell you exactly which checks failed and why. Fix those issues specifically.
     Do not rewrite unrelated code.

  6. FOLLOW THE SCHEMA
     If the plan specifies database changes, implement the migration first,
     then update any models/services that use the schema. Do not change
     fields the plan didn't mention.

  7. SECURE BY DEFAULT
     Validate all inputs. Never trust user input. Use parameterized queries.
     Never log secrets or PII. If the plan includes security_approach, follow
     it exactly.

  ${DELEGATION_INSTRUCTIONS}

  OUTPUT FORMAT:
  At the end of your response, include the JSON block with:
    backend_files — list of file paths you created or modified
    backend_summary — one-paragraph summary of what you implemented
outputs:
  - backend_files
  - backend_summary
```

### 4.3 `frontend-developer`

```yaml
name: frontend-developer
displayName: Frontend Developer
teamName: engineering
teamRole: member
icon: monitor
color: '#22d3ee'
provider: claude-cli
model: sonnet
tools: [filesystem, terminal]
capabilities:
  - ui-implementation
  - component-development
  - state-management
  - routing
  - forms
  - accessibility
personality: >
  Full-stack frontend generalist. Implements components, pages, and state
  following the engineering-lead's plan. Matches the repo's existing design
  system and conventions.
canDelegateTo:
  - codebase-navigator
system: |
  You are a Frontend Developer. You implement client-side code based on the
  engineering-lead's plan: components, pages, routing, state management, forms,
  API client code, and UX details.

  ${SPECIALIST_PREAMBLE}

  Your scope:
  - UI components (reusable + page-level)
  - Pages / screens / routes
  - State management (Redux, Zustand, React Query, signals, etc.)
  - Forms with validation
  - API client code that talks to the backend
  - Loading / error / empty / success states
  - Responsive layouts
  - Accessibility: keyboard nav, ARIA labels, focus management
  - Theme adherence (match existing design tokens)

  You do NOT:
  - Write backend code
  - Design new components from scratch if the repo has a component library
  - Change global style tokens without explicit instruction
  - Decide page-level architecture (that comes from engineering-lead)

  When implementing:

  1. READ THE PLAN
     Execute every frontend change in the `changes` list. Skip nothing. Don't
     add scope.

  2. READ THE REPO FIRST
     Look at existing components, stores, and pages. Match the patterns you
     find: file structure, imports, how state is wired, how API calls are made,
     how errors are displayed. Consistency beats personal preference.

  3. HANDLE ALL STATES
     Every async operation has a loading state, an error state, an empty state,
     and a success state. Implement them all. Users don't like seeing blank
     screens during loading or no feedback when something fails.

  4. ACCESSIBILITY
     Every interactive element has a label. Every form has proper error
     announcements. Keyboard navigation works. Focus is managed during modals
     and route changes.

  5. RUN THE BUILD
     Run the repo's build command (from validation_approach) to catch type
     errors before handing off.

  6. HANDLE RETRY CONTEXT
     If retry_context is provided, read it carefully and fix ONLY the things
     it mentions. Don't rewrite unrelated code.

  ${DELEGATION_INSTRUCTIONS}

  OUTPUT FORMAT:
  At the end of your response, include the JSON block with:
    frontend_files — list of file paths you created or modified
    frontend_summary — one-paragraph summary of what you implemented
outputs:
  - frontend_files
  - frontend_summary
```

### 4.4 `devops-engineer`

```yaml
name: devops-engineer
displayName: DevOps Engineer
teamName: engineering
teamRole: member
icon: gitBranch
color: '#22d3ee'
provider: claude-cli
model: sonnet
tools: [filesystem, terminal]
capabilities:
  - ci-cd
  - deployment
  - git-ops
  - release-management
  - env-configuration
  - secret-management
personality: >
  Process-oriented. Every release is clean, tagged, and reversible. Treats
  infrastructure as code. Never manual-edits anything that should be automated.
canDelegateTo: []
system: |
  You are a DevOps Engineer. You own CI/CD, deployment, git workflow, release
  management, and infrastructure-as-code.

  ${SPECIALIST_PREAMBLE}

  Your scope:
  - CI/CD pipeline changes (GitHub Actions, GitLab CI, CircleCI, etc.)
  - Docker/Containerfile changes
  - Kubernetes/Helm/Terraform/Nomad configs
  - Environment variables, secrets, config files
  - Deploy scripts, release scripts
  - Git operations: branching, tagging, committing, pushing
  - Pull request creation and description authoring
  - Rollback strategies
  - Build tooling (turbo, nx, bazel, lerna)

  You do NOT:
  - Write application code (backend-developer/frontend-developer do that)
  - Review code for correctness (code-reviewer does that)
  - Run tests (validator does that)

  When running in `create-pr` node of the coding-workflow:

  1. READ THE CONTEXT
     You receive: branch_name, worktree_path, change_summary, task, risks,
     validation_results, docs_updated, and more from upstream nodes. Use
     them to author a clear PR description.

  2. STAGE AND COMMIT
     Run `git add -A` in the worktree to stage all changes.
     Commit with a conventional-commit-style message:
       feature   → feat: <short description>
       bugfix    → fix: <short description>
       refactor  → refactor: <short description>
       chore     → chore: <short description>
       docs      → docs: <short description>
     Keep the first line under 72 chars. Wrap a fuller description in the
     body with blank line separator.

  3. PUSH THE BRANCH
     `git push -u origin <branch_name>` — use the branch name from state.

  4. CREATE THE PR
     Use the gh CLI: `gh pr create --title "..." --body "$(cat <<EOF ... EOF)"`
     The body should be a markdown document with sections:
       ## Summary — restate the task
       ## Changes — summarize backend + frontend changes
       ## Validation — list what was checked (build, tests, lint)
       ## Tests — what was tested
       ## Risks — any known risks or follow-ups
       ## Documentation — what docs were updated (if any)

  5. RETURN THE PR URL
     Capture the output of `gh pr create` — it prints the PR URL. Include
     it in your JSON output.

  ${DELEGATION_INSTRUCTIONS}

  OUTPUT FORMAT:
  End with a JSON block containing:
    pr_url — the URL of the created PR
    commit_hash — the commit SHA
outputs:
  - pr_url
  - commit_hash
```

### 4.5 `code-reviewer`

```yaml
name: code-reviewer
displayName: Code Reviewer
teamName: engineering
teamRole: member
icon: eye
color: '#22d3ee'
provider: claude-cli
model: sonnet
tools: [filesystem, terminal]
capabilities:
  - code-review
  - conventions-enforcement
  - performance-analysis
  - readability
canDelegateTo: []
personality: >
  Constructive critic. Focuses on real issues, not style preferences. Every
  comment includes a concrete fix suggestion.
system: |
  You are a Senior Code Reviewer. You review diffs for correctness, conventions,
  performance, readability, and test quality. You do NOT do security review
  (that's security-specialist's job) or requirement validation (that's
  acceptance-tester's job).

  ${SPECIALIST_PREAMBLE}

  What to check:

  1. CORRECTNESS
     - Does the code actually do what the task says?
     - Are edge cases handled? (empty inputs, null, undefined, off-by-one)
     - Are error paths handled? (try/catch, fallbacks, retries where appropriate)
     - Are async operations awaited? No dangling promises.
     - Are race conditions avoided? (locks, queues, sequencing)

  2. REPO CONVENTIONS
     - File structure matches existing patterns
     - Naming matches existing conventions (camelCase vs snake_case, etc.)
     - Error handling pattern matches what's used elsewhere
     - Logging pattern matches

  3. PERFORMANCE (obvious issues only — not micro-optimizations)
     - No N+1 queries
     - No unnecessary loops over large data
     - No synchronous I/O in hot paths
     - No missing indexes on new DB columns used in WHERE clauses

  4. TEST QUALITY
     - Tests use real assertions, not `expect(true).toBe(true)`
     - Each test checks something meaningful
     - No disabled tests (`.skip`, `.only`)
     - No commented-out test cases
     - Test names describe behavior, not implementation

  5. READABILITY
     - Non-obvious code has comments explaining why (not what)
     - No dead code
     - No leftover debug prints / console.log / dbg!
     - Naming is clear — no single-letter variables outside loops
     - Functions do one thing

  6. TYPE SAFETY (for typed languages)
     - No `any` where a real type exists
     - No `!` non-null assertions where the type says nullable
     - Type imports are correct

  What NOT to flag:
  - Stylistic preferences that don't affect correctness (if (!x) vs if (x === null))
  - Scope additions beyond the original plan — the developer is allowed to add
    related code if it's a natural part of the work
  - Minor performance micro-optimizations
  - Documentation style (that's documentation-writer's job)
  - Security issues (that's security-specialist's job — don't duplicate)

  VERDICT:
    review_verdict: APPROVED          — ship it
    review_verdict: REQUEST_CHANGES   — specific issues must be fixed

  If REQUEST_CHANGES, your review_feedback MUST be actionable:
    For each issue: `<file>:<line>: <what's wrong>. <how to fix>.`

  ${DELEGATION_INSTRUCTIONS}

  OUTPUT FORMAT:
  End with a JSON block containing:
    review_verdict — "APPROVED" or "REQUEST_CHANGES"
    review_feedback — markdown string with actionable feedback
outputs:
  - review_verdict
  - review_feedback
```

### 4.6 `security-specialist`

```yaml
name: security-specialist
displayName: Security Specialist
teamName: engineering
teamRole: member
icon: shield
color: '#22d3ee'
provider: claude-cli
model: sonnet
tools: [filesystem, terminal]
capabilities:
  - threat-modeling
  - code-security-review
  - auth-review
  - owasp
  - secrets-management
  - pen-testing
canDelegateTo: []
personality: >
  Paranoid professionally. Assumes every input is malicious. Thinks like an
  attacker. Every finding includes a concrete exploit scenario.
system: |
  You are a Security Specialist. You review code changes for security issues:
  threat modeling, OWASP Top 10, auth flows, input validation, secrets
  management, dependency CVEs.

  ${SPECIALIST_PREAMBLE}

  What to check:

  1. INJECTION
     - SQL injection: all queries parameterized, no string concatenation
     - Command injection: no shell commands built from user input
     - XSS: all user-rendered content escaped
     - Prototype pollution: no unchecked Object.assign from user input
     - Template injection: no user input in template literals that render as HTML

  2. AUTHENTICATION & AUTHORIZATION
     - Password handling: hashed with bcrypt/argon2/scrypt (never plaintext, never fast hashes)
     - Session management: secure cookies, httpOnly, sameSite, proper expiry
     - JWT: signed with a strong secret, reasonable expiry, refresh flow
     - MFA: considered for sensitive operations
     - Authorization: every endpoint checks permissions — no implicit trust
     - IDOR: users can't access resources they don't own (check object ownership)
     - Privilege escalation: roles/permissions enforced server-side, not client-side

  3. INPUT VALIDATION
     - All inputs validated at the boundary (request body, query, params, headers)
     - Validation uses a schema library (zod, yup, joi, pydantic, etc.)
     - No unsanitized user input flowing into logs, DB, or HTML output
     - File uploads: type checked, size limited, stored outside web root

  4. SECRETS MANAGEMENT
     - No hardcoded secrets, API keys, passwords, or tokens anywhere
     - Secrets loaded from environment variables or secret manager
     - Secrets never logged, never in error messages, never in git history
     - New secrets properly added to secret storage (Allen's secrets collection)

  5. CRYPTOGRAPHY
     - Strong algorithms only (AES-256-GCM, not DES/RC4)
     - Proper key management (not hardcoded, rotated)
     - HTTPS/TLS enforced
     - No custom crypto (use proven libraries)

  6. SECURITY HEADERS
     - CSP where applicable
     - HSTS
     - X-Frame-Options, X-Content-Type-Options
     - CORS configured narrowly (not `*`)

  7. RATE LIMITING
     - Auth endpoints rate-limited
     - Expensive operations rate-limited

  8. DEPENDENCY RISKS
     - New dependencies: check for known CVEs
     - Don't add abandoned or untrusted packages
     - Pin versions (no `^` or `*` on security-critical deps)

  9. LOGGING
     - No PII in logs (emails, names, IDs are fine; passwords/tokens/secrets are NOT)
     - No stack traces exposed to users in production
     - Audit logs for sensitive operations (login, permission change, data export)

  10. ERROR HANDLING
     - Generic error messages to users (`Invalid credentials`, not `Password hash mismatch`)
     - Detailed errors in logs only
     - Stack traces never in HTTP responses

  VERDICT:
    security_verdict: APPROVED         — no security issues found
    security_verdict: REQUEST_CHANGES  — at least one security issue must be fixed

  If REQUEST_CHANGES, for each finding:
    - severity: critical | high | medium | low
    - location: file:line
    - issue: what's wrong
    - exploit: concrete scenario showing how it could be abused
    - fix: specific remediation

  Be paranoid about criticals — one critical = REQUEST_CHANGES. Multiple mediums
  with no criticals = your judgment call, lean toward REQUEST_CHANGES.

  ${DELEGATION_INSTRUCTIONS}

  OUTPUT FORMAT:
  End with a JSON block containing:
    security_verdict — "APPROVED" or "REQUEST_CHANGES"
    security_feedback — markdown string with findings
outputs:
  - security_verdict
  - security_feedback
```

### 4.7 `test-writer`

```yaml
name: test-writer
displayName: Test Writer
teamName: quality
teamRole: member
icon: flask
color: '#a855f7'
provider: claude-cli
model: sonnet
tools: [filesystem, terminal]
capabilities:
  - unit-tests
  - integration-tests
  - e2e-tests
  - test-framework-agnostic
canDelegateTo: []
personality: >
  Thorough but pragmatic. Writes tests that catch real bugs, not tests that
  boost coverage numbers. Uses the repo's existing test framework.
system: |
  You are a Test Writer. You write unit, integration, and end-to-end tests based
  on the test plan produced by test-planner. Tests are written AFTER the
  implementation is complete — you read the real code and write tests that
  exercise it against the plan's test cases.

  ${SPECIALIST_PREAMBLE}

  Your scope:
  - Unit tests: isolated functions and classes
  - Integration tests: components interacting with DB, API, or each other
  - End-to-end tests: full user flows (when the repo has e2e infrastructure)

  You do NOT:
  - Write production code
  - Run tests to check pass/fail (validator does that)
  - Change test framework choice (use what the repo uses)

  Process:

  1. READ THE TEST PLAN
     The test_plan from test-planner lists every test case, mapped to specific
     requirements. Each case has: name, type (unit/integration/e2e), and the
     assertion it should make. You must cover every test case in the plan.

  2. READ THE IMPLEMENTATION
     Look at backend_files and frontend_files in state — these list the files
     the developers created/modified. Read them to understand:
       - What functions/classes to test
       - What their signatures are
       - What modules they import from
       - Where to put test files (follow the repo's existing test layout)

  3. DETECT THE TEST FRAMEWORK
     Read package.json / Cargo.toml / go.mod / pyproject.toml to find the
     test framework. Look at existing tests in the repo to see the style.
     Match exactly — don't introduce a new framework.

     Common frameworks:
       jest, vitest, mocha, ava (JavaScript/TypeScript)
       pytest, unittest (Python)
       cargo test, proptest (Rust)
       go test, testify (Go)
       xctest (Swift), junit (Java/Kotlin)

  4. WRITE REAL TESTS
     Each test case in the plan becomes a real test function. Requirements:
       - Meaningful assertion (not `expect(true).toBe(true)`)
       - Clear test name describing behavior
       - Proper setup and teardown
       - Mocks for external services (not for the thing being tested)
       - Real inputs that exercise the case (not just happy-path defaults)

  5. COVER EDGE CASES
     The plan's edge_cases section lists boundary conditions. Write tests for
     each: empty inputs, null/undefined, very large values, concurrent access,
     failure modes.

  6. RUN THE TESTS ONCE
     After writing, run the tests with the repo's test command to see how many
     pass and fail. It's OK if some fail — the validator will handle that.
     What matters is that the tests exist and execute.

  7. DO NOT DELETE OR SKIP TESTS
     You can ADD tests. You cannot `.skip`, `.only`, `.todo`, or comment out
     existing tests. If a test doesn't make sense, flag it in your summary
     instead of silencing it.

  8. HANDLE RETRY CONTEXT
     If retry_context is provided, it means earlier tests didn't properly cover
     requirements. Read the missing items and write additional tests for them.

  ${DELEGATION_INSTRUCTIONS}

  OUTPUT FORMAT:
  End with a JSON block containing:
    test_files — list of test file paths created or modified
    test_summary — one paragraph describing what you tested
    tests_written — number of test cases written
outputs:
  - test_files
  - test_summary
  - tests_written
```

---

## 5. The `coding-workflow.yml` file

### 5.1 Input schema

```yaml
input:
  task:
    type: string
    required: true
    description: What needs to be done — feature, bugfix, refactor, docs, config, release
  repo_path:
    type: string
    required: true
    description: Absolute path of a registered repo
```

### 5.2 Node list (15 nodes)

| # | Node | Type | Agent | Output |
|---|---|---|---|---|
| 1 | `understand` | agent | `requirements-analyst` | requirements, acceptance_criteria, edge_cases, affected_areas, risks, open_questions |
| 2 | `clarify` | human | — | answers, approved |
| 3 | `implementation-plan` | agent | `engineering-lead` | changes, architecture_decisions, schema_changes, api_contracts, ui_changes, infrastructure_changes, security_approach, validation_approach, has_backend_changes, has_frontend_changes, risks |
| 4 | `test-plan` | agent | `test-planner` | test_plan (test cases + coverage map) |
| 5 | `create-branch` | code | create-workspace built-in | workspace_id, worktree_path, branch_name |
| 6 | `implement-backend` | agent | `backend-developer` | backend_files, backend_summary |
| 7 | `implement-frontend` | agent | `frontend-developer` | frontend_files, frontend_summary |
| 8 | `test-writer` | agent | `test-writer` | test_files, test_summary, tests_written |
| 9 | `validator` | agent | `qa-lead` | validation_passed, validation_results, failed_checks |
| 10 | `requirement-validator` | agent | `acceptance-tester` | completeness, requirement_results, missing_items |
| 11 | `security-review` | agent | `security-specialist` | security_verdict, security_feedback |
| 12 | `code-review` | agent | `code-reviewer` | review_verdict, review_feedback |
| 13 | `final-validation` | agent | `qa-lead` | final_passed, final_failed_items |
| 14 | `doc-update` | agent | `documentation-writer` | docs_updated, doc_files |
| 15 | `create-pr` | agent | `devops-engineer` | pr_url, commit_hash |

### 5.3 Edges (with retry loops)

```yaml
edges:
  # Phase 1: Understand (optionally via clarify)
  - { from: START, to: understand }
  - { from: understand, to: clarify, condition: "open_questions != 'none'" }
  - { from: understand, to: implementation-plan, condition: "open_questions == 'none'" }
  - { from: clarify, to: understand, condition: "approved == 'revise'", max_retries: 2 }
  - { from: clarify, to: implementation-plan, condition: "approved == 'proceed'" }
  - { from: clarify, to: END, condition: "approved == 'cancel'" }

  # Phase 2: Plan → Test Plan → Workspace
  - { from: implementation-plan, to: test-plan }
  - { from: test-plan, to: create-branch }

  # Phase 3: Parallel implement with conditional skip
  - { from: create-branch, to: [implement-backend, implement-frontend], parallel: true, join: wait-all, condition: "has_backend_changes AND has_frontend_changes" }
  - { from: create-branch, to: implement-backend, condition: "has_backend_changes AND NOT has_frontend_changes" }
  - { from: create-branch, to: implement-frontend, condition: "has_frontend_changes AND NOT has_backend_changes" }
  - { from: create-branch, to: test-writer, condition: "NOT has_backend_changes AND NOT has_frontend_changes" }

  # Join both implement paths → test-writer
  - { from: [implement-backend, implement-frontend], to: test-writer }
  - { from: implement-backend, to: test-writer, condition: "NOT has_frontend_changes" }
  - { from: implement-frontend, to: test-writer, condition: "NOT has_backend_changes" }

  # Phase 4: test-writer → validator
  - { from: test-writer, to: validator }

  # Validator retry loop — back to implement(s)
  - { from: validator, to: [implement-backend, implement-frontend], condition: "NOT validation_passed AND has_backend_changes AND has_frontend_changes", parallel: true, join: wait-all, max_retries: 3, retry_context: "Validation failed:\n{{failed_checks}}" }
  - { from: validator, to: implement-backend, condition: "NOT validation_passed AND has_backend_changes AND NOT has_frontend_changes", max_retries: 3, retry_context: "Validation failed:\n{{failed_checks}}" }
  - { from: validator, to: implement-frontend, condition: "NOT validation_passed AND has_frontend_changes AND NOT has_backend_changes", max_retries: 3, retry_context: "Validation failed:\n{{failed_checks}}" }

  - { from: validator, to: requirement-validator, condition: "validation_passed" }

  # Requirement-validator retry loop
  - { from: requirement-validator, to: [implement-backend, implement-frontend], condition: "completeness != 'fully_complete' AND has_backend_changes AND has_frontend_changes", parallel: true, join: wait-all, max_retries: 3, retry_context: "Requirements not fully met:\n{{missing_items}}" }
  - { from: requirement-validator, to: implement-backend, condition: "completeness != 'fully_complete' AND has_backend_changes AND NOT has_frontend_changes", max_retries: 3, retry_context: "Requirements not fully met:\n{{missing_items}}" }
  - { from: requirement-validator, to: implement-frontend, condition: "completeness != 'fully_complete' AND has_frontend_changes AND NOT has_backend_changes", max_retries: 3, retry_context: "Requirements not fully met:\n{{missing_items}}" }

  - { from: requirement-validator, to: security-review, condition: "completeness == 'fully_complete'" }

  # Security retry loop
  - { from: security-review, to: [implement-backend, implement-frontend], condition: "security_verdict == 'REQUEST_CHANGES' AND has_backend_changes AND has_frontend_changes", parallel: true, join: wait-all, max_retries: 3, retry_context: "Security feedback:\n{{security_feedback}}" }
  - { from: security-review, to: implement-backend, condition: "security_verdict == 'REQUEST_CHANGES' AND has_backend_changes AND NOT has_frontend_changes", max_retries: 3, retry_context: "Security feedback:\n{{security_feedback}}" }
  - { from: security-review, to: implement-frontend, condition: "security_verdict == 'REQUEST_CHANGES' AND has_frontend_changes AND NOT has_backend_changes", max_retries: 3, retry_context: "Security feedback:\n{{security_feedback}}" }

  - { from: security-review, to: code-review, condition: "security_verdict == 'APPROVED'" }

  # Code review retry loop
  - { from: code-review, to: [implement-backend, implement-frontend], condition: "review_verdict == 'REQUEST_CHANGES' AND has_backend_changes AND has_frontend_changes", parallel: true, join: wait-all, max_retries: 3, retry_context: "Code review feedback:\n{{review_feedback}}" }
  - { from: code-review, to: implement-backend, condition: "review_verdict == 'REQUEST_CHANGES' AND has_backend_changes AND NOT has_frontend_changes", max_retries: 3, retry_context: "Code review feedback:\n{{review_feedback}}" }
  - { from: code-review, to: implement-frontend, condition: "review_verdict == 'REQUEST_CHANGES' AND has_frontend_changes AND NOT has_backend_changes", max_retries: 3, retry_context: "Code review feedback:\n{{review_feedback}}" }

  - { from: code-review, to: final-validation, condition: "review_verdict == 'APPROVED'" }

  # Final validation retry loop
  - { from: final-validation, to: [implement-backend, implement-frontend], condition: "NOT final_passed AND has_backend_changes AND has_frontend_changes", parallel: true, join: wait-all, max_retries: 2, retry_context: "Final validation failed:\n{{final_failed_items}}" }
  - { from: final-validation, to: implement-backend, condition: "NOT final_passed AND has_backend_changes AND NOT has_frontend_changes", max_retries: 2, retry_context: "Final validation failed:\n{{final_failed_items}}" }
  - { from: final-validation, to: implement-frontend, condition: "NOT final_passed AND has_frontend_changes AND NOT has_backend_changes", max_retries: 2, retry_context: "Final validation failed:\n{{final_failed_items}}" }

  - { from: final-validation, to: doc-update, condition: "final_passed" }

  # Phase 5: Docs → PR
  - { from: doc-update, to: create-pr }
  - { from: create-pr, to: END }
```

### 5.4 Retry budget summary

| Gate | Retries | Total worst-case attempts |
|---|---|---|
| validator | 3 | 4 |
| requirement-validator | 3 | 4 |
| security-review | 3 | 4 |
| code-review | 3 | 4 |
| final-validation | 2 | 3 |
| clarify | 2 | 3 |
| **Total across all gates** | **16** | — |

If any gate exhausts its budget, `getNextNodes` throws `Max retries (N) exceeded for edge ...` and the execution fails.

---

## 6. Failure report persistence

Add a new MongoDB collection `execution_failure_reports` with schema:

```ts
{
  _id: ObjectId,
  executionId: string,           // matches executions.id
  workflowName: string,
  failedAt: Date,
  failureType: 'max_retries_exceeded' | 'node_threw' | 'unknown',
  failedNode: string,             // e.g. 'requirement-validator'
  retryEdgeKey?: string,          // e.g. 'validator→implement-backend,implement-frontend'
  retryCount?: number,            // how many retries were consumed before failing

  // Gate-specific diagnostic info pulled from state
  lastValidatorResult?: {
    validation_passed: boolean,
    failed_checks: string[],
  },
  lastRequirementResult?: {
    completeness: string,
    missing_items: string[],
    requirement_results: object,
  },
  lastSecurityResult?: {
    security_verdict: string,
    security_feedback: string,
  },
  lastCodeReviewResult?: {
    review_verdict: string,
    review_feedback: string,
  },
  lastFinalValidation?: {
    final_passed: boolean,
    final_failed_items: string[],
  },

  // Full state snapshot for forensics
  finalState: Record<string, unknown>,
  completedNodes: string[],

  // Human-readable error message
  errorMessage: string,

  // Link to the execution for UI navigation
  executionUrl: string,

  createdAt: Date,
}
```

The failure report is saved by the engine in the `catch` block of `run()` whenever status transitions to `failed`. A new helper `buildFailureReport(exec, error)` introspects the state and extracts the relevant "why failed" fields.

New API endpoint: `GET /api/executions/:id/failure-report` returns the saved report.

UI surfacing (optional for now): the execution detail page shows a "Failure Report" panel when status is `failed`.

---

## 7. Org cleanup logic

### 7.1 Where it lives

New file: `packages/server/src/services/org-cleanup.ts`

```ts
import type { Db } from 'mongodb';

/**
 * Delete teams, agents, and workflows that are no longer in the seed but
 * were previously system-seeded. Meta team is never touched.
 *
 * Called once per server boot, AFTER the seed creates/updates rows.
 */
export async function cleanupOrphanedSeedEntities(
  db: Db,
  keepTeams: string[],       // names of teams in the current seed
  keepAgents: string[],      // names of agents in the current seed
  keepWorkflows: string[],   // names of workflows whose YAML still exists
): Promise<{
  teamsDeleted: number;
  agentsDeleted: number;
  workflowsDeleted: number;
}> {
  // ALWAYS protect meta team and all its members
  const PROTECTED_TEAM = 'meta';

  const result = { teamsDeleted: 0, agentsDeleted: 0, workflowsDeleted: 0 };

  // 1. Delete agents that:
  //    - are NOT in keepAgents
  //    - are NOT in meta team
  //    - have createdBy: 'seed' or missing (system-created)
  const agents = db.collection('agents');
  const agentsToDelete = await agents.find({
    name: { $nin: keepAgents },
    teamName: { $ne: PROTECTED_TEAM },
    $or: [{ createdBy: 'seed' }, { createdBy: { $exists: false } }],
  }).toArray();

  for (const a of agentsToDelete) {
    await agents.deleteOne({ _id: a._id });
    console.log(`[cleanup] Deleted agent: ${a.name} (team=${a.teamName})`);
    result.agentsDeleted++;
  }

  // 2. Delete teams that:
  //    - are NOT in keepTeams
  //    - are NOT the meta team
  //    - have isBuiltIn: true
  const teams = db.collection('teams');
  const teamsToDelete = await teams.find({
    name: { $nin: keepTeams },
    name: { $ne: PROTECTED_TEAM },
    isBuiltIn: true,
  }).toArray();

  for (const t of teamsToDelete) {
    await teams.deleteOne({ _id: t._id });
    console.log(`[cleanup] Deleted team: ${t.name}`);
    result.teamsDeleted++;
  }

  // 3. Delete workflows that:
  //    - are NOT in keepWorkflows
  //    - have createdBy: 'system'
  const workflows = db.collection('workflows');
  const workflowsToDelete = await workflows.find({
    name: { $nin: keepWorkflows },
    createdBy: 'system',
  }).toArray();

  for (const w of workflowsToDelete) {
    await workflows.deleteOne({ _id: w._id });
    console.log(`[cleanup] Deleted workflow: ${w.name}`);
    result.workflowsDeleted++;
  }

  return result;
}
```

### 7.2 Where it's called

In `packages/server/src/app.ts` main():

```ts
await new OrgSeedService(db).seed();
await seedDefaultWorkflows(db);

// Cleanup orphaned seed entities
const keepTeams = ['meta', 'executive', 'product', 'engineering', 'quality'];
const keepAgents = [
  // meta
  'team-builder-agent', 'agent-builder-agent', 'planner-agent', 'repo-scanner', 'research-agent',
  // executive
  'ceo',
  // product
  'product-manager', 'requirements-analyst', 'acceptance-tester',
  // engineering
  'engineering-lead', 'backend-developer', 'frontend-developer', 'devops-engineer',
  'code-reviewer', 'security-specialist', 'documentation-writer', 'codebase-navigator',
  // quality
  'qa-lead', 'test-planner', 'test-writer',
];
const keepWorkflows = ['coding-workflow'];

const cleanup = await cleanupOrphanedSeedEntities(db, keepTeams, keepAgents, keepWorkflows);
console.log(`[cleanup] Removed ${cleanup.teamsDeleted} teams, ${cleanup.agentsDeleted} agents, ${cleanup.workflowsDeleted} workflows`);
```

### 7.3 Safety checks

- **Protected**: meta team and all its members (hard-coded check)
- **Protected**: user-created entities (`createdBy !== 'seed'` and `createdBy !== 'system'`)
- **Hard delete**: no soft delete, rows are removed from the DB (as requested)
- **Logs every deletion** for forensics

---

## 8. Node `implementation-plan` — system prompt update note

The `engineering-lead` agent is the agent behind the `implementation-plan` workflow node. When invoked from the workflow, the node's YAML prompt gives it the task + acceptance criteria, and the agent's system prompt (from section 4.1) tells it how to produce the plan.

The workflow node's prompt template:

```yaml
implementation-plan:
  agent: engineering-lead
  prompt: |
    Produce an implementation plan for this coding task.

    TASK: {{task}}
    TASK TYPE (from requirements): {{task_type}}
    REQUIREMENTS: {{requirements}}
    ACCEPTANCE CRITERIA: {{acceptance_criteria}}
    EDGE CASES: {{edge_cases}}
    AFFECTED AREAS: {{affected_areas}}
    RISKS (from analysis): {{risks}}
    {{#if answers}}CLARIFICATIONS FROM USER: {{answers}}{{/if}}

    Read the repo context via get_repo_context to understand the tech stack,
    build system, and conventions.

    Produce a complete plan as described in your system prompt: architecture,
    schema, APIs, UI, infrastructure, security approach, validation commands,
    and has_backend_changes / has_frontend_changes flags.
  outputs:
    - changes
    - architecture_decisions
    - schema_changes
    - api_contracts
    - ui_changes
    - infrastructure_changes
    - security_approach
    - validation_approach
    - has_backend_changes
    - has_frontend_changes
```

---

## 8b. Dynamic org-structure injection for chat (NEW)

### Problem with the current approach

Today, every lead's system prompt in `org-seed.ts` hand-writes who it can delegate to:

```
You delegate domain work to team leads:
- Product decisions → product-manager
- Backend technical → backend-lead
- Frontend technical → frontend-lead
...
```

And `buildAgentSystemPrompt` in `chat.service.ts:712-713` just dumps the flat list:

```ts
parts.push(`\nYou can delegate tasks to: ${canDelegateTo.join(', ')} using delegate_to_agent.`);
```

This has two bugs:
1. **Prompt drift** — every time we add/remove/rename an agent, we must hand-edit the system prompts of every agent that references it. We have already broken this multiple times.
2. **Shallow info** — the agent only gets names, not what each target does, which team it's in, or who its reports are. CEO can't make informed delegation decisions without knowing "frontend-developer handles React/Vue UI work" at runtime.

### The fix — inject the live org chart at runtime

Replace the hand-written delegation sections in every lead's `system` prompt with a placeholder that `chat.service.ts` and the workflow agent-resume path fill in from the DB, using the current state of the `agents` and `teams` collections.

**Implementation**

1. **New `description` field on every agent and team**

   Add a required `description: string` field (≤140 chars, one sentence) to every entry in `AGENTS` and `TEAMS` in `org-seed.ts`. This is the canonical short explanation of what the agent/team does — used by the org-context renderer and nothing else.

   Example additions:

   ```ts
   // Team
   { name: 'engineering', displayName: 'Engineering',
     description: 'Builds and ships code — backend, frontend, infra, security, tests, docs.', ... }

   // Agent
   { name: 'backend-developer', displayName: 'Backend Developer',
     description: 'Writes server-side code, APIs, database logic, and service integrations.', ... }
   { name: 'code-reviewer', displayName: 'Code Reviewer',
     description: 'Reviews diffs for correctness, conventions, readability, and obvious bugs.', ... }
   { name: 'security-specialist', displayName: 'Security Specialist',
     description: 'Threat-models features, audits auth/secrets, flags OWASP issues.', ... }
   ```

   All 20 agents + 5 teams get a `description`. No other schema changes.

2. **New helper** `packages/server/src/services/org-context.ts`:

   ```ts
   import type { Db } from 'mongodb';

   export interface OrgContextOptions {
     /** Render a per-agent "direct delegation targets" section for this agent. */
     forAgent?: string;
     /** Render the full org chart (all teams + members). Default: true. */
     includeFullChart?: boolean;
     /** Include the meta team in the chart. Default: true. */
     includeMeta?: boolean;
   }

   /**
    * Build a flat, description-rich org chart block for injection into an
    * agent's system prompt at runtime. Reflects the current DB state — no
    * prompt edits needed when agents are added, removed, or renamed.
    *
    * Output style:
    *   - Flat (no `### Team` subheads — one section per team as a bold line)
    *   - Every agent shows `name — description` (no capability tags)
    *   - Meta team included so CEO / Allen Assistant know the builders exist
    */
   export async function buildOrgContextBlock(
     db: Db,
     options: OrgContextOptions = {},
   ): Promise<string> {
     const teams = await db.collection('teams').find({}).toArray();
     const agents = await db.collection('agents').find({}).toArray();
     const agentByName = new Map(agents.map(a => [a.name, a]));

     const includeMeta = options.includeMeta !== false;
     const visibleTeams = teams.filter(t => includeMeta || t.name !== 'meta');

     const lines: string[] = [];

     // ── Flat org chart ──
     if (options.includeFullChart !== false) {
       lines.push('## Organisation');
       lines.push('');
       for (const team of visibleTeams) {
         const members = agents
           .filter(a => a.teamName === team.name)
           .sort((a, b) => (a.teamRole === 'lead' ? -1 : b.teamRole === 'lead' ? 1 : 0));
         if (members.length === 0) continue;

         const teamLabel = team.displayName ?? team.name;
         const teamDesc = team.description ? ` — ${team.description}` : '';
         lines.push(`**${teamLabel} team**${teamDesc}`);

         for (const m of members) {
           const role = m.teamRole === 'lead' ? ' (lead)' : '';
           const desc = m.description ?? m.displayName ?? m.name;
           lines.push(`- ${m.name}${role} — ${desc}`);
         }
         lines.push('');
       }
     }

     // ── Per-agent delegation targets ──
     if (options.forAgent) {
       const self = agentByName.get(options.forAgent);
       const targets = (self?.canDelegateTo ?? []) as string[];
       if (targets.length > 0) {
         lines.push('## Your delegation targets');
         lines.push('');
         lines.push('Call `delegate_to_agent(agent_name, task)` with one of:');
         lines.push('');
         for (const t of targets) {
           const ag = agentByName.get(t);
           if (!ag) continue;
           const team = ag.teamName ? ` [${ag.teamName}]` : '';
           const desc = ag.description ?? ag.displayName ?? ag.name;
           lines.push(`- ${ag.name}${team} — ${desc}`);
         }
         lines.push('');
         lines.push('Pick the most specific target. Do NOT do the work yourself if a specialist exists.');
       }
     }

     return lines.join('\n');
   }
   ```

   **Rendered example for `ceo` — what the model actually sees:**

   ```
   ## Organisation

   **Executive team** — Top-level coordination, strategy, and cross-team decisions.
   - ceo (lead) — Sets priorities, approves plans, and resolves cross-team tradeoffs.
   - strategy-analyst — Researches markets, competitors, and ROI for proposed work.
   - roadmap-coordinator — Tracks milestones, deadlines, and release planning.
   - stakeholder-reporter — Summarises progress for stakeholders and leadership.

   **Product team** — Owns requirements, UX, and acceptance criteria.
   - product-manager (lead) — Prioritises features and coordinates product delivery.
   - requirements-analyst — Turns tasks into concrete requirements and acceptance criteria.
   - ux-spec-writer — Designs UX flows, wireframes, and interaction specs.
   - acceptance-tester — Verifies built features against acceptance criteria.

   **Engineering team** — Builds and ships code — backend, frontend, infra, security, tests, docs.
   - engineering-lead (lead) — Designs implementation plans and coordinates specialists.
   - backend-developer — Writes server-side code, APIs, database logic, and service integrations.
   - frontend-developer — Builds UI components, pages, and client-side state/interaction.
   - devops-engineer — Owns CI/CD, infrastructure-as-code, containers, and cloud deploys.
   - code-reviewer — Reviews diffs for correctness, conventions, readability, and obvious bugs.
   - security-specialist — Threat-models features, audits auth/secrets, flags OWASP issues.
   - test-writer — Writes unit and integration tests matching the repo's existing framework.
   - documentation-writer — Updates READMEs, changelogs, API docs, and inline comments.
   - codebase-navigator — Explores unfamiliar repos and surfaces relevant files and patterns.

   **Quality team** — Runs validation gates, QA checks, and quality reviews.
   - qa-lead (lead) — Designs test strategy and runs build/test/lint validation gates.

   **Meta team** — Builders that extend the org itself — create new teams and agents.
   - team-builder-agent (lead) — Designs and creates new teams on demand.
   - agent-builder-agent — Adds new specialist agents to existing teams.
   - workflow-builder-agent — Designs and writes new workflow YAMLs.
   - prompt-engineer — Refines agent system prompts for quality and alignment.
   - org-auditor — Audits the org for duplicate or obsolete agents.

   ## Your delegation targets

   Call `delegate_to_agent(agent_name, task)` with one of:

   - product-manager [product] — Prioritises features and coordinates product delivery.
   - engineering-lead [engineering] — Designs implementation plans and coordinates specialists.
   - qa-lead [quality] — Designs test strategy and runs build/test/lint validation gates.
   - strategy-analyst [executive] — Researches markets, competitors, and ROI for proposed work.
   - roadmap-coordinator [executive] — Tracks milestones, deadlines, and release planning.
   - stakeholder-reporter [executive] — Summarises progress for stakeholders and leadership.

   Pick the most specific target. Do NOT do the work yourself if a specialist exists.
   ```

   **For `engineering-lead`:** same `## Organisation` block above, then:

   ```
   ## Your delegation targets

   Call `delegate_to_agent(agent_name, task)` with one of:

   - backend-developer [engineering] — Writes server-side code, APIs, database logic, and service integrations.
   - frontend-developer [engineering] — Builds UI components, pages, and client-side state/interaction.
   - devops-engineer [engineering] — Owns CI/CD, infrastructure-as-code, containers, and cloud deploys.
   - code-reviewer [engineering] — Reviews diffs for correctness, conventions, readability, and obvious bugs.
   - security-specialist [engineering] — Threat-models features, audits auth/secrets, flags OWASP issues.
   - test-writer [engineering] — Writes unit and integration tests matching the repo's existing framework.
   - documentation-writer [engineering] — Updates READMEs, changelogs, API docs, and inline comments.
   - codebase-navigator [engineering] — Explores unfamiliar repos and surfaces relevant files and patterns.
   - qa-lead [quality] — Designs test strategy and runs build/test/lint validation gates.

   Pick the most specific target. Do NOT do the work yourself if a specialist exists.
   ```

   **For `product-manager`:** same `## Organisation` block above, then:

   ```
   ## Your delegation targets

   Call `delegate_to_agent(agent_name, task)` with one of:

   - requirements-analyst [product] — Turns tasks into concrete requirements and acceptance criteria.
   - ux-spec-writer [product] — Designs UX flows, wireframes, and interaction specs.
   - acceptance-tester [product] — Verifies built features against acceptance criteria.
   - engineering-lead [engineering] — Designs implementation plans and coordinates specialists.
   - qa-lead [quality] — Designs test strategy and runs build/test/lint validation gates.

   Pick the most specific target. Do NOT do the work yourself if a specialist exists.
   ```

   **For `Allen Assistant` (default, no agent selected):** only the `## Organisation` block (no `## Your delegation targets` section, since the Assistant uses `spawn_agent` / `run_workflow` not `delegate_to_agent`).

3. **Modify `chat.service.ts`**

   - **`buildAgentSystemPrompt` (line 692-777):** replace the flat `canDelegateTo.join(', ')` line (712-713) with a call to `buildOrgContextBlock(db, { forAgent: agentName, includeFullChart: true })`. Every chat message to a lead (ceo, engineering-lead, product-manager, qa-lead) now gets the live org chart + description-rich per-target list.

   - **`getSystemPrompt` (Allen Assistant default, line 117-229):** after the `base` prompt and before the `reposBlock`, insert the org chart via `buildOrgContextBlock(db, { includeFullChart: true })`. The assistant no longer needs the hand-written "TEAM BUILDER ROUTING" hints to know which lead handles which domain — it reads it from the DB every request.

4. **Modify `packages/engine/src/node-executor.ts`** (workflow agent calls)

   When an agent is invoked as a workflow node, the engine builds the `customSystemPrompt` from `agent.system`. Inject the same org context block *after* `agent.system` so workflow-mode agents also see the live org structure. This keeps chat and workflow-mode behavior aligned — a lead behaves the same whether called from chat or from a workflow node.

5. **Simplify the 7 new agent `system` prompts in section 4**

   Remove the hand-written delegation lists from every lead's system prompt and replace them with a single runtime-filled marker. Example for `ceo` (current):

   ```
   You delegate domain work to team leads:
   - Product decisions → product-manager
   - Backend technical → backend-lead
   ...
   ```

   becomes (new):

   ```
   You are the top-level coordinator. Your org structure and delegation targets
   are provided below at runtime — read them before deciding who to delegate to.

   When a task arrives:
   1. Look at the org structure to find the right team.
   2. Look at your direct delegation targets for a matching lead.
   3. Call delegate_to_agent(target, task) with a specific, actionable brief.
   ```

   Same pattern for `engineering-lead`, `product-manager`, `qa-lead`. The org-context block is appended automatically at prompt-build time, so these prompts never go stale.

6. **Also remove the hardcoded `canDelegateTo` lists from `org-seed.ts`?**

   **No.** Keep `canDelegateTo` in `org-seed.ts` — it's still the source of truth for *which* agents a lead can delegate to (the allowlist used by `chat-tools.ts:1256` to reject unauthorized delegations at runtime). What changes is that the *prompt text describing those targets* is generated from the DB row instead of being hand-written in the `system` string.

   When a new specialist is added to an existing team, we only need to add its name to the lead's `canDelegateTo` array. The prompt updates automatically on the next chat message.

### Why this is better

| Concern | Before | After |
|---|---|---|
| Add a new specialist | Edit lead's `system` prompt text + `canDelegateTo` | Edit `canDelegateTo` only |
| Rename an agent | Edit every mention in every `system` prompt | Zero edits (read from DB) |
| Lead knows specialist capabilities | No — just a name | Yes — capabilities injected per call |
| Allen Assistant knows org chart | No (hardcoded hints) | Yes (live chart) |
| Consistent chat vs workflow behavior | No — different prompt assembly | Yes — same `buildOrgContextBlock` helper |
| Cost | One extra DB read per message (~5ms) | Negligible |

### Caching note

`buildOrgContextBlock` reads `teams` + `agents` on every call. Both collections are small (<50 docs total). Caching is not needed v1 — if it shows up on the profiler later, add a 30-second in-memory TTL in `org-context.ts` keyed on `teams.version + agents.version` hashes. Not doing it now.

---

## 9. Implementation plan (file changes)

When the user approves this plan doc, the following file changes will be made.
**No commit will be made — the user will commit after review.**

### Files to modify

| File | What |
|---|---|
| `packages/server/src/services/org-seed.ts` | Remove 47 agents, remove 7 teams, add 1 team (`engineering`), add 7 agents, move 2 agents to engineering team, update `canDelegateTo` lists on remaining leads, strip hand-written delegation target descriptions from all lead `system` prompts, **add `description: string` field to every remaining agent (20) and every remaining team (5)** — one-sentence explanation used by `buildOrgContextBlock` |
| `packages/server/src/services/chat.service.ts` | `buildAgentSystemPrompt` (line 692) — replace flat `canDelegateTo.join(', ')` (line 713) with `buildOrgContextBlock(db, { forAgent, includeFullChart: true })`. `getSystemPrompt` (line 117) — inject `buildOrgContextBlock(db, { includeFullChart: true })` into the Allen Assistant default prompt before `reposBlock` |
| `packages/engine/src/node-executor.ts` | When building `customSystemPrompt` for a workflow agent call, append `buildOrgContextBlock(db, { forAgent: agent.name, includeFullChart: true })` so workflow-mode agents see the same live org chart as chat-mode agents |
| `packages/server/src/app.ts` | Import and call `cleanupOrphanedSeedEntities` after seed |
| `packages/server/src/services/execution.service.ts` OR `packages/engine/src/engine.ts` | Save failure report to DB when status becomes `failed` |
| `packages/server/src/routes/execution.routes.ts` | Add `GET /:id/failure-report` endpoint |
| `packages/server/src/database/indexes.ts` | Add index on `execution_failure_reports.executionId` |

### Files to create

| File | Purpose |
|---|---|
| `packages/server/src/services/org-cleanup.ts` | Delete orphaned seed teams/agents/workflows, protects meta |
| `packages/server/src/services/org-context.ts` | `buildOrgContextBlock(db, options)` — renders the live org chart + per-agent delegation targets from the DB for runtime prompt injection |
| `packages/engine/workflows/coding-workflow.yml` | The new universal coding workflow |
| (this doc) `docs/plans/org-simplification-and-coding-workflow.md` | This plan document |

### Files to delete

| File | Why |
|---|---|
| `packages/engine/workflows/feature-development.yml` | Replaced by coding-workflow |
| `packages/engine/workflows/quick-bugfix.yml` | Replaced by coding-workflow |
| `packages/engine/workflows/refactor.yml` | Replaced by coding-workflow |
| `packages/engine/workflows/production-incident.yml` | Replaced by coding-workflow |
| `packages/engine/workflows/data-analysis.yml` | Replaced by coding-workflow |
| `packages/engine/workflows/review-only.yml` | Replaced by coding-workflow |
| `packages/engine/workflows/test-create-workspace.yml` | Test workflow, no longer needed |

---

## 10. Verification checklist (post-implementation)

Before deploying, run locally:

- [ ] `cd packages/server && npx tsc --noEmit` — clean
- [ ] `cd packages/engine && npm run build` — clean
- [ ] `cd packages/engine && node -e 'const yaml = require("js-yaml"); yaml.load(require("fs").readFileSync("workflows/coding-workflow.yml"))'` — parses without error
- [ ] The YAML validator passes (engine's `validateWorkflow` function)
- [ ] `coding-workflow.yml` references only agents that exist in the new seed
- [ ] All retry loops have `max_retries` set
- [ ] Manual trace through happy path (18 node executions expected)
- [ ] Manual trace through retry paths (validator, requirement, security, code, final)

---

## 11. Open items for user to confirm before implementation

1. ✅ Teams: 5 total (meta + executive + product + engineering + quality) — confirmed
2. ✅ Agents: 20 total (5 meta + 15 non-meta) — confirmed
3. ✅ Agent system prompts: reviewed in this doc — **user to confirm**
4. ✅ Workflow: `coding-workflow.yml` with 15 nodes, 4 retry gates — confirmed
5. ✅ Order: plan → test-plan → implement → test-writer — confirmed
6. ✅ Failure report: saved to DB — confirmed
7. ✅ Final validation: reuses current worktree — confirmed
8. ✅ Code review: allows scope additions — confirmed
9. ✅ Deploy strategy: one big local change, user commits and deploys — confirmed
10. ✅ Meta team: NEVER touched — confirmed
11. ✅ Dynamic org-chart injection into chat + workflow agent prompts — **user to confirm (section 8b)**
12. ✅ Lead `system` prompts will be simplified — hand-written delegation target lists removed, replaced by runtime-injected org block — **user to confirm**

When all 7 agent system prompts above are approved AND section 8b is approved, proceed to code changes.
