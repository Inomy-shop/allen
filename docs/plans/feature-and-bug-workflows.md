# Feature & Bug Workflows — Design Plan

> Status: draft · owner: allen · last updated: 2026-04-15
>
> This document plans the two primary orchestration paths Allen needs to
> support: one for **new features** (plan → review → implement → validate →
> test → PR) and one for **bug fixes** (investigate → fix → review → PR). It
> is written with the "why" inline so later reviewers can understand the
> tradeoffs, not just the outcome.

## 1. Executive summary

Allen needs two orchestration paths, not one. Mashing them into a single
workflow produces either a bloated process for bug fixes or a flimsy process
for features. Keeping them separate lets each one be sized to its actual
risk profile.

- **Feature path** → expensive upfront planning (PRD + HLA + TDD), agent-only
  review of each doc against the user's original ask, single human gate to
  approve the plan, then implementation with a validator that keeps
  implementation faithful to the design. Tests are reviewed against
  acceptance criteria, not just "did they run."
- **Bug fix path** → no design docs, no planning phase. A bug investigator
  finds the root cause, a coding agent fixes it, a single code review (which
  now always includes security) runs, a PR opens. Lean.

Both paths share the same code-review step (security checklist always
included), the same build+lint validation discipline inside every coding
agent, the same `create_branch` node that opens an isolated git worktree
before any code is written, and the same final `summary` node that posts
a machine-readable + human-readable implementation summary back to the
chat session and uploads it as a shareable `.md` link.

**No new teams created.** The five new agents (`solution-architect`,
`technical-designer`, `doc-auditor`, `implementation-validator`,
`bug-investigator`) slot into the existing `engineering`, `product`, and
`quality` teams based on what they functionally own. `requirements-
analyst` stays in `product` where it already lives.

**Human touches per run, steady state:**

| Path | Touches | Where |
|---|---|---|
| Feature (untrusted) | 2–4 | (1) initial ask, (2) clarification answer, (3) plan approval, (4) PR merge |
| Feature (trusted) | 1–3 | skips the plan approval gate |
| Bug fix | 1–2 | (1) initial bug report, (2) PR merge |

## 2. Why two workflows, not one parameterised workflow

Tempting option: one big workflow with a `task_type: feature | bug` input,
and condition nodes that skip planning for bugs. Rejected, because:

1. **Feature nodes ≠ bug nodes at a type level.** A feature run emits design
   docs and requires a validator that checks the diff against those docs. A
   bug run doesn't have design docs — the validator has nothing to compare.
   Collapsing them forces the bug path to fabricate inputs the validator can
   pretend to read, or forces the validator node to branch internally on
   task type. Both are worse than two workflows.
2. **Cost per run should scale with risk.** Bug fixes on average are 10x
   cheaper to plan than features. A parameterised workflow hides that cost
   difference from the user; two workflows make it explicit.
3. **Mental model.** "I'm fixing a bug" is a different mental mode from "I'm
   building a feature." The user already has the mental switch; the system
   should match it instead of fighting it.

**What they DO share** — we pull out the shared pieces into reusable
sub-workflows (see §6), not into one mega-workflow.

## 3. The feature workflow: `feature-plan-and-implement`

Two phases in one workflow file. Phase 1 ends at a human gate; Phase 2
consumes the approved plan and never touches the user again until the PR
is ready.

### 3.1 Pipeline shape

```
start
 │
 │ inputs: user_request (string), repo_path (string), trusted_mode (bool=false)
 ▼
─── PHASE 1: PLANNING ─────────────────────────────────────────────
 │
 │  (agent: requirements-analyst)
 ├─▶ clarify
 │    Emits up to 3 clarifying questions, or none if the ask is clear.
 │    Condition: if questions emitted → human node pauses, user answers
 │
 ├─▶ produce_prd
 │    (agent: requirements-analyst)
 │    Produces structured PRD: user stories, acceptance criteria
 │    (Given/When/Then), edge cases, out of scope, assumptions,
 │    non-functional requirements. Ends with a JSON block.
 │
 ├─▶ audit_prd
 │    (agent: doc-auditor)
 │    Checks PRD against the original user_request. Verdict:
 │    approve | revise_with_feedback | escalate.
 │    revise → retry produce_prd (max 2 retries). escalate → human.
 │
 ├─▶ produce_hla
 │    (agent: solution-architect)
 │    Reads PRD. Produces High-Level Architecture: components,
 │    data flow, tech choices with rationale, non-functional reqs,
 │    tradeoffs considered, build-vs-buy, rough cost estimate.
 │
 ├─▶ audit_hla
 │    (agent: doc-auditor)
 │    Checks HLA against PRD + user_request. Same verdict shape.
 │    revise → retry produce_hla (max 2). escalate → human.
 │
 ├─▶ produce_tdd
 │    (agent: technical-designer)
 │    Reads PRD + HLA. Produces TDD: data models, API contracts,
 │    sequence diagrams (mermaid), error taxonomy, observability plan,
 │    has_backend_changes, has_frontend_changes.
 │
 ├─▶ audit_tdd
 │    (agent: doc-auditor)
 │    Checks TDD against PRD + HLA + user_request. Same verdict.
 │
 ├─▶ persist_docs
 │    (code node)
 │    Writes all three docs to `design_docs` Mongo collection,
 │    uploads each as public .md via existing /api/files, stores
 │    URLs in workflow state for downstream nodes and the human gate.
 │
 ├─▶ [condition] trusted_mode?
 │     true  → skip human gate
 │     false → human_gate_plan_approval (human node)
 │             Card: summaries + links to all three docs +
 │             audit verdict summary + "Approve / Request changes / Reject"
 │
─── PHASE 2: IMPLEMENTATION ───────────────────────────────────────
 │
 ├─▶ plan_implementation
 │    (agent: engineering-lead, existing, with modified prompt)
 │    Consumes approved PRD + HLA + TDD. Does NOT redesign. Produces
 │    a file-level implementation plan: files to touch, exact diffs at
 │    a conceptual level, migrations, commit strategy, validation
 │    commands, parallel-branch flags.
 │
 ├─▶ create_branch
 │    (code node, function: create-workspace — EXISTING built-in)
 │    Creates a git worktree + new branch for this workflow run.
 │    Outputs `worktree_path`, `branch_name`, `workspace_id` into
 │    workflow state. All downstream coding, testing, validation,
 │    and review work happens inside `worktree_path` — nothing ever
 │    touches the main clone. Branch name derived from the PRD title
 │    + execution ID (e.g. `allen/bookmark-workflows-abc123`).
 │    Same built-in the existing coding-workflow.yml uses.
 │
 ├─▶ develop
 │    (agent: developer, NEW — orchestrator-only, writes no code)
 │    Takes the approved implementation plan from state and drives
 │    it to completion by spawning specialist agents via the
 │    `spawn_agent` tool. The workflow engine sees ONE node here,
 │    but the `develop` node internally spawns many agents in
 │    parallel (or sequentially when files conflict). See §3.5d for
 │    the full developer contract.
 │
 │    Why one orchestrator instead of fixed backend/frontend nodes:
 │      - the set of relevant specialists is determined by the plan,
 │        not by the workflow YAML. A plan might need backend +
 │        frontend + devops-engineer + security-specialist, or just
 │        one, or a specialist we haven't thought of yet.
 │      - parallelism is dynamic: the orchestrator groups files by
 │        specialist, detects file conflicts, and decides at runtime
 │        which groups can run in parallel and which must be
 │        serialized.
 │      - adding a new specialist (e.g. `db-migrator`) doesn't
 │        require touching workflow YAML — the orchestrator picks it
 │        up automatically if the plan assigns files to it.
 │
 ├─▶ write_tests
 │    (agent: test-writer)
 │    Writes tests against the PRD's acceptance criteria. Tags each test
 │    with @regression, @unit, @integration, or @acceptance so downstream
 │    nodes can filter. Build+lint check before returning.
 │
 ├─▶ qa_coverage_review
 │    (agent: qa-lead)
 │    Reads PRD acceptance_criteria[] and the test files. For each
 │    criterion, confirms there's at least one test covering it.
 │    Outputs: coverage_gaps[], wrong_tests[], fixable_by_qa[],
 │    needs_test_writer[]. If fixable_by_qa non-empty, qa-lead writes
 │    the fix directly. If needs_test_writer non-empty, loops back to
 │    test-writer with specific feedback. Max 2 loops.
 │
 ├─▶ run_tests
 │    (code node)
 │    Executes the test commands from the implementation plan. Respects
 │    skip_regression input flag — if true, @regression tests are listed
 │    but not executed and pass automatically. Other tags always run.
 │    Build / compile / lint errors mean this node fails fast.
 │
 ├─▶ [condition] run_tests.passed?
 │     false → qa_failure_triage (agent: qa-lead)
 │             Decides: self-fix, delegate back to the right coding agent,
 │             or escalate to human. Max 3 loops total.
 │
 ├─▶ implementation_validator
 │    (agent: implementation-validator, NEW)
 │    Reads: diff of all changes + PRD + HLA + TDD.
 │    For every TDD contract (API endpoint, data model field, error code),
 │    confirms the implementation actually produces it. For every PRD
 │    acceptance criterion, confirms the diff satisfies it.
 │    Outputs: { matches: bool, violations: [{file, line?, severity, rule}],
 │               severity: none|minor|major|critical }
 │    Conditions:
 │     severity ∈ {major, critical} → loop back to plan_implementation
 │       with violations as feedback. Max 3 loops.
 │     severity = minor → continue, note in PR description.
 │     severity = none → continue.
 │
 ├─▶ update_docs
 │    (agent: documentation-writer, existing, with extended prompt)
 │    Reads: full diff of changes, design docs (PRD + HLA + TDD),
 │    and the repo's existing documentation structure (discovered via
 │    get_repo_context). For every module whose behavior is changing,
 │    locates the doc files that describe it and updates them to
 │    match the new behavior. Handles: module READMEs, top-level
 │    README, docs/ folders, API references, OpenAPI specs, inline
 │    docstrings, architecture docs. New APIs → new doc sections.
 │    Behavior changes → revised sections. Removed features →
 │    deletions. Runs the repo's markdown/doc linter if one is
 │    configured. Build+lint discipline (§3.7).
 │    Why before code_review: the reviewer checks code AND docs
 │    together and flags drift between them as a blocking issue.
 │
 ├─▶ code_review
 │    (agent: code-reviewer, existing, with expanded prompt)
 │    Reviews the full diff INCLUDING doc changes from update_docs.
 │    MUST include security checks: input validation, authn/authz,
 │    secrets, injection classes (SQL/XSS/SSRF), IDOR, rate limiting,
 │    data exposure, dependency risks. Also flags doc-code drift —
 │    if the code changed but the docs don't match, blocks the PR
 │    until update_docs is re-run. Plus standard correctness/style/
 │    test-quality review. Outputs: ok bool + blocking_issues[].
 │    Blocking issues → loop back to the relevant coding agent.
 │
 ├─▶ open_pr
 │    (code node)
 │    Creates the PR via gh CLI. Title from PRD title. Body includes:
 │    link to all three design docs, acceptance-criteria checklist,
 │    validator verdict, code-review summary, test coverage summary,
 │    how-to-test steps, any minor validator deviations.
 │
 ├─▶ summary
 │    (agent: documentation-writer, with a summary prompt)
 │    Required terminal node. Reads: PR URL, diff stats, validator
 │    verdict, code-review output, test results, acceptance-criteria
 │    coverage, branch name, worktree path. Produces a structured
 │    implementation summary containing:
 │      - one-paragraph narrative of what was built
 │      - mapping: acceptance criteria → tests → files (proves each
 │        PRD requirement has a trace through to a test and code)
 │      - list of files changed with bullet-per-file rationale
 │      - any minor validator deviations + rationale
 │      - any skipped regression tests and why
 │      - deploy / rollout notes if TDD called them out
 │      - follow-ups and known gaps
 │    Posts the summary to the chat session that started the workflow
 │    and also uploads it as a public .md link via /api/files so it
 │    can be shared (Slack / email / ticket comments).
 │
 ▼
end
  outputs: plan_doc_url, pr_url, validator_verdict, summary_text,
           summary_url, branch_name, worktree_path
```

### 3.2 Node count

~19 nodes after collapsing the static `[parallel] implement_backend +
implement_frontend` branches into a single `develop` orchestrator node
(§3.5d). The parallelism now happens INSIDE the `develop` node at
runtime via `spawn_agent`, not at the workflow DAG level. The workflow
engine sees one node; the user sees many spawns in the execution
sidebar.

Node breakdown: clarify → produce_prd → audit_prd → produce_hla →
audit_hla → produce_tdd → audit_tdd → persist_docs → plan_approval_gate
→ plan_implementation → create_branch → **develop** → write_tests →
qa_coverage_review → run_tests → qa_failure_triage (conditional) →
implementation_validator → update_docs → code_review → open_pr →
summary. Some are conditional (qa_failure_triage only runs on
failure) so "19" is the cap, not the floor.

### 3.3 Why three separate doc producers instead of one planner

My earlier plan proposed one `solution-planner` agent producing all three
sections in one response. That's cheaper and more self-consistent. But the
user explicitly asked for "PRD + Architecture Design + Technical Design all
reviewed by agents first against the user requirement after clarification
question." Three separate artifacts, three separate reviews.

**Three specialists wins when:**

1. **Each doc is reviewed in isolation against the user requirement** —
   exactly what was asked. If the PRD drifts from the user's intent, the
   audit step catches it BEFORE a bad HLA is built on top of it. One-agent
   plans can't do this granular audit because the three views are
   entangled in one context.
2. **Retries are surgical.** If the HLA is wrong but the PRD is fine, we
   re-run only the architect. A one-planner retry re-runs the entire plan.
3. **Specialization matters on complex features.** Solution-architect and
   technical-designer have different prompts, different reasoning modes
   (HLA is more tradeoff-heavy, TDD is more contract-heavy). Forcing one
   agent to do both produces mediocre versions of both.

**Three specialists costs us:**

1. More agents to seed (three new specialist prompts).
2. More model calls per design run (3–6 extra).
3. Need for a cross-doc auditor (`doc-auditor`) to ensure the three docs
   agree with each other and the user ask.

The user-stated requirement directly prescribes the three-doc shape, so we
build the three-doc shape.

### 3.4 The `doc-auditor` agent

New, single-purpose agent. Separate from the doc producers so it can judge
without bias. Reviews one doc at a time against:

- The original user_request (always)
- Preceding docs (HLA is audited against PRD; TDD against PRD and HLA)

Outputs one of three structured verdicts:

| Verdict | Meaning | Workflow action |
|---|---|---|
| `approve` | Doc satisfies the user ask and is internally consistent | Advance |
| `revise` | Fixable mismatch or gap | Loop back to the producer with a feedback block, max 2 loops per doc |
| `escalate` | Unrecoverable mismatch, or 2 revises exhausted | Pause at a human node with the specific failures |

The doc-auditor does NOT do deep technical review — that's not its job.
It checks coverage ("does the PRD cover every story the user mentioned?"),
consistency ("does the HLA's data flow match the PRD's non-functional
requirements?"), and faithfulness ("does the TDD implement what the HLA
proposed?"). Correctness of APIs and schemas is not its concern — that's
what the implementation validator catches later.

**Why a separate auditor and not the producer re-reading its own work:**
self-review is unreliable. A different agent reading the same input has a
meaningfully higher chance of spotting drift. Cost: one extra model call per
doc. Worth it.

### 3.5 The `implementation-validator` agent

New. Runs after tests pass. Its job is to catch the case where the code
compiled, the tests passed, and the change still fails to satisfy the
**actual user requirement** — regardless of whether the TDD was
followed exactly.

**Key principle: the PRD is the source of truth, not the TDD.** The
HLA and TDD are a *plan* for satisfying the PRD. The validator's job
is to verify the requirement, not the plan. If the implementation
takes a different technical path than the TDD prescribed but still
satisfies every PRD acceptance criterion and respects the PRD's
scope and non-functional constraints, that is **not a violation** —
it's a legitimate deviation that the validator notes but does not
block on.

Inputs:
- Full diff of changes in the workflow.
- PRD, HLA, TDD (as text).
- Implementation plan produced by engineering-lead.

**Blocking checks** (escalate if any fails, these are PRD-breaking):

1. **Every PRD acceptance criterion** has a code path in the diff OR a
   test that demonstrates it. No AC left behind.
2. **Every PRD edge case** has explicit handling in the diff.
3. **Every PRD out-of-scope item** is NOT implemented (no scope creep
   into forbidden territory).
4. **PRD non-functional requirements** are met — performance targets,
   security requirements (authn/authz, rate limits if specified in
   PRD), accessibility requirements, data-handling rules.
5. **PRD-derived HLA risk mitigations** are present. If the HLA
   elevated a PRD non-functional requirement into a specific mitigation
   (e.g., "add rate limit to bookmark endpoint"), that mitigation must
   be in the diff.

**Informational checks** (note in the Summary node's deviation report
but do NOT block, do NOT loop):

1. **TDD API contract adherence** — path, HTTP verb, exact request/
   response shape, error codes. Deviations noted but not escalated
   unless they break a PRD acceptance criterion (e.g., if the PRD says
   "the API must return the bookmark count" and the implementation
   doesn't return a count, that's a blocking violation of the PRD, not
   just a TDD contract mismatch).
2. **TDD data model adherence** — table names, field names, indexes.
   The storage shape can differ from the TDD as long as the PRD is
   still satisfied.
3. **HLA tradeoff choices** — technology selections, component
   boundaries, data flow patterns. The implementation can pick a
   different approach as long as the outcome matches the PRD.

Output:

```json
{
  "prd_satisfied": true | false,
  "blocking_violations": [
    {
      "rule": "missing_acceptance_criterion" | "scope_creep"
            | "nfr_violation" | "missing_risk_mitigation"
            | "missing_edge_case",
      "prd_reference": "AC-3" | "edge-case-7" | "nfr-security-2",
      "file": "...",
      "line": 123,
      "description": "...",
      "suggested_fix": "..."
    }
  ],
  "informational_deviations": [
    {
      "rule": "api_contract_drift" | "schema_drift" | "tech_choice_drift",
      "tdd_reference": "api-bookmark-post" | "model-workflow-bookmark",
      "file": "...",
      "description": "TDD said X, implementation does Y, PRD still satisfied.",
      "impact": "low" | "medium"
    }
  ],
  "confidence": 0.0-1.0
}
```

**Verdict semantics:**

- `prd_satisfied: true` with no blocking violations → advance. Any
  informational deviations are passed into the Summary node's
  deviation report so the human reviewer sees them, but the workflow
  does not loop.
- `prd_satisfied: false` with blocking violations → loop back to
  `plan_implementation` with the blocking-violations list as feedback.
  Informational deviations from the same run are also included so the
  re-plan is aware of what paths the implementation took.
- **Max 2 retry loops** before escalation. After 2 failed loops, the
  workflow pauses at a human node (HIP severity: 🔴 ESCALATION) with
  the full blocking-violations history from all 3 attempts.

**Loop-back target:** back to `plan_implementation`, not directly to
the coding agents. Engineering-lead re-reads the blocking violations,
decides whether the fix is backend, frontend, both, or something
deeper, and re-delegates. This prevents ping-ponging the same bad fix
between backend-developer and frontend-developer.

**Why 2 loops instead of 3:** in practice, agent retry convergence
follows a 0-or-1 pattern — loops either fix the issue immediately or
never fix it. Paying for a third loop when loops 1 and 2 both failed
is burning tokens on diminishing returns. Escalate earlier, let a
human untangle faster.

**Why the PRD-first rubric:** the user explicitly said that a small
deviation from the design that still matches the requirement should
NOT be a block. The validator exists to protect the requirement, not
to enforce design conformance. Design conformance is the kind of thing
that matters for the first draft but ossifies the implementation if
it's treated as a hard constraint — a good implementation often
discovers better paths than the up-front design anticipated, and
blocking those discoveries costs quality.

**Informational deviations in the Summary:** the Summary node reads
`informational_deviations` from validator state and includes a
"Design deviations" section in the implementation summary, listing
each deviation with its rationale. The PR body also includes this
section so reviewers see it. If a deviation is surprising or wrong,
the human reviewer catches it at PR review time — but the workflow
doesn't gate on it.

### 3.5b Test-writer contract

The `test-writer` agent's system prompt enforces a six-rule contract.
This is load-bearing for the QA pipeline in §3.6 — the test-writer is
expected to produce tests AND drive them to a green or
gracefully-skipped state before handing off to `qa_coverage_review`.

**Rule 1 — Write tests against the PRD's acceptance criteria.** Use the
repo's existing test framework (discovered via `get_repo_context`). If
no framework exists at all, emit a single top-level `no-test-setup`
skip entry explaining what the repo would need — do not fail the node.
The validator downstream still runs and catches untested code paths.

**Rule 2 — Auto-recover from internal dependency gaps.** A test that
fails because of a missing dev dependency that BELONGS in the repo's
manifest is the test-writer's responsibility to fix:

1. Identify the missing package (stack trace, module-not-found error).
2. Determine the right manifest file (`package.json` / `requirements.txt`
   / `go.mod` / `Cargo.toml` / `Gemfile` / etc.).
3. Add the package with a reasonable version pin, following the repo's
   existing style.
4. Run the repo's install command (`npm install`, `pip install -r`,
   `go mod tidy`, `cargo fetch`, `bundle install`).
5. Retry the failing setup step.
6. Max 2 auto-recovery cycles per test-writer run. After that, the
   agent reports the remaining gaps in its response and moves on.

**Internal = fixable by editing a manifest file.** Examples:
- Test framework itself (vitest, pytest, go test, etc.)
- Assertion libraries, mocks, fixtures
- Test-only dev tooling (ts-node, babel plugins, coverage tools)
- Missing peer deps surfaced by the install command

**Rule 3 — Graceful skip on external dependency gaps.** A test that
fails because of a dependency the test-writer cannot install by
editing a manifest is marked skipped with a structured reason. The
node does NOT fail. Example external dependencies:

- Running services (Postgres, Redis, Elasticsearch, a Docker daemon)
- System binaries (ImageMagick, Graphviz, ffmpeg, any apt/brew package)
- Cloud credentials (AWS keys, GCP service account, specific API tokens)
- A live external API the tests need to hit
- Specific OS-level kernel features or permissions

For each skipped test, the test-writer emits:

```json
{
  "test_id": "bookmarks.spec.ts::persists to DB",
  "reason": "external-dep-missing",
  "what_is_missing": "Postgres running on localhost:5432",
  "how_to_set_up": "Add `postgres` service to docker-compose.yml...",
  "covered_acceptance_criteria": ["AC-3", "AC-7"],
  "severity": "advisory" | "warning"
}
```

`severity: warning` is used when the skipped test would have covered a
critical acceptance criterion — it's still not a hard failure, but the
Summary node surfaces it prominently and the PR body includes a
"Manual verification required" section.

**Rule 4 — Verify the new tests you wrote.** Every new test the
test-writer produces must actually run and pass before the agent
returns. A new test that fails is a real failure — either fix the code
the test exposes (delegate back to the coding agent) or fix the test
(if the test is wrong). A new test cannot be marked skipped unless it's
failing purely due to Rule 3's external dependency case.

**Rule 5 — Run the existing regression suite.** After the new tests
pass, run the repo's full existing test suite to confirm the change
didn't break anything unrelated. Behavior depends on the workflow
input `skip_regression`:

- `skip_regression: false` (default): run the full regression suite.
  Any failure → return as a failure, qa_failure_triage decides the
  next step.
- `skip_regression: true`: list the regression tests (use the
  framework's `--list-tests` / `--collect-only` mode) but don't run
  them. Emit a single `skipped-regression-policy` entry per regression
  test file with the count of tests skipped. Gate passes.

**Rule 6 — Build + lint before returning.** Same discipline as every
other coding agent (§3.7). Run the repo's build and lint commands. If
either fails in files the test-writer touched, the test-writer MUST
fix the errors before returning. If the failure is in untouched code,
include the full output in the response and explain.

**Node output** — `run_tests` emits one of three states:

| State | Meaning | Gate action |
|---|---|---|
| `pass` | All new tests passed, regression passed (or skipped by policy) | Advance |
| `partial_pass_with_skips` | New tests passed, but some tests were skipped per Rule 3 | Advance with a `skip_report` attached to state for the Summary node |
| `fail` | A new test failed for non-external-dep reasons, OR regression failed, OR build/lint failed | Loop to `qa_failure_triage` |

The validator downstream (`implementation-validator`) is the safety
net for partial-pass runs: it cross-checks the diff against the PRD
even when some tests couldn't run. Skipped tests + clean validator
verdict = advance with loud summary note. Skipped tests + unclean
validator = escalation.

### 3.5c Documentation-writer contract

The existing `documentation-writer` agent gains a new responsibility:
keep in-repo tech docs in sync with code changes. Same agent, extended
prompt.

**Rule 1 — Discover the docs.** Read `get_repo_context` to find the
repo's doc structure. Look for:

- Top-level `README.md`
- Per-module / per-package `README.md` files
- `docs/` or `doc/` folder — any `.md` / `.mdx` / `.rst` / `.txt` files
- `docs/api/`, `docs/architecture/`, `docs/reference/`, `docs/guides/`
- OpenAPI / AsyncAPI / GraphQL schema files
- JSDoc / Sphinx / Godoc / Rustdoc inline docs within source files

**Rule 2 — Match docs to changed modules.** For each file in the diff,
determine which docs describe that module or feature:

- A changed file at `packages/server/src/services/workflow.service.ts`
  → look at `packages/server/README.md`, `docs/services/workflows.md`,
  any OpenAPI spec that mentions `WorkflowService`, the inline JSDoc
  on changed methods.
- A changed file at `packages/ui/src/pages/WorkflowListPage.tsx` →
  look at user-facing docs in `docs/user-guide/`, any screenshots or
  feature descriptions that mention the workflow list.

**Rule 3 — Update to match reality.**
- **Behavior changes** → revise the sections that describe the old
  behavior. Remove claims that are no longer true.
- **New APIs / endpoints / CLI commands** → add new sections following
  the repo's existing doc style.
- **Removed features** → delete the corresponding doc sections.
- **Deprecated features** → add a "Deprecated" note with the removal
  timeline if the PR's description says so.

**Rule 4 — Match the existing doc style.** Don't introduce a new
heading convention, a new table format, or a new code-block style.
Mimic the surrounding docs. If the repo's docs use `##` for sections
and the agent adds `###`, the reviewer flags it.

**Rule 5 — Do not invent documentation that doesn't exist.** If a
module has NO existing doc file, the agent does NOT create one
speculatively. The PRD / HLA / TDD artifacts serve as the canonical
source for design-level documentation; in-repo docs should only be
updated where they already exist.

**Rule 6 — Handle repos with no docs at all.** If `get_repo_context`
reveals no documentation structure whatsoever (no README, no docs/),
the node no-ops with a logged explanation. This is not a failure.
The PR description generated later will carry the behavior-change
summary for the reviewer to see.

**Rule 7 — Doc linter and build discipline.** If the repo has a doc
linter (markdownlint, vale, textlint, etc.), run it on the updated
files and fix any errors. Same build+lint discipline as every other
coding agent (§3.7).

**Why update_docs runs before code_review:** the reviewer checks
code and docs together. If code changes but docs don't, that's drift
and the reviewer flags it as a blocking issue. Reviewing them in one
pass catches drift at the cheapest point.

**Why update_docs runs AFTER implementation_validator:** the validator
catches "the code doesn't match the design." Docs update catches "the
docs don't match the code." Running validator first means we don't
waste doc-update effort on a diff that's about to be looped back for
re-implementation.

### 3.5d The `developer` orchestrator contract

The new `developer` agent is an orchestrator — it never writes code
itself. Its job is to take an approved implementation plan and drive
it to completion by spawning specialist agents via the `spawn_agent`
tool. It lives in the `engineering` team as a member alongside the
specialists it delegates to.

**Why one orchestrator instead of fixed backend/frontend nodes:**

1. **Dynamic specialist selection.** The set of relevant specialists
   depends on the plan, not the workflow YAML. A plan might need
   backend + frontend + devops-engineer + security-specialist, or
   just backend, or frontend + documentation-writer, or a specialist
   we haven't hired yet. The orchestrator decides at runtime.
2. **Dynamic parallelism.** The workflow engine's static
   `[parallel]` nodes assume you know ahead of time which branches
   exist. The orchestrator groups files by specialist AT RUNTIME,
   detects file conflicts, and picks the parallelism shape
   accordingly.
3. **Extensibility without YAML changes.** Adding a new specialist
   (e.g. `db-migrator`, `cli-tool-developer`, `graphql-schema-designer`)
   means seeding one new agent and giving the orchestrator permission
   to delegate to it. No workflow edit required.

**Agent definition:**

```yaml
name: developer
displayName: Developer Orchestrator
teamName: engineering
teamRole: member
type: team        # orchestrator-style, delegates instead of writing code
provider: claude-cli
model: sonnet
reasoningEffort: high
planMode: false
tools: []         # relies on spawn_agent (from Allen MCP) + delegate_to_agent
capabilities:
  - orchestration
  - parallel-coordination
  - file-conflict-detection
  - specialist-selection
canDelegateTo:
  - backend-developer
  - frontend-developer
  - devops-engineer
  - security-specialist
  - documentation-writer
  - codebase-navigator
  # add more as new specialists are seeded
```

**System prompt — the six-rule contract:**

**Rule 1 — READ THE PLAN.** The approved implementation plan in
`state.implementation_plan` (feature workflow) or
`state.investigate_output.files_to_touch` (bug workflow) lists every
file that needs to change, what the change is, and which
requirement/root-cause it satisfies. Read it carefully.

**Rule 2 — GROUP BY SPECIALIST.** For each file in the plan, decide
which specialist should own it. Use these signals, in order:

1. The plan's explicit `specialist` hint per file if engineering-lead
   provided one (preferred — trust the planner).
2. File-path heuristic:
   - `packages/server/**`, `**/api/**`, `**/routes/**`, `**/services/**`
     (non-UI), `*.py`, `*.go`, `*.rs`, `*.java` → `backend-developer`
   - `packages/ui/**`, `**/client/**`, `**/frontend/**`, `*.tsx`,
     `*.jsx`, `*.css`, `*.scss`, `*.html`, `*.vue` → `frontend-developer`
   - `*.tf`, `**/terraform/**`, `**/ansible/**`, `Dockerfile`,
     `docker-compose.*`, `*.yaml` in `**/k8s/**` or `**/helm/**`,
     CI config (`.github/workflows/*`, `.gitlab-ci.yml`,
     `bitbucket-pipelines.yml`) → `devops-engineer`
   - Anything touching auth, secrets, crypto, user input validation,
     session handling → `security-specialist` (in addition to the
     primary specialist, for review coordination)
   - Docs (covered by `update_docs` node later, not here)
3. **When in doubt, ask the codebase-navigator via delegate_to_agent.**
   It knows the repo's own conventions.

**Rule 3 — DETECT FILE CONFLICTS.** After grouping, check if any two
specialists would touch the same file. Conflicts are where more than
one specialist has the same file in their file list.

- **Non-overlapping groups → parallel-safe.** Can be spawned
  simultaneously via `spawn_agent`.
- **Overlapping groups → must be serialized** in dependency order.
  Pick the specialist whose changes form the foundation (usually the
  backend-developer when schema or API shape is changing), run them
  first, wait for completion, then spawn the next specialist with
  the updated file state.

**Rule 4 — SPAWN IN PARALLEL BATCHES.** For each batch of
non-conflicting specialists:

1. Call `spawn_agent(agent_name, task, repo_path=<worktree_path>)` for
   each specialist in the batch. Do NOT wait between spawns — fire
   them all, collect the execution IDs.
2. Construct each specialist's task prompt from the subset of the
   plan that belongs to them, including:
   - The specific files they own
   - The requirement / acceptance criterion each file satisfies
   - Any dependencies on other specialists' work (e.g., "the backend
     is providing an API at /api/bookmarks, your frontend code will
     consume it")
   - The worktree path as explicit context
3. Wait for ALL spawns in the batch to return via `get_execution`
   (long-poll). Do not advance to the next batch until every spawn in
   the current batch has finished.

**Rule 5 — SEQUENTIAL WHEN CONFLICTED.** For specialists that cannot
run in parallel due to file conflicts:

1. Pick the dependency-first order (backend before frontend if the
   frontend consumes a new API; schema change before backend if
   backend queries new fields).
2. Spawn the first specialist, wait for it to finish, check the
   result.
3. If the first specialist failed, do NOT proceed — return failure.
4. If the first specialist succeeded, spawn the next one with a
   prompt that references the completed previous work.
5. Repeat until all serialized specialists are done.

**Rule 6 — COLLECT AND VALIDATE.** After every batch completes:

1. Check each spawn's result status. On any failure, retry that
   specialist ONCE with the error output as additional context. If
   still failing, stop and return failure up the workflow.
2. Aggregate the list of all files touched across all specialists.
   This goes into `state.developer_output.files_changed` for
   downstream nodes (write_tests, validator, update_docs) to read.
3. Verify that no spawned specialist produced a build or lint error
   in their files (the specialists validate their own — rule §3.7 —
   but the orchestrator double-checks by reading the spawn's return
   summary).
4. Return a structured summary to the workflow state:

```json
{
  "specialists_used": ["backend-developer", "frontend-developer"],
  "batches": [
    { "mode": "parallel", "agents": ["backend-developer", "frontend-developer"], "files": 8 }
  ],
  "files_changed": ["packages/server/src/...", "packages/ui/src/..."],
  "any_failures": false,
  "failure_details": []
}
```

**Hard rules for the developer orchestrator:**

- **NEVER write code directly.** The orchestrator has no filesystem
  tools and should not produce file edits. It delegates everything.
- **NEVER skip file-conflict detection.** Parallelizing specialists
  that touch the same file will corrupt the worktree.
- **ALWAYS pass repo_path = {{worktree_path}}** to every spawn_agent
  call — the specialists must run inside the isolated worktree
  created by `create_branch`, not the main clone.
- **ALWAYS include the relevant plan slice** in each specialist's task
  prompt. A specialist should know which files it's responsible for,
  what requirement each file satisfies, and which other specialists
  are working in parallel on related files.
- **FAIL FAST on spawn failures.** If a specialist returns an error
  that isn't recoverable by a single retry, the developer returns
  failure immediately — the workflow's validator and qa_failure_triage
  nodes handle the loop-back.

**What the specialist agents still do (unchanged):**

- `backend-developer`, `frontend-developer`, `devops-engineer` — same
  system prompts as today, just now invoked via spawn_agent instead
  of directly by the workflow.
- Each specialist still validates build + lint on its own changes
  before returning (§3.7).
- Each specialist still runs inside the worktree passed via repo_path.

**The existing `canDelegateTo` lists on the specialists** stay — they
can still delegate to each other if needed (e.g., backend-developer
asking codebase-navigator for a quick repo question). The orchestrator
is just the *primary* caller for the main implementation work.

### 3.6 The QA pipeline (`qa_coverage_review` + `run_tests` + `qa_failure_triage`)

Three pieces, because the user asked for three distinct things:

1. **Review test cases against the PRD's acceptance criteria.** The test
   writer could produce tests that run fine but cover the wrong thing.
   `qa_coverage_review` walks the acceptance criteria and for each one,
   confirms there is a test that would fail if that criterion broke. If
   not, it tags the gap. The gap is either fixable by qa-lead directly
   (simple cases — add a test that exercises an already-working code path)
   or needs to go back to test-writer (complex cases — the tested code
   behaves wrong for that criterion and tests have to drive the fix).
2. **Run tests with regression-skip.** The user explicitly said regression
   tests can be slow and should be skippable. Implementation: tests tagged
   `@regression` (in the test file or a separate manifest the test-writer
   emits) are listed-but-not-executed when `skip_regression=true` is set
   on the workflow input. The node records them as "skipped (regression)"
   which passes the gate. Non-regression tests always run.
3. **Fix-or-delegate on failure.** When `run_tests` reports failures,
   `qa_failure_triage` (qa-lead again, different prompt) decides: can I
   fix this myself (build error, lint error, trivial test fix)? Or does
   it need to go back to the relevant coding agent (real logic bug)? Fix
   in place, or delegate back. Max 3 triage loops.

**Regression tag**: test-writer tags each test it emits. Agents don't have
to invent a tagging syntax — we pick one conventional pattern per test
framework (Vitest: `describe.skip` with a `.regression` suffix; pytest:
`@pytest.mark.regression`; Go: build tag `//go:build regression`). The
test-writer's prompt spells out the convention for the target repo's
framework, read from `get_repo_context`.

### 3.7 Every coding agent validates build + lint

Not a separate node — a hard rule in the system prompt of every coding
agent (backend-developer, frontend-developer, test-writer, bug-fixer, and
the qa-lead when it's fixing things). The rule:

> Before reporting completion, you MUST run the repo's build and lint
> commands (discovered from `get_repo_context`). If either fails, you MUST
> fix the errors before returning. If you genuinely cannot fix them (e.g.,
> the error is in code you didn't touch), include the full error output in
> your response and explain what you tried. Never silently ignore a build
> or lint error.

**Why in the prompt and not a workflow node:** each agent already has
filesystem + terminal access. Running `npm run build && npm run lint` is
two Bash calls inside the same session. A separate workflow node would
spawn a new agent with no context and re-read the diff — expensive and
redundant. Prompt-level enforcement is sufficient as long as we also keep
a trailing `run_tests` node that would catch a silent violation.

### 3.8 Code review always includes security

`code-reviewer`'s existing prompt gets a structured security section. New
checklist (condensed here; full version in the prompt):

- **Input validation** — user-supplied data reaches a handler without
  validation or normalisation?
- **Authentication & authorisation** — new endpoints: who can call them?
  Is the check correct? Is role inheritance respected?
- **Injection classes** — SQL, NoSQL, command injection, XSS in any new
  user-rendered content, SSRF in any new outbound fetch.
- **IDOR / broken object level authorisation** — handler looks up a
  resource by an ID from the request without checking ownership.
- **Secrets** — no hardcoded credentials, API keys, tokens.
- **Rate limiting** — new endpoints that accept user input and do
  expensive or externally-visible work should have rate limits.
- **Dependency risk** — new deps added to package.json / requirements.txt
  / go.mod — any known CVEs? Any that look like typosquats?
- **Data exposure** — responses that newly include user data — should
  they be filtered by role?
- **Error messages** — do they leak stack traces, DB internals, user
  emails, or path structure?

The review's output shape gets a new field: `security_findings[]`. A
non-empty array with severity `major` or `critical` blocks the PR.

**Why in code-reviewer and not a separate security-specialist node:**
a separate specialist adds another agent round trip (~30s and a model
call). The security-specialist agent still exists for cases where the
planner wants deep threat modelling, but the default review path uses one
agent with a broader checklist. Cheaper and faster. We can upgrade to a
two-stage review later if the combined review proves shallow.

## 4. The bug fix workflow: `bug-investigate-and-fix`

Deliberately minimal. No design docs, no planning, no validator, no QA
loop against acceptance criteria (there are none). The heavy machinery of
the feature workflow is overkill for "this button crashes when X."

### 4.1 Pipeline shape

```
start
 │
 │ inputs: bug_report (string), repo_path (string), related_pr (optional string)
 ▼
 ├─▶ investigate
 │    (agent: bug-investigator, NEW)
 │    Reads the bug report. Calls get_repo_context + Glob + Read + Grep.
 │    Reproduces the symptom if possible (Bash). Traces to the root
 │    cause. Outputs:
 │      { root_cause: string, files_to_touch: [...], confidence: 0-1,
 │        scope: S|M|L|XL, fix_description: string,
 │        looks_like_a_feature: bool }
 │
 ├─▶ [condition] investigate.looks_like_a_feature?
 │     true → escalate_to_feature_workflow node
 │            (human decision point: "this isn't a bug, it's a design
 │             change — start the feature workflow?")
 │     false → continue
 │
 ├─▶ create_branch
 │    (code node, function: create-workspace — EXISTING built-in)
 │    Creates a git worktree + new branch for the bug fix. Branch
 │    name derived from the root cause + execution ID
 │    (e.g. `allen/null-deref-webhook-xyz456`). All fix, test, review
 │    work happens in `worktree_path`. Same built-in the feature
 │    workflow and the existing coding-workflow use — zero new code.
 │
 ├─▶ develop
 │    (agent: developer, same orchestrator used by the feature
 │    workflow — see §3.5d)
 │    Receives the bug-investigator's `files_to_touch` list and the
 │    fix description. Spawns the right specialist(s) via spawn_agent.
 │    For most bugs the plan touches a single subsystem and the
 │    orchestrator spawns one specialist; for cross-cutting bugs it
 │    spawns multiple in parallel with file conflict detection.
 │    Same developer contract (§3.5d) as the feature workflow.
 │
 ├─▶ add_regression_test
 │    (agent: test-writer)
 │    Writes a test that would fail without the fix. No PRD to check
 │    against — the test exists to prove the fix is correct AND to
 │    prevent regression. Tagged @unit or @integration appropriately.
 │    NOT tagged @regression (that's for pre-existing slow tests).
 │    Build + lint discipline.
 │
 ├─▶ run_tests
 │    (code node)
 │    Runs the full test suite (no skip_regression flag in this workflow —
 │    bug fixes are high-risk for regressions, we always run everything).
 │    Fails fast on test failure.
 │
 ├─▶ update_docs
 │    (agent: documentation-writer, same prompt and behavior as §3.5c)
 │    Updates the in-repo tech docs for the module(s) touched by the
 │    fix. For bug fixes the update is usually smaller than for a
 │    feature — typically a correction to a behavior description or
 │    a note about a previously-undocumented edge case. If no docs
 │    describe the affected module, the node no-ops (not a failure).
 │
 ├─▶ code_review
 │    (agent: code-reviewer, same expanded prompt as feature workflow
 │     including security section AND doc-code drift check)
 │
 ├─▶ open_pr
 │    (code node)
 │    PR title: "fix: <short root cause>". Body includes: bug report,
 │    root cause summary, the regression test added, code review
 │    summary, how-to-verify steps.
 │
 ├─▶ summary
 │    (agent: documentation-writer)
 │    Required terminal node. Reads: bug report, root cause,
 │    files touched, regression test file, PR URL, code-review output.
 │    Produces a short implementation summary:
 │      - the bug (one-line)
 │      - the root cause (one paragraph)
 │      - the fix (one paragraph, with file-by-file bullets)
 │      - the regression test added and what it asserts
 │      - security considerations from the code review
 │      - how to verify manually
 │    Posts to the chat session that started the workflow AND uploads
 │    as a public .md link for sharing. Same mechanism as the feature
 │    workflow's summary node.
 │
 ▼
end
  outputs: pr_url, root_cause, regression_test_file,
           branch_name, worktree_path, summary_url
```

### 4.2 Node count

10 nodes (8 from the original sketch + `create_branch` + `update_docs`).
Roughly half the feature workflow.

### 4.3 The `bug-investigator` agent

New. System prompt emphasises:

1. **Reproduce first, diagnose second.** If the bug report comes with
   reproduction steps, the investigator runs them (via Bash + curl +
   whatever tools are needed) to confirm the symptom. If repro steps are
   missing and can't be inferred, investigator asks via `ask_user`.
2. **Walk the call stack, don't guess.** Use Grep and Read to trace from
   symptom back to source. State the causal chain in the output.
3. **Distinguish bug from design gap.** If the root cause is "the feature
   was never specified to handle this case," that's a feature request
   masquerading as a bug. Output `looks_like_a_feature: true` and let the
   workflow escalate.
4. **Identify minimal fix.** The fix should change the smallest amount of
   code needed to correct the symptom. Explicitly NOT "while we're here,
   let me also clean up this unrelated thing."

Output JSON is consumed by the fix node's condition logic (backend vs
frontend vs both) and by the PR body template.

### 4.4 "Update the document" — TBD

The original requirement said "fix and review and update the document and
raise pr." It's unclear which document. Three possible interpretations:

1. **CHANGELOG / release notes** — the fix is recorded. Easy, just a file
   edit the fix node does.
2. **Bug ticket (Linear / GitHub issue / Slack thread)** — the external
   tracker gets a comment with the PR link. Needs the bug-report source to
   be known so we know where to comment.
3. **API docs / user docs** — only applies if the bug fix changes observable
   behaviour in a way docs describe.

Flagged as an open question — see §9.

## 5. New / changed agents

### 5.1 New agents

**No new team.** Agents slot into existing teams based on where they
functionally belong, per your directive. `requirements-analyst` already
lives in the `product` team and stays there — we don't move it.

| Agent | Team | Role | Purpose | Why this team |
|---|---|---|---|---|
| `solution-architect` | `engineering` | member | Produces the HLA section. Opus + high effort + planMode. | Architecture is an engineering concern; sits under engineering-lead's delegation. |
| `technical-designer` | `engineering` | member | Produces the TDD section. Opus + high effort. | Same rationale — technical design is owned by engineering. |
| `developer` | `engineering` | member | Orchestrator-only. Takes an approved implementation plan and drives it to completion by spawning specialist agents via spawn_agent. Detects file conflicts, parallelizes non-conflicting work, serializes conflicting work. Never writes code directly. Sonnet + high effort. Full contract in §3.5d. | It is the single entry point for code execution in both workflows — replaces the old static `implement_backend` + `implement_frontend` parallel branches with runtime specialist selection. Lives in engineering alongside the specialists it delegates to. |
| `bug-investigator` | `engineering` | member | Root-cause analysis. Opus + high effort (hard reasoning work). | Investigation is an engineering skill. |
| `doc-auditor` | `product` | member | Reviews each design doc against the user request. Not a doc producer — a judge. Sonnet + high effort. | It audits for fidelity to the user's intent, which is a product-side concern. Product-manager naturally delegates to it. |
| `implementation-validator` | `quality` | member | Validates final diff against design docs. Sonnet + high effort. | Quality owns "does this match the spec" checking. |

Six new agents total. (Intake-router dropped per §10 Q1 default.)

Delegation wiring:
- `engineering-lead` gains `solution-architect`, `technical-designer`,
  `bug-investigator` in its `canDelegateTo`. It routes design work to the
  right specialist the same way it already routes backend/frontend work.
- `product-manager` gains `doc-auditor` in its `canDelegateTo`. The
  auditor is invoked from the workflow, not from chat, so this is mostly
  for discoverability in the org chart.
- `qa-lead` gains `implementation-validator` in its `canDelegateTo`.
- Cross-team delegation for the workflow's audit chain (doc-auditor in
  `product` being called from a workflow node after a producer in
  `engineering`) is allowed by the existing team-isolation rules: leads
  can delegate across teams, and workflow nodes bypass per-agent
  delegation allow-lists anyway (the workflow itself is the caller).

### 5.2 Changed existing agents

| Agent | Change |
|---|---|
| `engineering-lead` | Prompt change: (1) consume the approved PRD+HLA+TDD, do NOT redesign, produce a file-level implementation plan only. (2) for every file listed in the `changes` array, include an explicit `specialist` hint field identifying which specialist should own that file (`backend-developer` / `frontend-developer` / `devops-engineer` / `security-specialist` / `documentation-writer`). The `developer` orchestrator uses this hint for file grouping (§3.5d). Falls back to path-based heuristic when the hint is absent. |
| `backend-developer` | Prompt change: mandatory build+lint validation rule (§3.7). No workflow-level change — same agent, now invoked via `spawn_agent` by the `developer` orchestrator (§3.5d) instead of directly by the workflow. |
| `frontend-developer` | Same as backend-developer. Same agent, same prompt discipline, now spawned by `developer` orchestrator. |
| `devops-engineer` | Prompt change: mandatory build+lint validation rule (§3.7) for the subset of files it touches. Now eligible to be spawned by `developer` when the plan touches infra, CI, Docker, Terraform, etc. |
| `security-specialist` | No prompt change beyond what was already planned. Can be spawned by `developer` when the plan touches auth, secrets, crypto, input validation. Remains available as a delegation target for other agents (solution-architect, code-reviewer). |
| `test-writer` | Prompt change: tag every test (@regression, @unit, @integration, @acceptance). Build+lint discipline. |
| `qa-lead` | Prompt change: new responsibilities described in §3.6. Can fix simple things directly, delegates complex things back. |
| `code-reviewer` | Prompt change: explicit security checklist (§3.8). Output gets a new `security_findings[]` field. |
| `documentation-writer` | **Two prompt additions**: (1) the full doc-update contract from §3.5c — discover in-repo docs, match them to changed modules, update to match reality, match existing style, no speculation, doc-linter discipline. (2) A separate "summary mode" prompt for the terminal `summary` node in both workflows. Same agent, two prompts switched on by the node's config. |

### 5.3 Team changes

**None.** No new teams created. Five new agents slot into existing
`engineering`, `product`, and `quality` teams per §5.1. `requirements-
analyst` stays in `product` where it already lives.

## 6. Reused building blocks — what is shared, what isn't

Shared between the two workflows (not duplicated):

- `code-reviewer` with the new security-aware prompt.
- `open_pr` code node.
- `summary` node using `documentation-writer`.
- The build+lint validation discipline inside every coding agent.
- The `run_tests` code node (with different skip flags per workflow).

Workflow-specific:

- Feature only: PRD, HLA, TDD, doc-auditor, plan approval gate,
  engineering-lead, qa_coverage_review, implementation-validator.
- Bug only: bug-investigator, escalate-to-feature branch.

**Why not pull the shared pieces into a sub-workflow?** The engine supports
nested workflows. Tempting to put "code-review + PR + summary" into a
`finish-work` sub-workflow that both parents call. Rejected for now:

1. Two call sites isn't enough duplication to earn a sub-workflow.
2. Nested workflows add a debugging layer (errors in a sub-workflow show
   in the parent's trace with extra indirection).
3. The three nodes in "finish-work" are already small — copying them is
   cheaper than the abstraction.

Revisit if we grow to 4+ workflows that share the tail.

## 7. Key decisions with WHY

### 7.1 Three doc producers + one doc auditor, not one solution-planner

Previously considered collapsing PRD+HLA+TDD into one `solution-planner`
agent. Cheaper and naturally consistent. Rejected because the user
requirement explicitly asks for **three separate docs reviewed against
the user ask**. A single-agent plan can't do per-doc audits meaningfully.

### 7.2 Doc-auditor is separate from producers

Self-review is unreliable. One model call per audit is cheap insurance
against hallucinated completeness.

### 7.3 One human gate, after TDD audit, before implementation

Three gates (one per doc) fragment the user's attention. One gate with a
clear summary preserves the "approve once" feel without losing oversight.
Agent audits handle the per-doc quality checks instead.

### 7.4 Implementation-validator is new, not folded into code-reviewer

Code review checks "is this code good?" Validator checks "does this code
match the design?" Different questions, different inputs (code review
doesn't read the design docs). Folding them would blur the rubric and
produce worse reviews on both axes.

### 7.5 Validator loops back to `plan_implementation`, not to developers

If the validator says "wrong API shape," the problem might be the impl
plan, not the developer's execution. Loop back to engineering-lead who can
re-decide which agent to hand the fix to, with the violation list as
feedback. Prevents ping-ponging the same bad fix between backend-developer
and frontend-developer.

### 7.6 Max 2 validator loops then human escalation, PRD-first rubric

The validator caps retries at 2 (not 3) because agent retry convergence
follows a 0-or-1 pattern — either a loop fixes the issue or it never
does. Paying for more loops is a waste.

The validator's rubric is **PRD-first**: it checks whether the
implementation satisfies the user's actual requirement, NOT whether it
adheres to the TDD exactly. Deviations from the TDD are noted as
informational but do not block as long as the PRD is still satisfied.
This matches the user-stated principle that "if it deviates a little
but the requirements are matching, it should not raise." See §3.5 for
the full rubric and the blocking vs informational output shape.

### 7.7 QA can self-fix build/lint errors

The user specifically said "QA team can fix they fix." qa-lead already has
filesystem access in the seed (tools: ['filesystem', 'terminal']). New
prompt empowers it to fix directly instead of only delegating. For non-
trivial issues, delegation back to the original coding agent is still the
path.

### 7.8 Regression tests skippable, non-regression always run

Stated user requirement. Implementation via per-test tags (set by
test-writer) plus a workflow input flag. The default is `skip_regression
= false` — explicit opt-in, not opt-out, because the safer default is
"run everything" and the flag exists for the cases where the user knows
regression is slow.

### 7.9 Security review inside code-reviewer, not a separate stage

Cheaper and simpler. The existing `security-specialist` agent is not
deleted — it stays available for deep threat-model work when the solution
architect delegates to it during HLA production. The default PR path uses
one code-reviewer with a broader rubric.

### 7.10 Two workflow files, not one parameterised workflow

Explained in §2.

### 7.11 Bug path has NO implementation-validator

A validator needs design docs to validate against. Bug fixes don't have
design docs. The code-reviewer step catches bad fixes; the regression
test catches functional regressions; that's the safety net.

### 7.12 Bug investigator outputs "looks like a feature" flag

Bugs that require architectural change are features in disguise.
Catching them at the investigation stage prevents a bug workflow from
producing a half-designed implementation. Escalates to a human decision
point — "this isn't a bug, want to start a feature workflow instead?"

### 7.13 Summary node at the end of both workflows

Posts back to the chat session that started the workflow with: PR link,
what changed, what to watch for. Closes the loop so the user doesn't have
to go find the PR themselves. Uses the existing `documentation-writer`
agent with a new summary-specific prompt.

### 7.14 Chat as the primary entry point, workflow form as secondary

Both workflows can be started from:
- `/chat` — user types `@intake-router: ...` or directly `@solution-planner`
  / `@bug-investigator`. Conversational clarification happens in chat
  before the workflow starts.
- `/workflows/feature-plan-and-implement/run` form — power users fill the
  form with inputs and hit run, skipping the chat front door.

Chat matches the "I have a rough ask" mental mode; the form matches the
"I know exactly what I want this workflow to do" mental mode.

### 7.15 Trusted mode toggle only on the feature workflow

Bug fix workflow is already minimal — trusted mode (skip the human gate)
saves nothing because there's no pre-implementation gate in the bug path
to skip. Feature workflow has one pre-implementation gate; trusted mode
skips it and goes straight from TDD audit to implementation. Opt-in per
run, not per repo.

### 7.16 All development in a git worktree, never in the main clone

Both workflows insert a `create_branch` node before any coding agent
runs. It calls the existing `create-workspace` built-in function
(already used by `coding-workflow.yml`) which produces:
- `worktree_path` — absolute path to an isolated git worktree
- `branch_name` — new branch created in that worktree
- `workspace_id` — internal ID for tracking and cleanup

Every downstream agent (backend-developer, frontend-developer,
test-writer, qa-lead, code-reviewer, implementation-validator,
bug-fixer) reads `{{worktree_path}}` as its cwd — which is already the
default behavior in `node-executor.ts` thanks to `state.worktree_path`
being the primary cwd resolver. No engine changes.

**Why a worktree, not a branch on the main clone:**
1. **Parallel safety.** Multiple workflow runs can run concurrently on
   the same repo without stepping on each other's working tree. Each
   gets its own isolated worktree.
2. **Clean recovery.** On failure, the worktree is cleaned up by the
   existing workspace manager without leaving the main clone in a
   half-applied state.
3. **Already built.** The engine and UI already support worktrees
   end-to-end — cleanup service, stale PID detection, file-watch WS,
   terminal server all key off `workspaceId`. Reusing this is zero
   cost; inventing a branch-only flow would duplicate half of it.
4. **Matches existing coding-workflow.** The existing workflow does
   this; consistency across workflows is valuable for the operator's
   mental model.

**PR opened from the worktree's branch.** The `open_pr` node pushes the
worktree branch to the remote and opens the PR. On PR merge (external
to Allen), the worktree is kept for post-merge inspection until the
workspace TTL expires or the user explicitly archives it via the
workspaces UI.

### 7.17a Single `developer` orchestrator instead of static backend/frontend parallel nodes

The workflow engine's `[parallel]` nodes need to know at YAML-time
which branches exist. That model worked for `coding-workflow.yml` when
the only two specialists were backend-developer and frontend-developer,
but it doesn't scale. Real implementation plans need different
combinations of specialists per run — some tasks need backend +
frontend + devops, some need just backend, some need frontend + docs,
and eventually we'll add specialists we haven't thought of yet
(db-migrator, cli-developer, graphql-schema-designer, etc.).

The `developer` orchestrator moves the "which specialists do we need"
decision from YAML-time to run-time. The workflow engine sees ONE
`develop` node; the orchestrator reads the plan, decides which
specialists to spawn, detects file conflicts, and dispatches via
`spawn_agent`. Benefits:

1. **Extensibility without YAML edits.** Adding a new specialist is
   one agent seed + one line in the orchestrator's `canDelegateTo`
   list. No workflow file edit.
2. **Dynamic parallelism.** The orchestrator sees the actual file
   list, groups by specialist, runs non-conflicting groups in
   parallel, serializes conflicting groups. Static `[parallel]`
   nodes can't do this.
3. **File conflict safety.** The orchestrator has a first-class
   conflict-detection rule (§3.5d rule 3). Static parallel branches
   assume the specialists are disjoint, which is a silent assumption
   that breaks as soon as one feature touches both backend and
   frontend files in a shared module.
4. **Observability stays good.** The workflow engine tracks the
   `develop` node's start/end and the orchestrator's spawn calls
   appear in the execution sidebar as nested spawn events, same as
   any other `spawn_agent` call. The operator can click through to
   see each specialist's individual run.

The orchestrator adds ~1 extra model call per feature run (the
orchestrator's own call on top of the specialists' calls), which is
negligible compared to the specialists' cost. The cost is worth the
flexibility.

**Why it's a new agent and not a second hat on engineering-lead:**
engineering-lead's job is planning — producing the implementation
plan, making architectural decisions, classifying work. Mixing in an
execution-orchestration prompt mode would make one agent's
responsibilities ambiguous. Two agents, two clear jobs.

### 7.17b Existing inline human-in-loop UI on the execution page is removed, not kept in parallel

The current workflow execution page has an inline form for answering
`human` node inputs (clarifying questions, approvals, etc.). That UI
is removed entirely in the same commit that adds the engine hook for
intervention creation. Reasons:

- **Two surfaces for one action is ambiguous.** If both the inline
  form on the execution page and the new Interventions page accept
  answers for the same pause, the operator has to know which one
  wins. One action surface + one awareness surface (the banner) is
  unambiguous.
- **Existing workflows upgrade automatically.** The engine hook in
  §9.7a creates an intervention record for every `human` node pause,
  regardless of which workflow triggered it. `coding-workflow.yml` and
  any other existing workflow get the new UI for free — no YAML
  changes, no migration script, no legacy flag.
- **No parallel code paths to maintain.** Removing the old inline
  form in the same commit as the engine hook means there's never a
  half-state where both systems are live. Ships together or not at
  all.

### 7.18 Retries reuse the agent's resumed session — feedback only, no system prompt re-injection

Every retry in both workflows — whether auto-triggered by a condition
gate (doc-auditor, validator, QA) or human-triggered by an intervention
response (§9.6a) — runs against the agent's **resumed** prior session.
The resumed session already contains the system prompt, the task, the
tool call history, and the prior output. The executor sends ONLY a
minimal feedback block as the new user turn. System prompt is NOT
re-injected.

**Why:**
- **Context is preserved.** The agent remembers what it already did
  and why. It doesn't re-read the task from scratch or re-run
  exploratory tool calls it already did.
- **Tokens are saved.** Re-sending the system prompt on every retry
  would waste 2k-10k tokens per loop.
- **Confusion is avoided.** Re-sending "you are an X agent, your job
  is Y" right after the agent finished producing a Y output produces
  weird behavior — the model thinks a fresh task is starting instead
  of continuing a correction.

The existing `useMinimalRetryPrompt` logic in `node-executor.ts:146-161`
already behaves this way. Intervention-triggered retries set the same
state fields (`state.__retry_target`, `state.retry_context`,
`state.__retry_attempt`) that auto-retries set, and the executor
doesn't distinguish between the two sources — one code path, one
behavior.

### 7.17 Summary node is required at the end of both workflows

Non-optional terminal node. Every run — feature or bug, success or
validator-escalated — produces a machine-readable + human-readable
summary that is:
- posted back to the chat session that started the workflow, so the
  starter sees it where they already are;
- uploaded as a `.md` to the public `/api/files` endpoint, so the URL
  can be pasted into Slack, tickets, and email without auth; and
- emitted as a workflow output field (`summary_url`) for downstream
  automation (e.g., a cron that aggregates weekly implementation
  summaries).

The summary always contains the traceability spine: user request →
PRD criteria → tests → files → validator verdict → PR URL. This is
the single artifact a reviewer needs to answer "what was built, and
does it match what we asked for" without reopening the chat session.

## 8. What stays the same vs what needs coding

### 8.1 Reusable as-is

- The workflow engine (agent / code / condition / human / workflow
  nodes, retries, parallel branches, state flow, mermaid preview).
- The `secret` and `ALLEN_` prefix pattern.
- The `design_docs` collection shape from the previous plan (three sections,
  now clearly populated by three different producer agents instead of one).
- The public `/api/files` download path for doc links in chat.
- The existing `coding-workflow.yml` — kept for legacy "here's a plan, just
  code it" usage, not modified.

### 8.2 New code

- **5 new agent seeds** in `org-seed.ts`, each placed in an existing
  team per §5.1: `solution-architect`, `technical-designer`,
  `bug-investigator` (engineering); `doc-auditor` (product);
  `implementation-validator` (quality).
- **6 agent prompt edits**: engineering-lead (consume approved docs,
  don't redesign), backend-developer + frontend-developer + test-writer
  (build+lint discipline + worktree cwd discipline), qa-lead (coverage
  review + self-fix), code-reviewer (security checklist).
- **2 new workflow YAML files**: `feature-plan-and-implement.yml`,
  `bug-investigate-and-fix.yml`. Both reference the existing
  `create-workspace` built-in for the `create_branch` node — zero new
  engine code for workspace management.
- **No new built-in code nodes.** The doc-auditor's structured verdict
  evaluation uses the existing `condition` node type with filtrex over
  the auditor's JSON output, same pattern as existing workflows.
- **1 new Mongo collection** (`design_docs`) with a small service and
  REST routes. Shape: three sections (PRD, HLA, TDD), versioning per
  section, upload URL per version.
- **Delegation wiring updates** in the seed for engineering-lead,
  product-manager, and qa-lead `canDelegateTo` lists.
- **UI (optional for v1):** a Design Docs page, a Plan Approval card
  render template for the `human` node, a validator-verdict badge for
  PR summaries. Can defer any of these; the workflow is usable without
  them via the existing execution view + chat session.

### 8.3 Not new, explicitly reused

- `security-specialist` agent exists — kept as an optional delegation target
  for solution-architect. Not on the default path.
- `acceptance-tester` agent exists — kept as an optional delegation target
  for qa-lead on tricky cases. Not on the default path.
- `requirements-analyst` exists in the product team — the proposal is to
  move it to `discovery` OR allow cross-team delegation. See §9 Q5.

## 9. Human Intervention Protocol

Every human pause point in both workflows — no exceptions — follows a
single standard contract. This is the **Human Intervention Protocol**
(HIP). The goal is that a user receiving an intervention request always
sees the same structured card regardless of which workflow, which node,
or which severity triggered it. They never have to learn a new format.

### 9.1 The intervention envelope (shared data shape)

Every intervention is a document with this exact shape. Stored in a new
`workflow_interventions` collection; consumed by the chat UI, the Slack
notifier, the future Design Docs page, and any external integrations.

```
{
  _id,
  intervention_id,          // short human-readable ID, e.g. "INT-abc123"
  workflow_run_id,          // execution ID this intervention belongs to
  workflow_name,            // e.g. "feature-plan-and-implement"
  chat_session_id,          // original session that started the run
  started_by_user_id,       // the user to notify
  stage,                    // node name, e.g. "clarify_round_2"
  severity,                 // "question" | "approval" | "escalation"
  title,                    // one-line headline (≤ 80 chars)
  context_summary,          // 2-3 sentence state-of-the-world (≤ 400 chars)
  question,                 // the ask — formatted per §9.2
  options,                  // list of actions the user can take
  docs,                     // list of linked artifacts
  round_info,               // optional: { current: 2, max: 3 }
  deadline,                 // optional ISO timestamp, null = no timeout
  status,                   // "pending" | "answered" | "expired" | "skipped"
  response,                 // set when answered; shape varies by severity
  created_at,
  answered_at
}
```

- `options` is always an array of `{ label, value, primary?, destructive? }`.
- `docs` is always an array of `{ label, url, kind }` where `kind` is one
  of `prd | hla | tdd | pr | diff | logs | summary | external`.

### 9.2 The presentation format (chat card + Slack message)

Every intervention renders to both a chat card and a Slack message using
the same template. Identical structure in both places so the user can
take action from whichever surface they're in first.

**Template (Markdown, also converted to Slack Block Kit for the Slack
message):**

```
<severity-emoji> <SEVERITY_LABEL> — <stage title> <round_info>
Workflow: <workflow_name> [<intervention_id>]
For: "<truncated user_request>"

SUMMARY
<context_summary — 2-3 sentences>

QUESTION
<question — formatted per rules below>

DOCS
<bullet list of links, or "(none yet)">

ACTION REQUIRED
<rendered options as inline buttons in chat,
 or "Reply in chat, or click → [Review in Allen]" in Slack>
```

**Severity emojis (consistent everywhere):**
- 🟡 QUESTION — blocking clarification needed
- 🟢 APPROVAL — plan / diff ready, ready for go/no-go
- 🔴 ESCALATION — the agents couldn't self-correct, human must untangle

**Question formatting rules** — every `question` field follows these:

1. **One sentence per question.** No run-on paragraphs.
2. **Numbered list** when there are multiple questions in one card.
3. **Default answer suggested** in parentheses at the end when there is
   a reasonable default — `(default: per-user)`.
4. **Context for each question** as an italic line below it if the
   question wouldn't make sense without background.
5. **Never ask open-ended essay questions** — if it would take a
   paragraph to answer, it should be multiple-choice or yes/no.

**Example rendering (clarification round 1):**

```
🟡 QUESTION — Clarification, round 1 of 3
Workflow: feature-plan-and-implement [INT-abc123]
For: "Users should be able to bookmark their favorite workflows"

SUMMARY
Before writing the PRD, I need three clarifications about the
bookmark feature. Answers will be used verbatim by the PRD producer.

QUESTION
1. Are bookmarks per-user, per-workspace, or both? (default: per-user)
2. How should bookmarked workflows appear in the list?
   a) pinned at the top of the existing list
   b) in a separate "Starred" section above the rest
   (default: a)
3. Is there a cap on the number of bookmarks per user?
   (default: no cap)

DOCS
(none yet — docs will be produced after clarification)

ACTION REQUIRED
Reply in chat, or click → [Review in Allen](/executions/abc123)
```

**Example rendering (plan approval gate):**

```
🟢 APPROVAL — Plan ready
Workflow: feature-plan-and-implement [INT-abc124]
For: "Users should be able to bookmark their favorite workflows"

SUMMARY
All three design docs are produced and audited. No critical issues.
Implementation will touch ~8 files across backend and frontend.
Estimated 40 minutes, ~$3 in model cost.

QUESTION
Approve the plan and start implementation?

DOCS
• [Requirements Doc](https://…/prd.md)
• [Architecture Design](https://…/hla.md)
• [Technical Design](https://…/tdd.md)

ACTION REQUIRED
Approve → Start coding
Request changes (inline comment)
Reject
or click → [Review in Allen](/executions/abc123)
```

**Example rendering (validator escalation):**

```
🔴 ESCALATION — Implementation validator failed after 3 retries
Workflow: feature-plan-and-implement [INT-abc125]
For: "Users should be able to bookmark their favorite workflows"

SUMMARY
The validator found 2 critical mismatches between the approved TDD
and the implementation. Three retry loops did not resolve them.
A human needs to decide whether to accept the deviation or abort.

QUESTION
1. Accept the implementation despite the deviations listed below?
2. Abort and restart from the planning phase with revised requirements?
3. Mark as follow-up (merge what's done, ticket the rest)?

DOCS
• [Requirements Doc](https://…/prd.md)
• [Technical Design](https://…/tdd.md)
• [Current Diff](https://…/diff.patch)
• [Validator Report](https://…/validator.json)

ACTION REQUIRED
Accept / Abort / Mark follow-up
or click → [Review in Allen](/executions/abc123)
```

### 9.3 Slack notifications — delivery policy

Every intervention that the workflow pauses at fires a Slack message,
**always**. Policy:

- **User DM first.** If the user who started the workflow has a linked
  Slack user ID (stored on their Allen user profile, or discovered
  via `users.lookupByEmail`), DM them the formatted card.
- **Channel post, if configured.** If a `ALLEN_SLACK_INTERVENTIONS_CHANNEL`
  secret is set, the same card is also posted to that channel. Useful
  for teams who want shared visibility.
- **Both, when both are set.** DM for the owner, channel for visibility.
- **Neither fails the workflow.** If Slack isn't configured at all, the
  intervention still surfaces in chat — the Slack ping is additive.

The Slack message body mirrors the chat card exactly (same emoji, same
section headers, same docs list). The only delivery-specific difference
is the action block: Slack gets a single *"Review in Allen →"* link
button; the chat card has inline action buttons (Approve / Reject / etc.)
because the chat UI is already wired to the Allen backend for
direct action capture.

**Why link-through instead of Slack interactive buttons (for v1):** Slack
interactivity requires wiring a signed webhook back to Allen for
every button click, plus state management for the interaction token.
It's a real piece of work. Link-through is one line — a URL to the
interventions page. Upgrade path: add Slack interactivity later as an
enhancement without changing the envelope shape.

### 9.4 All intervention points — unified under HIP

Every pause in both workflows uses the protocol. Full list:

**Feature workflow intervention points:**

| # | Node | Severity | Triggered when |
|---|---|---|---|
| F1 | `clarify` (round 1) | 🟡 QUESTION | clarify emitted ≥ 1 question |
| F2 | `clarify` (round 2) | 🟡 QUESTION | clarify re-ran, still has questions |
| F3 | `clarify` (round 3) | 🟡 QUESTION | last round before commit |
| F4 | `audit_prd_escalation` | 🔴 ESCALATION | doc-auditor failed produce_prd 2 retries |
| F5 | `audit_hla_escalation` | 🔴 ESCALATION | doc-auditor failed produce_hla 2 retries |
| F6 | `audit_tdd_escalation` | 🔴 ESCALATION | doc-auditor failed produce_tdd 2 retries |
| F7 | `plan_approval_gate` | 🟢 APPROVAL | after persist_docs, before Phase 2 |
| F8 | `qa_escalation` | 🔴 ESCALATION | qa_failure_triage exhausted 3 loops |
| F9 | `validator_escalation` | 🔴 ESCALATION | implementation-validator exhausted 3 loops |

**Bug workflow intervention points:**

| # | Node | Severity | Triggered when |
|---|---|---|---|
| B1 | `feature_escalation` | 🟢 APPROVAL | investigate flagged `looks_like_a_feature: true` |
| B2 | `repro_question` | 🟡 QUESTION | bug-investigator cannot infer repro, asks via HIP |
| B3 | `qa_escalation` | 🔴 ESCALATION | full test suite still failing after fix attempts |

Every row above emits a HIP-formatted card in chat and a Slack
notification per §9.3. No intervention escapes the protocol.

### 9.5 Intervention persistence and audit

The `workflow_interventions` collection is append-only by design. Every
intervention is kept after it's answered, with the answer and
answering-user stored on the same record. Two uses:

1. **Audit trail.** Post-hoc, any workflow run's decision history is
   reconstructable — who approved what, when, with what reasoning.
2. **Learning.** Repeated escalations on the same gate across runs are
   a signal that prompts or rubrics need tightening. A future agent
   can read the history and propose prompt revisions.

**New Mongo indexes:**
- `workflow_interventions.createIndex({ workflow_run_id: 1, created_at: 1 })`
- `workflow_interventions.createIndex({ started_by_user_id: 1, status: 1 })`
- `workflow_interventions.createIndex({ status: 1, deadline: 1 })`
  (for future timeout sweeping)

### 9.6a Response handling and retry targeting (the loop-back semantics)

When a user responds to an intervention, the response shape is:

```json
{
  "decision": "approve" | "request_changes" | "reject" | "answer",
  "feedback": "...",           // free-form, required for request_changes
  "scope": "requirements" | "architecture" | "technical_design" | null,
                               // required for plan_approval_gate request_changes
  "answer": "..."              // for decision=answer (clarification questions)
}
```

**Decision → workflow action table:**

| Intervention | `approve` | `request_changes` | `reject` | `answer` |
|---|---|---|---|---|
| `clarify_round_*` | n/a | n/a | abandon workflow | advance to `produce_prd`, user's answer injected into state |
| `audit_prd_escalation` | retry `produce_prd` with user's feedback as retry context | same as approve | abandon | n/a |
| `audit_hla_escalation` | retry `produce_hla` with feedback | same | abandon | n/a |
| `audit_tdd_escalation` | retry `produce_tdd` with feedback | same | abandon | n/a |
| `plan_approval_gate` | advance to Phase 2 (implementation) | loop back based on `scope` field — requirements → produce_prd, architecture → produce_hla, technical_design → produce_tdd | abandon | n/a |
| `qa_escalation` | advance past QA (user takes responsibility) | loop back to `qa_failure_triage` with feedback | abandon | n/a |
| `validator_escalation` | advance past validator (user accepts the deviations) | loop back to `plan_implementation` with feedback | abandon | n/a |
| `feature_escalation` (bug) | continue as bug fix | start a new feature workflow, end this one | abandon | n/a |
| `repro_question` (bug) | n/a | n/a | abandon | advance to `create_branch`, user's repro steps injected into state |
| `qa_escalation` (bug) | advance past QA | loop back to `fix` or `add_regression_test` based on feedback | abandon | n/a |

**Resume-with-feedback semantics for loop-back targets:**

When an intervention response causes a loop back to an earlier node,
the engine reuses Allen's existing retry-with-feedback machinery
(already in `node-executor.ts:146-161` for auto-retry from condition
gates). Specifically:

1. The intervention service sets three fields on workflow state:
   - `state.__retry_target = [<target_node_name>]`
   - `state.__retry_source = 'human_feedback'`
   - `state.__retry_attempt = (current + 1)`
   - `state.retry_context = <the user's feedback verbatim>`
2. The engine resumes the workflow at the target node.
3. When the target node runs, the node-executor detects
   `useMinimalRetryPrompt === true` (existing logic), and constructs a
   minimal retry prompt that contains ONLY the human feedback — the
   agent's previous session is resumed, so it already has the full
   task context from its prior turns.
4. The agent re-runs with resumed session + new feedback, producing a
   revised output.
5. Any downstream gates (doc-auditor, validator, etc.) re-run
   automatically because they're downstream of the target node in the
   workflow DAG.

**Zero engine changes required.** The retry-with-feedback mechanism
already exists for automated gate retries. Human-triggered retries
set the same state fields; the executor doesn't know or care whether
the retry was triggered by a condition node or by a human response.

**Plan approval gate scope selection (the one tricky case):**

When the user clicks "Request changes" on the plan approval gate, the
UI prompts them to pick which section their feedback applies to:

- Requirements → loop back to `produce_prd`, all downstream docs are
  invalidated and re-run (HLA and TDD re-produced after PRD retry).
- Architecture → loop back to `produce_hla`, PRD stays, TDD re-runs.
- Technical design → loop back to `produce_tdd`, PRD and HLA stay.
- All / multiple → loop back to the earliest affected stage.

The scope picker is a radio button in the plan approval card. The user
has to pick one before submitting feedback. If they genuinely need to
change multiple sections, they pick the earliest and the downstream
sections re-run automatically.

**Why user picks scope instead of an LLM classifier:** deterministic,
zero extra model call, zero risk of misclassification, no new agent
surface to tune. The user knows what they want to change.

### 9.6 New service: `intervention.service.ts`

Thin wrapper around the collection. Three public methods:

- `create(envelope)` — inserts, renders, delivers to chat + Slack,
  returns the intervention ID.
- `respond(intervention_id, response)` — called when the user answers
  in chat or via the Design Docs page. Updates status, un-pauses the
  workflow via the existing `human` node resume mechanism.
- `list(filter)` — powers the "pending interventions" page / API.

Slack delivery is handled by a new `slack-notifier.ts` helper that
formats the envelope to Block Kit and posts via the existing Slack bot
token. Reuses the bot token we already wired for inbound events.

### 9.7 UI surfaces for interventions

Three surfaces, all backed by the same `workflow_interventions`
collection and `intervention.service.ts`.

**Surface 1 — Chat card (inline in the chat session).**
- Renders the HIP template from §9.2 as an interactive card in the
  chat session that started the workflow.
- Action buttons: Approve / Reject / Request changes / Answer questions
  (per decision table in §9.6a). Buttons post to
  `POST /api/interventions/:id/respond`.
- For plan_approval_gate with "Request changes", the card expands
  inline to show the scope picker (radio: requirements / architecture /
  technical_design / all) plus a textarea for feedback.
- Optimistic UI: clicking a button disables the card immediately and
  shows a loading indicator until the server confirms.
- After response: card shows the final state ("Approved by X at Y") and
  becomes read-only.

**Surface 2 — Dedicated Interventions page (`/interventions`).**

Two views:
1. **List view** (`/interventions`):
   - Table of all interventions across all workflow runs.
   - Columns: severity icon, title, workflow name, execution ID,
     status, age, started-by, answered-by (if done).
   - Filters: status (pending / answered / expired / all), workflow
     name, severity, started-by user, date range.
   - Sort: newest first (default), by severity, by age.
   - Bulk actions deferred to v2 — v1 is one-at-a-time.
2. **Detail view** (`/interventions/:id`):
   - Full HIP card rendering (same template as chat and Slack).
   - If status=pending and user has permission: same action buttons as
     the chat card, plus the scope picker for plan_approval_gate.
   - If status=answered: shows the response record — who, when, what
     decision, what feedback, what retry target (if any), link to the
     resulting retry node's trace.
   - Always shows: workflow run link (clickable to execution view),
     all linked docs, audit history of the *entire* workflow run (all
     prior interventions leading up to this one).
   - "Jump to related" section: other interventions from the same
     workflow run, chronologically.

**Surface 3 — Workflow execution page indicator.**

**Important: the existing inline human-in-the-loop UI on the
workflow execution page is REMOVED.** Today the execution page
renders clarifying questions and input forms directly inline (backed
by `submit_execution_input`). That inline UI goes away entirely — the
execution page no longer presents action controls for answering
interventions. Its new role is "show me the state of the run and
indicate when intervention is needed," not "let me take the action
right here."

- When an execution is in state `waiting_for_input` AND has an
  outstanding intervention, the execution page shows a prominent
  banner at the top of the node graph:

  ```
  🟡 PAUSED — Awaiting human intervention
  Clarification round 2 of 3 — 3 questions to answer
  [ Respond to intervention → ]
  ```

- The banner color matches the intervention severity (yellow for
  QUESTION, green for APPROVAL, red for ESCALATION).
- Clicking "Respond to intervention →" navigates to
  `/interventions/:id` (the detail view, Surface 2).
- The execution page also shows a new **Interventions sidebar** listing
  every intervention from this workflow run in chronological order,
  each clickable to the detail page. This is the "history on a
  per-run basis" view the operator needs to understand why a run
  took the path it took.
- No inline forms, no inline input boxes, no action buttons on the
  execution page itself. Every action happens on the dedicated page.

**Why remove the inline UI instead of keeping both:** having two
places to answer the same intervention creates ambiguity — which one
is canonical, which one takes precedence, what happens if both are
clicked at roughly the same time. One surface for action (the
dedicated page) + one surface for awareness (the execution page
banner) is unambiguous and easier to reason about.

### 9.7a Migration of existing `human` node type

The engine's `human` node type is universal — it's used by the
existing `coding-workflow.yml` for its own clarification stage and by
any other workflow that pauses for user input. To keep backward
compatibility while removing the inline UI, the migration is:

1. **Engine hook** — when the executor hits a `human` node and pauses
   the workflow (existing behavior), it ALSO calls
   `intervention.service.ts::create()` to produce an intervention
   record in the `workflow_interventions` collection. The intervention
   envelope is populated from the `human` node's existing `fields`
   configuration — field prompts become the `question`, field types
   become the `options` or `form_fields`.
2. **Response proxy** — when a user responds via the Interventions
   page, `intervention.service.ts::respond()` internally calls the
   existing `submit_execution_input` endpoint. The execution state
   machine doesn't change; only the UI that captures the response
   changes.
3. **No workflow YAML changes required.** Existing `coding-workflow.yml`
   continues to work unchanged — its `human` nodes automatically get
   the new UI because the engine hook is universal. This also means
   any future workflow that uses a `human` node gets the HIP treatment
   automatically.
4. **Old inline UI removed** from the execution page in the same
   commit that adds the engine hook — the two changes ship together
   to avoid a gap where the old UI is still mounted but the response
   path is broken.

**Result:** all workflows (existing + new) use the same unified
intervention system. No parallel UI trees, no mode flags, no "legacy
vs new" branching. The HIP is the single path for any human pause in
any workflow.

**Permissions model (v1):**
- Any authenticated user can view any intervention.
- Only the user who started the workflow OR any user with the `admin`
  role can respond to an intervention.
- Future: per-repo or per-team response permissions if demand arises.

### 9.8 History and audit trail

Every intervention is append-only. After it's answered, the document
is NOT deleted or replaced — instead, the answer is patched onto the
same record with:

```
status: "answered"
answered_at: <iso timestamp>
answered_by_user_id: <id>
response: { decision, feedback, scope, answer }
retry_triggered: { target_node, retry_attempt, retry_source }
                 // present iff the response caused a loop
```

**Three audit views use this data:**

1. **Interventions list page** (§9.7 Surface 2) — global history
   across all workflow runs.
2. **Workflow execution page sidebar** (§9.7 Surface 3) — per-run
   history for a single execution, chronological.
3. **Design doc version history** — each doc version in the
   `design_docs` collection carries a `caused_by_intervention_id`
   field so the design doc detail page can show "Requirements v2 was
   produced after [Clarification round 1 → user answered]."

Together these give you complete traceability from "user typed a raw
request" to "PR merged" — every decision along the way is captured,
attributed, and linked back to the intervention that caused it.

## 10. Open questions

I need your call on these before I start implementing. Default answers
noted; say "your call" to accept all defaults.

**Q1. ~~Intake routing~~ — RESOLVED (D with nuance)**

- Chat entry via `@product-manager` (features) and `@engineering-lead`
  (bugs).
- Workflows page form as a direct entry point.
- **Chat leads do NOT auto-kick workflows.** Default behavior is
  conversational — discussing, brainstorming, investigating without
  committing. A workflow is kicked off ONLY when the user's message
  contains an unambiguous imperative to build, implement, fix, patch,
  or raise a PR.

**Trigger rules added to `product-manager` and `engineering-lead` system
prompts:**

1. **Run the workflow IMMEDIATELY** when the user uses an explicit
   imperative with an implementation verb: "build this feature",
   "implement X", "fix this bug", "patch this", "raise a PR for this",
   "let's build it", "go ahead and implement", "start the feature
   workflow", "proceed with the plan".
2. **Ask before running** when the intent is mixed or implied — e.g.,
   "I'm thinking about adding X", "we probably need to fix Y". One-line
   confirmation: *"Want me to kick off the feature workflow for this,
   or keep discussing?"* Respond based on the answer.
3. **Do NOT mention the workflow at all** when the user is clearly in
   investigative / brainstorming mode — e.g., "what's the root cause
   of this?", "what would be a good way to X?", "help me think through
   the tradeoffs". Just engage conversationally.
4. **Brainstorming across multiple candidates** never triggers a
   workflow, no matter how many implementation verbs appear. The user
   has to converge on one concrete ask before the lead offers to run.

This keeps `@product-manager` and `@engineering-lead` useful as
conversation partners (root-cause discussion, feature exploration,
tradeoff analysis) without aggressively pushing work through a
workflow that costs real money and produces real PRs.

**Q2. ~~`requirements-analyst` team placement~~ — RESOLVED**

Per your directive: no separate `discovery` team. All new agents slot
into `engineering`, `product`, or `quality` (§5.1). `requirements-
analyst` stays in `product`. Closed.

**Q3a. ~~Slack notification destination~~ — RESOLVED (C: DM + channel)**

- DM the user who started the workflow run (resolved via
  `users.lookupByEmail` first, falling back to a stored `slackUserId`
  on the Allen profile).
- Also post to the channel in `ALLEN_SLACK_INTERVENTIONS_CHANNEL`
  if that secret is set.
- Neither is required — if both are missing, the intervention still
  surfaces in chat; Slack is additive.

**Q3. ~~Clarification rounds~~ — RESOLVED (up to 3 rounds)**

- `clarify` can run up to 3 rounds before committing to produce_prd.
- Each round emits a batch of 1–3 questions.
- Between rounds, the workflow pauses at a human node that uses the
  standard Human Intervention Protocol (§10) — formatted card in chat
  AND a Slack notification with summary + doc links.
- When `clarify` returns zero new questions OR hits the 3-round cap,
  the workflow advances to `produce_prd`.
- The round counter is visible to the user so they can see how many
  rounds remain.

**Q4. ~~Regression test tagging~~ — RESOLVED (A: framework-native)**

Test-writer uses the repo's existing test framework. Slow tests get
tagged with whatever the framework's native slow-test mechanism is
(vitest `.skipIf`, pytest `@pytest.mark.slow`, Go `testing.Short()`,
JUnit `@Tag("slow")`). The `run_tests` node passes the corresponding
skip flag to the runner when `skip_regression=true`. No new tagging
syntax, no manifest file, no filename convention.

This is part of the broader test-writer contract in §3.5b — see that
section for the full six-rule contract including internal dependency
recovery, graceful skip on external deps, and build+lint discipline.

**Q5. ~~Update the document~~ — RESOLVED (in-repo tech docs for affected modules, BOTH workflows)**

"Update the document" means the **in-repo technical documentation for
the module(s) whose behavior is changing** — NOT a changelog, NOT a
bug-tracker comment. When a fix or feature changes how a module
behaves, the docs that describe that module have to be updated to
match reality so they don't drift.

This applies to **both** workflows — features also change behavior and
their docs need to catch up. See §3.5c for the new node and §4.1 for
the bug workflow insertion point.

The `documentation-writer` agent (already exists in the `engineering`
team) is extended with a new "update in-repo tech docs for the current
diff" responsibility and inserted as a node in both workflows BEFORE
the `code_review` step so the reviewer checks docs and code together.

**Q6. ~~Plan approval gate — required or opt-out?~~ — RESOLVED (A: required, opt-out per run)**

- Feature workflow pauses at the plan approval gate by default.
- User can skip it per-run by passing `trusted_mode: true` as a
  workflow input.
- When skipped, the workflow auto-advances from `audit_tdd` straight
  to Phase 2 (`plan_implementation`).
- Even in trusted mode, any doc-auditor `escalate` verdict (§3.4)
  still pauses for human input — trusted mode skips the *approval*
  gate, not the *escalation* gate.
- Per-repo configuration is deferred to v2. If trusted mode ends up
  being set on every run for a specific repo, add a repo-level
  `default_trusted_mode` setting then.

**Q7. ~~Validator escalation ceiling~~ — RESOLVED (2 loops, PRD-first rubric)**

- Max **2 retry loops** before escalating to human (was 3 in the
  earlier draft).
- Validator rubric is **PRD-first** — the validator checks whether
  the implementation satisfies the requirement (PRD), NOT whether it
  adheres to the design (TDD) exactly.
- **Blocking violations** that cause a retry loop are only PRD-level:
  missing acceptance criterion, scope creep into PRD out-of-scope,
  violated non-functional requirement, missing PRD-derived risk
  mitigation, unhandled PRD edge case.
- **Informational deviations** where the implementation takes a
  different technical path than the TDD but still satisfies the PRD
  are noted in the Summary and PR body but do NOT trigger a retry.
- Full rubric and output shape in §3.5 (revised).

**Q8. ~~PR auto-merge on green CI~~ — RESOLVED (A: never auto-merge)**

- Allen never merges PRs. The workflow ends at "PR open, CI
  queued, summary posted."
- The human always sees the diff on GitHub with syntax highlighting,
  CI status, branch protection rules, and team-specific merge checks
  before clicking merge.
- GitHub's own auto-merge feature is independent — if the user enables
  it on the PR manually or via a repo setting, Allen doesn't
  interfere. We just don't participate in the merge decision at all.
- Revisit as a per-workflow or per-repo setting if the manual merge
  ever becomes an actual bottleneck. YAGNI for v1.

**Q9. ~~Plan approval card location~~ — RESOLVED (C+: chat + dedicated interventions page + execution-page indicator)**

Three surfaces, all backed by the same backend (§9.7):

1. **Chat card** — inline in the chat session. Interactive, with scope
   picker for plan_approval_gate request-changes.
2. **Dedicated Interventions page** (`/interventions`) — list + detail
   views, handles ALL intervention types (not just plan approvals),
   shows pending AND answered history, with filters and per-run
   audit view.
3. **Workflow execution page indicator** — when a run is paused on an
   intervention, a severity-colored banner appears on the execution
   page with a "Respond to intervention →" button that links to the
   dedicated page. A sidebar on the execution page also lists every
   intervention from that run in chronological order.

**Resume-with-feedback:** all loop-back actions use Allen's
existing retry-with-feedback machinery in `node-executor.ts`. The
intervention service sets `state.__retry_target`, `state.retry_context`,
and `state.__retry_attempt`, and the executor handles the rest — the
previous agent session is resumed with the feedback injected as a
minimal retry prompt. Zero engine changes (§9.6a).

**Q10. ~~Build + lint enforcement~~ — RESOLVED (A: prompt-only, + retry clarification)**

**Enforcement is prompt-only.** Every coding agent's system prompt
carries the build+lint rule (§3.7). No trailing validation node per
agent. Silent skips get caught by `run_tests` further downstream, and
the Summary node loudly flags any lint drift it sees in the final diff.

**Retry mechanics — no system prompt re-injection.** When a node loops
back for a retry (auto-retry from a condition gate OR human-triggered
retry from an intervention response), the agent's prior session is
**resumed**, not restarted. The resumed session already contains:

- the system prompt
- the original task prompt
- the agent's prior turns (tool calls, responses, output)
- the prior output schema

On retry, the executor sends ONLY a minimal feedback block as the new
user message — the existing `useMinimalRetryPrompt` logic in
`node-executor.ts:146-161`. The feedback block says, in effect, "your
previous output failed the following gate; here's the feedback; fix
it and re-emit your output" — nothing more. The system prompt is NOT
re-sent because it's already in the resumed session's context, and
re-sending it would waste tokens and confuse the agent.

This applies to:
- auto-retries from condition gates (doc-auditor, validator, QA)
- human-triggered retries from intervention responses (§9.6a)
- retries from `resume_on_retry: true` node config (the default)

**Zero engine changes.** The existing Allen retry-with-feedback
machinery already behaves this way; this entry just makes it explicit
so there's no ambiguity later about whether the system prompt gets
re-injected on retry. It does not.

## 11. What I need to start building

Once you answer the remaining open questions (or say "your call"), I
can build this in dependency order:

**Backend:**

1. Two new Mongo collections with indexes:
   - `design_docs` — PRD / HLA / TDD sections, versioned per-section
   - `workflow_interventions` — envelope per §9.1, append-only
2. Two new services:
   - `design-doc.service.ts` — CRUD, versioning, public-file upload
     on each new version
   - `intervention.service.ts` — create, respond, list, with
     resume-with-feedback wiring per §9.6a
   - `slack-notifier.ts` helper — formats HIP envelopes to Block Kit
     and posts via the existing Slack bot token (DM + channel per
     §9.3)
3. REST routes for both services. For interventions:
   - `GET /api/interventions` — list with filters
   - `GET /api/interventions/:id` — detail
   - `POST /api/interventions/:id/respond` — action handler that
     triggers the retry or advances the workflow
4. Workflow state extensions for intervention tracking on the
   execution doc (so the execution page can show the banner without
   a separate query).
4a. **Engine hook for the `human` node** (§9.7a): when the executor
    hits a `human` node and pauses, it creates an intervention
    record in `workflow_interventions` via `intervention.service.ts`.
    The `submit_execution_input` endpoint stays functional — the
    intervention service's `respond()` method proxies to it
    internally. Backward-compatible: existing workflows like
    `coding-workflow.yml` get the new UI without any YAML changes.
5. Six new agents in `org-seed.ts`, placed in existing teams per §5.1
   (solution-architect, technical-designer, **developer**, bug-
   investigator, doc-auditor, implementation-validator).
6. Six existing agent prompt edits (engineering-lead, backend-developer,
   frontend-developer, test-writer, qa-lead, code-reviewer,
   documentation-writer). Including:
   - Chat entry trigger rules for `product-manager` and
     `engineering-lead` (§10 Q1 resolution).
   - Test-writer contract (§3.5b).
   - Documentation-writer contract (§3.5c).
   - Validator-aware prompt changes on `engineering-lead` so it can
     consume approved PRDs instead of redesigning.
7. Two new workflow YAML files:
   - `feature-plan-and-implement.yml` — 20 nodes
   - `bug-investigate-and-fix.yml` — 10 nodes

**Frontend (new or modified):**

8. **New: Interventions list page** (`/interventions`) — table view
   with filters for status / workflow / severity / date.
9. **New: Intervention detail page** (`/interventions/:id`) — full
   HIP card rendering with action buttons, scope picker for plan
   approval, audit trail, and "jump to related" section.
10. **New: Chat intervention card component** — renders HIP template
    inline in chat, with interactive buttons and scope picker.
11. **Modified: Workflow execution page** — severity-colored banner
    when the run is paused on an intervention, "Respond →" button
    linking to the detail page, Interventions sidebar listing every
    intervention from that run chronologically. **The existing
    inline human-in-the-loop form UI is removed in the same commit
    that wires the engine hook** (§9.7a). Both changes ship together
    to avoid a gap where the old UI is mounted but the response path
    is broken.
12. **Optional: Design Docs page** — similar to Workflows list page
    but for design docs. Lists current and historical design docs,
    clickable to a three-tab view (Requirements / Architecture / TDD)
    with version history. Can defer to v2.

**Rough size estimate:** 6 new agents, 2 YAML workflows, 3 new services
(design-doc, intervention, slack-notifier), 2 new collections, 9 prompt
edits (engineering-lead plan-consumer mode + specialist hints,
backend-developer, frontend-developer, devops-engineer, test-writer,
qa-lead, code-reviewer, documentation-writer, and chat trigger rules
for product-manager), 4 new frontend pages/components + 1 modified
page. Two to three days of focused work serially; less with parallel
sub-agents.

## 12. What this does NOT do (scoped out on purpose)

- No live collaboration on the plan (two users approving the same plan
  simultaneously). One starter, one approver.
- No partial-resume of a failed workflow — the engine supports retries
  but not "start from step 12" yet. Out of scope.
- No cost estimation inside the plan approval card beyond what the
  solution-architect naturally produces. Not a dashboard, just a number.
- No automatic promotion of a bug workflow to a feature workflow — the
  bug-investigator flags the condition, but a human has to restart.
- No integration with external design tools (Figma, Lucidchart, etc.) —
  the TDD's sequence diagrams are mermaid, rendered inline in the doc.
- No multi-language support in the plan documents — docs are generated in
  whatever language the user requests come in, but we don't translate.
- No learning from past validator failures — the learning system (existing
  in allen) could feed back, but wiring it up is a separate concern.
