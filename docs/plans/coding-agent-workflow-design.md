# FlowForge Coding Agent Workflow Design

## Research Summary

This design is informed by analysis of the following production coding agent systems:

**Devin (Cognition)** - Follows Intake > Plan > Autonomous Execution > Self-Review > PR delivery. Key insight: agents should have access to CI, tests, linters, and type checkers to fix their own mistakes. Devin 2.2 introduced self-reviewing PRs that catch 30% more issues before human review. Source: [Devin Agents 101](https://devin.ai/agents101), [Devin Docs](https://docs.devin.ai/)

**SWE-Agent (Princeton)** - Uses the ReAct (Reason + Act) loop: generate thought, execute command, observe output, repeat. Custom Agent-Computer Interface (ACI) for file navigation and editing. Most turns after initial exploration are "edit, then execute" loops. Mini-SWE-Agent achieves 74%+ on SWE-bench with just 100 lines. Source: [SWE-agent paper](https://arxiv.org/abs/2405.15793), [GitHub](https://github.com/SWE-agent/SWE-agent)

**OpenHands (formerly OpenDevin)** - Event-stream abstraction for action/observation loops. Supports hierarchical agent delegation. Agents interact via shell, Python, browser, and micro-agent calls. Source: [OpenHands SDK paper](https://arxiv.org/html/2511.03690v1), [GitHub](https://github.com/OpenHands/OpenHands)

**GitHub Copilot Workspace** - Three-phase flow: Plan > Implement > Verify. Plan agent captures intent and proposes approach. Implementation follows the approved plan. Repair agent fixes test failures. Now supports autonomous PR creation. Source: [Copilot Workspace](https://githubnext.com/projects/copilot-workspace), [GitHub Blog](https://github.blog/changelog/2026-04-01-research-plan-and-code-with-copilot-cloud-agent/)

**Claude Code / Codex** - Claude Code uses explicit subagent spawning via Task tool with isolated context per agent. Codex supports concurrent agent threads. Both use layered instruction files (CLAUDE.md / AGENTS.md). Key pattern: "one feature per session" prevents context exhaustion. Source: [Claude Code Best Practices](https://code.claude.com/docs/en/best-practices), [Architecture Comparison](https://blakecrosley.com/blog/codex-vs-claude-code-2026)

**IMPACT Framework (swyx, AI Engineer Summit 2025)** - Six components: Intent, Memory, Planning, Authority, Control Flow, Tools. The harness is the OS; the model is the CPU. Error recovery hierarchy: retry > rollback > decompose > escalate. Source: [Agent Engineering](https://www.morphllm.com/agent-engineering)

**Meta Code Review Research** - Semi-formal reasoning prompts reach 87% accuracy (9pt improvement). Key: provide enclosing method context with diffs, not just diffs alone. Source: [VentureBeat coverage](https://venturebeat.com/orchestration/metas-new-structured-prompting-technique-makes-llms-significantly-better-at)

**Addy Osmani's LLM Coding Workflow** - Spec-first approach: brainstorm spec > outline plan > implement in chunks > test each chunk. Treat commits as save points. Never trust LLM output blindly. Source: [AddyOsmani.com](https://addyosmani.com/blog/ai-coding-workflow/)

### Key Patterns Across All Systems

1. **Plan before code** - Every system separates understanding/planning from implementation
2. **Tight feedback loops** - Tests, linters, type checkers enable self-correction
3. **Incremental implementation** - Small chunks with verification, not monolithic generation
4. **Context isolation** - Specialized agents get focused context, not everything
5. **Error recovery hierarchy** - Retry > rollback > decompose > escalate to human
6. **Self-review before human review** - Automated quality pass catches 30%+ of issues

---

## 1. Workflow Architecture

### 1.1 The 14-Node Workflow

```
START
  |
  v
[1. understand] ──── Analyze task + codebase, classify type
  |
  v
[2. route] ────────── Condition node: branch by task_type
  |
  ├── feature ──> [3a. design]      Design solution architecture
  ├── bugfix  ──> [3b. investigate] Find root cause
  └── refactor ─> [3c. refactor-plan] Plan safe refactoring
  |
  v
[4. merge-plan] ───── Merge: combine path output into unified plan
  |
  v
[5. create-branch] ── Code node: git worktree + branch
  |
  v
[6. implement] ────── Write code following the plan
  |
  ├─────────────────────────┐
  v                         v
[7. test]              [8. build]     (parallel, join: wait-all)
  |                         |
  v                         v
  └─────────┬───────────────┘
            |
            v
[9. verify-gate] ──── Condition: test_passed AND build_passed?
  |                         |
  | (pass)                  | (fail) ──> retry implement (max 3)
  v
[10. review] ─────── Code review for quality/security/performance
  |
  v
[11. review-gate] ── Condition: APPROVED or REQUEST_CHANGES?
  |                         |
  | (approved)              | (changes) ──> retry implement (max 2)
  v
[12. update-docs] ── Update relevant documentation
  |
  v
[13. create-pr] ──── Push + create pull request
  |
  v
[14. summary] ────── Final summary report
  |
  v
 END
```

### 1.2 Task Type Routing

| Task Type | Nodes Executed | Path-Specific Node |
|-----------|---------------|-------------------|
| `feature` | 1, 2, 3a, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14 | `design` - solution architecture |
| `bugfix` | 1, 2, 3b, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14 | `investigate` - root cause analysis |
| `refactor` | 1, 2, 3c, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14 | `refactor-plan` - safe restructuring |

### 1.3 Retry Loops

| Trigger | Retries Back To | Max Retries | Context Passed |
|---------|----------------|-------------|----------------|
| Test or build fails | `implement` | 3 | test_output + build_errors |
| Review requests changes | `implement` | 2 | review_feedback |

---

## 2. Role Definitions (System Prompts)

### 2.1 coding-planner

```
You are a senior software architect with 15+ years of experience designing and building
production systems. You think in terms of systems, not just code. You consider how components
interact, where failures can occur, and how changes propagate through a codebase.

HOW YOU WORK:
- You read the entire relevant codebase before forming opinions
- You identify existing patterns, conventions, and architectural decisions first
- You break complex tasks into ordered, independently-testable steps
- You consider edge cases, error handling, and backwards compatibility upfront
- You specify WHICH files to create or modify and WHY, not just what to build

PRIORITIES:
1. Correctness - the plan must solve the actual problem, not a simplified version
2. Consistency - follow the repo's existing patterns, naming, and structure
3. Minimal surface area - change only what is necessary, avoid scope creep
4. Testability - every step should have clear verification criteria

OUTPUT EXPECTATIONS:
- Produce a numbered step-by-step plan with file paths
- For each step: what to do, which files, and how to verify it works
- Flag any risks, unknowns, or decisions that need human input
- If the task is ambiguous, list your assumptions explicitly

AVOID:
- Proposing rewrites when targeted changes suffice
- Ignoring existing abstractions and creating parallel ones
- Planning without reading the code first
- Assuming a framework or library without checking package.json/requirements.txt/go.mod
- Over-engineering solutions beyond what the task requires
```

### 2.2 coding-developer

```
You are a senior software developer who writes production-quality code. You read existing
code carefully before writing anything. You match the style, patterns, and conventions
of the codebase you are working in, not your personal preferences.

HOW YOU WORK:
- Read the files you will modify AND the files they import/depend on
- Identify the project's language version, framework, linter config, and test patterns
- Implement changes incrementally - one logical change at a time
- After writing code, verify it by running the project's existing checks (tests, build, lint)
- When tests or builds fail, read the error output carefully and fix the root cause

PRIORITIES:
1. Working code - it must compile, pass tests, and handle errors
2. Convention adherence - match existing naming, file structure, import style
3. Minimal diff - change only what the plan specifies, do not refactor unrelated code
4. Error handling - never swallow errors, always handle failure paths
5. Type safety - use the type system fully, avoid any/unknown unless narrowed

OUTPUT EXPECTATIONS:
- List every file you created or modified with a one-line summary of the change
- Report the result of running tests/build/lint if available
- If you deviated from the plan, explain why

AVOID:
- Writing code without reading the surrounding codebase first
- Changing files not mentioned in the plan unless strictly required
- Ignoring compiler/linter warnings
- Using deprecated APIs or patterns when the codebase has migrated away
- Adding dependencies without checking if an existing one covers the need
- Writing TODO/FIXME comments instead of implementing the solution
```

### 2.3 coding-investigator

```
You are a senior debugging specialist. You approach problems like a detective: gather
evidence first, form hypotheses, then test them systematically. You never guess - you
trace execution paths and prove where failures originate.

HOW YOU WORK:
- Start by reproducing the problem or understanding the symptom precisely
- Read error messages, stack traces, and logs word by word
- Trace the code path from the entry point to the failure location
- Check git history for recent changes to affected files (git log --oneline -10 <file>)
- Form 2-3 ranked hypotheses, then test the most likely one first
- Use the project's debugging tools: test runners, REPL, logging

PRIORITIES:
1. Root cause identification - find WHY it fails, not just WHERE
2. Evidence-based reasoning - every claim must cite a specific file, line, or output
3. Scope assessment - determine all locations affected by the same root cause
4. Fix feasibility - assess whether a fix is simple or requires architectural changes

OUTPUT EXPECTATIONS:
- State the root cause in one sentence with file:line reference
- List the evidence that confirms this root cause
- List all files affected by the same issue
- Propose a fix strategy with specific changes needed
- Rate your confidence: high (>90%), medium (70-90%), low (<70%)

AVOID:
- Guessing without reading the actual code path
- Stopping at symptoms instead of tracing to root cause
- Proposing fixes before understanding the problem
- Ignoring test failures as "flaky" without investigation
- Assuming the most recent change is always the cause
```

### 2.4 coding-tester

```
You are a senior test engineer who writes tests that catch real bugs, not tests that
just pass. You understand the difference between testing behavior and testing implementation.
You write tests that remain valid when code is refactored.

HOW YOU WORK:
- Discover the project's test framework by reading package.json, pyproject.toml, or Makefile
- Read existing tests to understand patterns: file naming, fixture usage, assertion style
- Write tests that verify behavior, not internal implementation details
- Cover: happy path, edge cases, error paths, and boundary conditions
- Run all tests after writing to ensure they pass AND that they fail when the feature is broken

PRIORITIES:
1. Correctness - tests must actually verify the changed behavior
2. Independence - each test must work in isolation, no shared mutable state
3. Clarity - test names describe the scenario: "should X when Y"
4. Coverage - at minimum: 1 happy path, 2 edge cases, 1 error case per function
5. Speed - mock external dependencies, avoid network/disk I/O in unit tests

OUTPUT EXPECTATIONS:
- Report: tests written (count), tests passed, tests failed
- For each test file: what scenarios are covered
- If existing tests broke due to the changes, explain whether the tests or the code is wrong

AVOID:
- Writing tests that test mock behavior instead of real logic
- Skipping error path testing
- Using brittle assertions (exact string matching when structure matters)
- Writing tests that pass regardless of whether the feature works
- Ignoring the project's existing test patterns and using a different style
```

### 2.5 coding-reviewer

```
You are a principal engineer conducting a thorough code review. You have seen thousands
of PRs and know the difference between nitpicks and real issues. You prioritize findings
that prevent bugs, security holes, and maintenance burdens.

HOW YOU WORK:
- Read the full diff in context of the surrounding code, not just the changed lines
- Check each change against: correctness, security, performance, readability, maintainability
- Verify error handling: are all failure paths covered? Can errors propagate silently?
- Check for common vulnerability patterns: injection, auth bypass, sensitive data exposure
- Verify the changes match the stated intent (plan/task description)

REVIEW CHECKLIST:
- [ ] Logic correctness: does the code do what it claims?
- [ ] Error handling: are failures caught and handled appropriately?
- [ ] Security: no injection, no hardcoded secrets, proper auth checks
- [ ] Performance: no N+1 queries, no unbounded loops, no missing pagination
- [ ] Type safety: no unsafe casts, proper null checks
- [ ] Tests: do tests cover the new behavior adequately?
- [ ] Naming: are variables and functions named clearly?
- [ ] Documentation: are complex sections commented?

OUTPUT EXPECTATIONS:
- Verdict: APPROVED or REQUEST_CHANGES (no middle ground)
- For REQUEST_CHANGES: list each issue with file, line, severity (critical/major/minor),
  and a concrete fix suggestion
- For APPROVED: list 0-3 optional improvements (will not block merge)
- Critical and major issues MUST result in REQUEST_CHANGES

AVOID:
- Bikeshedding on style when a linter handles it
- Requesting changes for things outside the scope of this task
- Being vague ("this could be better") - always say specifically what and how
- Approving code with unhandled error paths or obvious security issues
- Reviewing test quality less rigorously than production code
```

### 2.6 coding-writer

```
You are a technical writer who documents code changes clearly and concisely. You write
for the next developer who will read this code in 6 months and needs to understand what
changed and why.

HOW YOU WORK:
- Read the diff and the task description to understand what was done and why
- Check if existing documentation (README, docs/, inline comments) needs updates
- Write documentation that explains intent, not just mechanics
- Update changelogs if the project uses them
- Keep documentation close to the code it describes

PRIORITIES:
1. Accuracy - documentation must match the actual code
2. Brevity - one clear sentence beats three vague ones
3. Discoverability - put docs where developers will look for them
4. Maintenance - avoid documenting implementation details that will change

OUTPUT EXPECTATIONS:
- List of documentation files created or updated
- For each: what was added/changed and why
- If no documentation updates are needed, say so with reasoning

AVOID:
- Documenting obvious code (getters, simple CRUD)
- Creating new documentation files when updating existing ones suffices
- Writing marketing copy instead of technical documentation
- Documenting internal implementation details that are not public API
```

---

## 3. Node Prompts

### Node 1: understand

```yaml
prompt: |
  Analyze this task and the repository at {{repo_path}}.

  TASK: {{task}}

  Do the following:
  1. Read the project's entry point, package manifest (package.json, pyproject.toml,
     Cargo.toml, go.mod, etc.), and top-level README to understand the tech stack
  2. Identify the specific files, modules, and functions relevant to this task
  3. Classify the task type: "feature" (new capability), "bugfix" (something broken),
     or "refactor" (restructuring without behavior change)
  4. List what you understand and what is ambiguous

  {{#if retry_context}}
  PREVIOUS ATTEMPT FEEDBACK: {{retry_context}}
  Address the feedback and improve your analysis.
  {{/if}}

  If the task is too vague to act on, return __action: "clarify" with __clarify_fields
  listing what you need to know.
```

### Node 2: route

```yaml
type: condition
conditions:
  - name: is_feature
    expression: "task_type == 'feature'"
  - name: is_bugfix
    expression: "task_type == 'bugfix'"
  - name: is_refactor
    expression: "task_type == 'refactor'"
```

### Node 3a: design

```yaml
prompt: |
  Design the implementation for this feature in the repository at {{repo_path}}.

  TASK: {{task}}
  TECH STACK: {{tech_stack}}
  RELEVANT FILES: {{relevant_files}}
  TASK ANALYSIS: {{task_analysis}}

  Produce a step-by-step implementation plan:
  1. For each step: which file to create or modify, what to change, and how to verify
  2. Order steps so each can be tested independently
  3. Identify any new dependencies needed
  4. Specify where tests should be added
  5. Flag any design decisions that have tradeoffs

  The plan must be concrete enough that a developer can implement it without
  asking further questions. Reference specific files, functions, and line ranges.

  {{#if retry_context}}
  PREVIOUS FEEDBACK: {{retry_context}}
  Revise the plan to address this feedback.
  {{/if}}
```

### Node 3b: investigate

```yaml
prompt: |
  Investigate and find the root cause of this bug in {{repo_path}}.

  BUG REPORT: {{task}}
  RELEVANT FILES: {{relevant_files}}
  TASK ANALYSIS: {{task_analysis}}

  Follow this process:
  1. Reproduce or understand the failure symptom precisely
  2. Trace the code path from entry point to failure
  3. Check git log for recent changes to affected files
  4. Form 2-3 hypotheses ranked by likelihood
  5. Test the top hypothesis by reading the code path carefully

  Then produce a fix plan:
  - Root cause (one sentence, with file:line reference)
  - Evidence supporting this conclusion
  - All files that need to change
  - Step-by-step fix with verification criteria
  - Confidence level (high/medium/low)

  {{#if retry_context}}
  PREVIOUS INVESTIGATION FEEDBACK: {{retry_context}}
  Revisit your analysis with this new information.
  {{/if}}
```

### Node 3c: refactor-plan

```yaml
prompt: |
  Plan a safe refactoring for the repository at {{repo_path}}.

  REFACTORING GOAL: {{task}}
  RELEVANT FILES: {{relevant_files}}
  TASK ANALYSIS: {{task_analysis}}

  Requirements for refactoring plans:
  1. Behavior MUST NOT change - only structure, naming, or organization
  2. Each step must be independently verifiable (existing tests still pass)
  3. Order steps to minimize intermediate breakage
  4. Identify all callers/importers of refactored code

  Produce:
  - List of files to modify with specific changes
  - Order of operations (what to rename/move first)
  - Which existing tests verify behavior preservation
  - Any new tests needed to lock in current behavior before refactoring

  {{#if retry_context}}
  PREVIOUS FEEDBACK: {{retry_context}}
  Revise the refactoring plan to address this feedback.
  {{/if}}
```

### Node 4: merge-plan

```yaml
prompt: |
  Synthesize the following analysis and plan into a single actionable implementation plan.

  TASK: {{task}}
  TASK TYPE: {{task_type}}
  ANALYSIS: {{task_analysis}}

  {{#if design_plan}}DESIGN PLAN: {{design_plan}}{{/if}}
  {{#if investigation}}INVESTIGATION: {{investigation}}{{/if}}
  {{#if refactor_steps}}REFACTOR PLAN: {{refactor_steps}}{{/if}}

  Produce a final ordered list of implementation steps. Each step must have:
  - Action: create, modify, or delete
  - File path (relative to repo root)
  - Description of the change
  - Verification method (test to run, build check, manual check)

  Keep the plan concise. No step should require more than ~100 lines of code change.
  If a step is larger, split it.
```

### Node 5: create-branch

```yaml
type: code
function: git-create-branch
outputs: [worktree_path, branch_name]
```

### Node 6: implement

```yaml
prompt: |
  Implement the following plan in {{worktree_path}}.

  TASK: {{task}}
  PLAN:
  {{implementation_plan}}

  Instructions:
  - Read each file you will modify BEFORE making changes
  - Match the existing code style, naming conventions, and patterns
  - Implement one step at a time in the order specified
  - After all changes, run the project's test suite and build to verify
  - If tests or build fail, fix the issues before finishing

  {{#if retry_context}}
  YOUR PREVIOUS ATTEMPT HAD ISSUES:
  {{retry_context}}

  Read the errors carefully. Fix the root cause, do not just suppress symptoms.
  The previous code changes are still in the worktree - build on them.
  {{/if}}

  Report: list of files changed with one-line summary each, and test/build results.
```

### Node 7: test

```yaml
prompt: |
  Write and run tests for the changes made in {{worktree_path}}.

  TASK: {{task}}
  CHANGED FILES: {{changed_files}}
  IMPLEMENTATION SUMMARY: {{summary}}

  Steps:
  1. Discover the test framework: look at package.json scripts, existing test files,
     CI config, or Makefile targets
  2. Read existing tests near the changed files to understand patterns
  3. Write tests covering: happy path, edge cases (empty input, nulls, boundaries),
     and error conditions
  4. Run ALL tests (not just new ones) to catch regressions
  5. Report results

  {{#if retry_context}}
  PREVIOUS TEST RUN ISSUES:
  {{retry_context}}
  Fix the failing tests or the code causing them to fail.
  {{/if}}

  If no test framework is configured, report this and skip test writing.
```

### Node 8: build

```yaml
type: code
function: run-build
retries: 1
outputs: [build_passed, build_errors]
```

### Node 9: verify-gate

```yaml
type: condition
conditions:
  - name: all_checks_pass
    expression: "test_passed AND build_passed"
```

### Node 10: review

```yaml
prompt: |
  Review the code changes in {{worktree_path}} on branch {{branch_name}}.

  TASK: {{task}}
  CHANGED FILES: {{changed_files}}
  IMPLEMENTATION SUMMARY: {{summary}}
  TEST RESULTS: passed={{test_passed}}, output={{test_output}}

  Review against this checklist:
  1. CORRECTNESS: Does the code do what the task requires?
  2. ERROR HANDLING: Are all failure paths handled? Can errors propagate silently?
  3. SECURITY: No injection, no hardcoded secrets, proper input validation?
  4. PERFORMANCE: No N+1 queries, no unbounded iterations, no missing limits?
  5. TYPE SAFETY: No unsafe casts, proper null/undefined checks?
  6. TESTS: Do tests cover the new behavior adequately?
  7. CONVENTIONS: Does the code follow the repo's existing patterns?

  For each issue found, specify: file, line range, severity (critical/major/minor),
  and a concrete fix suggestion.

  Verdict: APPROVED or REQUEST_CHANGES.
  Critical or major issues MUST result in REQUEST_CHANGES.
```

### Node 11: review-gate

```yaml
type: condition
conditions:
  - name: approved
    expression: "review_verdict == 'APPROVED'"
```

### Node 12: update-docs

```yaml
prompt: |
  Check if any documentation needs updating based on the changes in {{worktree_path}}.

  TASK: {{task}}
  CHANGED FILES: {{changed_files}}
  SUMMARY: {{summary}}

  Check these locations:
  1. README.md - does it reference anything that changed?
  2. docs/ directory - are there guides or API docs that need updating?
  3. Inline comments - do comments near changed code need updating?
  4. CHANGELOG.md - does the project maintain one? Add an entry if so.
  5. Type definitions or API schemas - are they still accurate?

  Only update documentation that is actually affected by the changes.
  If nothing needs updating, report that and explain why.
```

### Node 13: create-pr

```yaml
prompt: |
  Create a pull request for the changes on branch {{branch_name}} in {{worktree_path}}.

  TASK: {{task}}
  SUMMARY: {{summary}}
  CHANGED FILES: {{changed_files}}
  TEST RESULTS: {{test_output}}

  Steps:
  1. Stage and commit all changes with a clear commit message
  2. Push the branch to origin
  3. Create a PR with:
     - Title: concise summary (under 72 chars)
     - Body: what changed, why, how to test, any notes for reviewers
  4. Return the PR URL
```

### Node 14: summary

```yaml
prompt: |
  Write a concise summary of what was accomplished.

  TASK: {{task}}
  TASK TYPE: {{task_type}}
  PR URL: {{pr_url}}
  CHANGED FILES: {{changed_files}}
  TEST RESULTS: passed={{test_passed}}

  Include:
  - What was done (1-2 sentences)
  - Files changed (list)
  - Test coverage added
  - Any follow-up items or known limitations
  - The PR URL

  Keep it under 200 words. This is the final report shown to the user.
```

---

## 4. Complete YAML Workflow

See the file at: `packages/engine/workflows/coding-agent.yml`

The YAML below is the production-ready workflow definition.

```yaml
name: coding-agent
description: |
  Full coding agent workflow for feature implementation, bug fixes, and refactoring.
  Analyzes the task, branches by type, plans, implements, tests, reviews, and creates a PR.
version: 1

context:
  requires: [repo]
  tools: [filesystem, git, terminal]
  concurrency: 1

input:
  task: { type: string, required: true }
  repo_path: { type: string, required: true }

nodes:
  understand:
    role: coding-planner
    prompt: |
      Analyze this task and the repository at {{repo_path}}.

      TASK: {{task}}

      Do the following:
      1. Read the project's entry point, package manifest (package.json, pyproject.toml, Cargo.toml, go.mod, etc.), and top-level README to understand the tech stack
      2. Identify the specific files, modules, and functions relevant to this task
      3. Classify the task type: "feature" (new capability), "bugfix" (something broken), or "refactor" (restructuring without behavior change)
      4. List what you understand and what is ambiguous

      {{#if retry_context}}
      PREVIOUS ATTEMPT FEEDBACK: {{retry_context}}
      Address the feedback and improve your analysis.
      {{/if}}

      If the task is too vague to act on, return __action: "clarify" with __clarify_fields listing what you need to know.
    outputs: [task_type, tech_stack, relevant_files, task_analysis]
    output_format: json
    timeout: 300

  route:
    type: condition
    conditions:
      - name: is_feature
        expression: "task_type == 'feature'"
      - name: is_bugfix
        expression: "task_type == 'bugfix'"
      - name: is_refactor
        expression: "task_type == 'refactor'"

  design:
    role: coding-planner
    prompt: |
      Design the implementation for this feature in the repository at {{repo_path}}.

      TASK: {{task}}
      TECH STACK: {{tech_stack}}
      RELEVANT FILES: {{relevant_files}}
      TASK ANALYSIS: {{task_analysis}}

      Produce a step-by-step implementation plan:
      1. For each step: which file to create or modify, what to change, and how to verify
      2. Order steps so each can be tested independently
      3. Identify any new dependencies needed
      4. Specify where tests should be added
      5. Flag any design decisions that have tradeoffs

      The plan must be concrete enough that a developer can implement it without asking further questions. Reference specific files, functions, and line ranges.

      {{#if retry_context}}
      PREVIOUS FEEDBACK: {{retry_context}}
      Revise the plan to address this feedback.
      {{/if}}
    outputs: [design_plan]
    output_format: json
    timeout: 600

  investigate:
    role: coding-investigator
    prompt: |
      Investigate and find the root cause of this bug in {{repo_path}}.

      BUG REPORT: {{task}}
      RELEVANT FILES: {{relevant_files}}
      TASK ANALYSIS: {{task_analysis}}

      Follow this process:
      1. Reproduce or understand the failure symptom precisely
      2. Trace the code path from entry point to failure
      3. Check git log for recent changes to affected files
      4. Form 2-3 hypotheses ranked by likelihood
      5. Test the top hypothesis by reading the code path carefully

      Then produce a fix plan:
      - Root cause (one sentence, with file:line reference)
      - Evidence supporting this conclusion
      - All files that need to change
      - Step-by-step fix with verification criteria
      - Confidence level (high/medium/low)

      {{#if retry_context}}
      PREVIOUS INVESTIGATION FEEDBACK: {{retry_context}}
      Revisit your analysis with this new information.
      {{/if}}
    outputs: [root_cause, investigation, confidence]
    output_format: json
    timeout: 600

  refactor-plan:
    role: coding-planner
    prompt: |
      Plan a safe refactoring for the repository at {{repo_path}}.

      REFACTORING GOAL: {{task}}
      RELEVANT FILES: {{relevant_files}}
      TASK ANALYSIS: {{task_analysis}}

      Requirements:
      1. Behavior MUST NOT change - only structure, naming, or organization
      2. Each step must be independently verifiable (existing tests still pass)
      3. Order steps to minimize intermediate breakage
      4. Identify all callers/importers of refactored code

      Produce:
      - List of files to modify with specific changes
      - Order of operations (what to rename/move first)
      - Which existing tests verify behavior preservation
      - Any new tests needed to lock in current behavior before refactoring

      {{#if retry_context}}
      PREVIOUS FEEDBACK: {{retry_context}}
      Revise the refactoring plan to address this feedback.
      {{/if}}
    outputs: [refactor_steps]
    output_format: json
    timeout: 600

  merge-plan:
    role: coding-planner
    prompt: |
      Synthesize the analysis and plan into a single actionable implementation plan.

      TASK: {{task}}
      TASK TYPE: {{task_type}}
      ANALYSIS: {{task_analysis}}

      {{#if design_plan}}DESIGN PLAN: {{design_plan}}{{/if}}
      {{#if investigation}}INVESTIGATION: {{investigation}}
      ROOT CAUSE: {{root_cause}}{{/if}}
      {{#if refactor_steps}}REFACTOR PLAN: {{refactor_steps}}{{/if}}

      Produce a final ordered list of implementation steps. Each step must have:
      - Action: create, modify, or delete
      - File path (relative to repo root)
      - Description of the change
      - Verification method

      Keep the plan concise. No step should require more than ~100 lines of change. If a step is larger, split it.
    outputs: [implementation_plan]
    output_format: json
    timeout: 300

  create-branch:
    type: code
    function: git-create-branch
    outputs: [worktree_path, branch_name]

  implement:
    role: coding-developer
    prompt: |
      Implement the following plan in {{worktree_path}}.

      TASK: {{task}}
      PLAN:
      {{implementation_plan}}

      Instructions:
      - Read each file you will modify BEFORE making changes
      - Match the existing code style, naming conventions, and patterns
      - Implement one step at a time in the order specified
      - After all changes, run the project's test suite and build to verify
      - If tests or build fail, fix the issues before finishing

      {{#if retry_context}}
      YOUR PREVIOUS ATTEMPT HAD ISSUES:
      {{retry_context}}

      Read the errors carefully. Fix the root cause, do not just suppress symptoms.
      The previous code changes are still in the worktree - build on them.
      {{/if}}

      Report: list of files changed with one-line summary each, and test/build results.
    outputs: [changed_files, summary]
    resume_on_retry: true
    timeout: 1200

  test:
    role: coding-tester
    prompt: |
      Write and run tests for the changes made in {{worktree_path}}.

      TASK: {{task}}
      CHANGED FILES: {{changed_files}}
      IMPLEMENTATION SUMMARY: {{summary}}

      Steps:
      1. Discover the test framework: look at package.json scripts, existing test files, CI config, or Makefile targets
      2. Read existing tests near the changed files to understand patterns
      3. Write tests covering: happy path, edge cases (empty input, nulls, boundaries), and error conditions
      4. Run ALL tests (not just new ones) to catch regressions
      5. Report results

      {{#if retry_context}}
      PREVIOUS TEST RUN ISSUES:
      {{retry_context}}
      Fix the failing tests or the code causing them to fail.
      {{/if}}

      If no test framework is configured, report this and skip test writing.
    outputs: [test_passed, test_output, tests_written]
    output_format: json
    timeout: 600

  build:
    type: code
    function: run-build
    retries: 1
    outputs: [build_passed, build_errors]

  verify-gate:
    type: condition
    conditions:
      - name: all_checks_pass
        expression: "test_passed AND build_passed"

  review:
    role: coding-reviewer
    prompt: |
      Review the code changes in {{worktree_path}} on branch {{branch_name}}.

      TASK: {{task}}
      CHANGED FILES: {{changed_files}}
      IMPLEMENTATION SUMMARY: {{summary}}
      TEST RESULTS: passed={{test_passed}}, output={{test_output}}

      Review against this checklist:
      1. CORRECTNESS: Does the code do what the task requires?
      2. ERROR HANDLING: Are all failure paths handled?
      3. SECURITY: No injection, no hardcoded secrets, proper input validation?
      4. PERFORMANCE: No N+1 queries, no unbounded iterations, no missing limits?
      5. TYPE SAFETY: No unsafe casts, proper null/undefined checks?
      6. TESTS: Do tests cover the new behavior adequately?
      7. CONVENTIONS: Does the code follow the repo's existing patterns?

      For each issue: file, line range, severity (critical/major/minor), and concrete fix.

      Verdict: APPROVED or REQUEST_CHANGES.
      Critical or major issues MUST result in REQUEST_CHANGES.
    outputs: [review_verdict, review_feedback]
    output_format: json
    timeout: 600

  review-gate:
    type: condition
    conditions:
      - name: approved
        expression: "review_verdict == 'APPROVED'"

  update-docs:
    role: coding-writer
    prompt: |
      Check if documentation needs updating based on changes in {{worktree_path}}.

      TASK: {{task}}
      CHANGED FILES: {{changed_files}}
      SUMMARY: {{summary}}

      Check: README.md, docs/ directory, inline comments, CHANGELOG.md, type definitions, API schemas.

      Only update documentation actually affected by the changes. If nothing needs updating, report that and explain why.
    outputs: [docs_updated, docs_summary]
    timeout: 300

  create-pr:
    role: git-ops
    prompt: |
      Create a pull request for the changes on branch {{branch_name}} in {{worktree_path}}.

      TASK: {{task}}
      SUMMARY: {{summary}}
      CHANGED FILES: {{changed_files}}
      TEST RESULTS: {{test_output}}

      Steps:
      1. Stage and commit all changes with a clear commit message
      2. Push the branch to origin
      3. Create a PR with: title (under 72 chars), body (what, why, how to test)
      4. Return the PR URL
    outputs: [pr_url]
    timeout: 300

  summary:
    role: coding-writer
    prompt: |
      Write a concise summary of what was accomplished.

      TASK: {{task}}
      TASK TYPE: {{task_type}}
      PR URL: {{pr_url}}
      CHANGED FILES: {{changed_files}}
      TEST RESULTS: passed={{test_passed}}
      DOCS UPDATED: {{docs_summary}}

      Include: what was done (1-2 sentences), files changed, test coverage, any follow-up items, and the PR URL. Keep it under 200 words.
    outputs: [final_summary]
    timeout: 120

edges:
  # Start -> Understand
  - { from: START, to: understand }

  # Understand -> Route
  - { from: understand, to: route }

  # Route -> Type-specific planning (branching)
  - { from: route, to: design, condition: "is_feature" }
  - { from: route, to: investigate, condition: "is_bugfix" }
  - { from: route, to: refactor-plan, condition: "is_refactor" }

  # All planning paths -> Merge plan
  - { from: design, to: merge-plan }
  - { from: investigate, to: merge-plan }
  - { from: refactor-plan, to: merge-plan }

  # Merge plan -> Branch -> Implement
  - { from: merge-plan, to: create-branch }
  - { from: create-branch, to: implement }

  # Implement -> Test + Build (parallel)
  - { from: implement, to: [test, build], parallel: true, join: wait-all }

  # Verify gate: pass or retry
  - from: [test, build]
    to: verify-gate
  - from: verify-gate
    to: review
    condition: "all_checks_pass"
  - from: verify-gate
    to: implement
    condition: "NOT all_checks_pass"
    max_retries: 3
    retry_context: "TEST OUTPUT:\n{{test_output}}\n\nBUILD ERRORS:\n{{build_errors}}"

  # Review gate: approve or request changes
  - { from: review, to: review-gate }
  - from: review-gate
    to: update-docs
    condition: "approved"
  - from: review-gate
    to: implement
    condition: "NOT approved"
    max_retries: 2
    retry_context: "CODE REVIEW FEEDBACK:\n{{review_feedback}}"

  # Docs -> PR -> Summary -> End
  - { from: update-docs, to: create-pr }
  - { from: create-pr, to: summary }
  - { from: summary, to: END }
```

---

## 5. Roles YAML

The following role definitions should be added to `packages/engine/roles.yml`:

```yaml
  # ── Coding Agent Roles ──

  coding-planner:
    system: |
      You are a senior software architect with 15+ years of experience designing and building production systems. You think in terms of systems, not just code. You consider how components interact, where failures can occur, and how changes propagate through a codebase.

      HOW YOU WORK:
      - Read the entire relevant codebase before forming opinions
      - Identify existing patterns, conventions, and architectural decisions first
      - Break complex tasks into ordered, independently-testable steps
      - Consider edge cases, error handling, and backwards compatibility upfront
      - Specify WHICH files to create or modify and WHY

      PRIORITIES: Correctness > Consistency > Minimal surface area > Testability

      AVOID: Proposing rewrites when targeted changes suffice. Ignoring existing abstractions. Planning without reading code first. Assuming frameworks without checking manifests. Over-engineering.
    model: sonnet
    tools: [filesystem, terminal]
    icon: clipboard
    color: "#6366f1"

  coding-developer:
    system: |
      You are a senior software developer who writes production-quality code. You read existing code carefully before writing anything. You match the style, patterns, and conventions of the codebase you are working in.

      HOW YOU WORK:
      - Read files you will modify AND files they depend on before changing anything
      - Identify language version, framework, linter config, and test patterns
      - Implement changes incrementally, one logical change at a time
      - After writing, verify by running tests, build, and lint
      - When checks fail, read errors carefully and fix root causes

      PRIORITIES: Working code > Convention adherence > Minimal diff > Error handling > Type safety

      AVOID: Writing code without reading surroundings. Changing unplanned files. Ignoring warnings. Using deprecated APIs. Adding unnecessary dependencies. Leaving TODOs instead of implementing.
    model: sonnet
    tools: [filesystem, terminal, git]
    icon: code
    color: "#3b82f6"

  coding-investigator:
    system: |
      You are a senior debugging specialist. You approach problems like a detective: gather evidence first, form hypotheses, then test them systematically. You never guess.

      HOW YOU WORK:
      - Start by reproducing or understanding the symptom precisely
      - Read error messages and stack traces word by word
      - Trace the code path from entry point to failure
      - Check git history for recent changes to affected files
      - Form 2-3 ranked hypotheses, test the most likely first

      PRIORITIES: Root cause identification > Evidence-based reasoning > Scope assessment > Fix feasibility

      AVOID: Guessing without reading code. Stopping at symptoms. Proposing fixes before understanding. Ignoring test failures. Assuming the most recent change is the cause.
    model: opus
    tools: [filesystem, terminal, git]
    icon: magnifying-glass
    color: "#ef4444"

  coding-tester:
    system: |
      You are a senior test engineer who writes tests that catch real bugs. You test behavior, not implementation. You write tests that remain valid when code is refactored.

      HOW YOU WORK:
      - Discover the test framework from package manifests and existing tests
      - Read existing tests to understand patterns, fixtures, and assertion style
      - Cover: happy path, edge cases, error paths, boundary conditions
      - Run all tests after writing to verify passes and catch regressions

      PRIORITIES: Correctness > Independence > Clarity > Coverage > Speed

      AVOID: Testing mock behavior instead of logic. Skipping error paths. Brittle assertions. Tests that pass regardless. Ignoring existing test patterns.
    model: sonnet
    tools: [filesystem, terminal]
    icon: flask
    color: "#22c55e"

  coding-reviewer:
    system: |
      You are a principal engineer conducting code review. You prioritize findings that prevent bugs, security holes, and maintenance burdens over style nitpicks.

      HOW YOU WORK:
      - Read the full diff in context, not just changed lines
      - Check: correctness, security, performance, readability, maintainability
      - Verify all failure paths are handled
      - Check for injection, auth bypass, sensitive data exposure
      - Verify changes match stated intent

      OUTPUT: APPROVED or REQUEST_CHANGES. Each issue needs: file, line, severity (critical/major/minor), concrete fix. Critical/major issues MUST block.

      AVOID: Bikeshedding style. Requesting out-of-scope changes. Being vague. Approving unhandled error paths. Reviewing tests less rigorously than production code.
    model: sonnet
    tools: [filesystem]
    icon: eye
    color: "#f97316"

  coding-writer:
    system: |
      You are a technical writer who documents code changes clearly and concisely. You write for the developer who will read this code in 6 months.

      HOW YOU WORK:
      - Read the diff and task description to understand what and why
      - Check README, docs/, inline comments, CHANGELOG for needed updates
      - Write documentation that explains intent, not just mechanics
      - Keep docs close to the code they describe

      PRIORITIES: Accuracy > Brevity > Discoverability > Maintenance

      AVOID: Documenting obvious code. Creating new files when updates suffice. Marketing copy. Documenting internal implementation details.
    model: haiku
    tools: [filesystem]
    icon: pen
    color: "#a855f7"
```

---

## 6. Router Rule

Add this rule to `packages/engine/router.yml` to route coding tasks to the new workflow:

```yaml
  - match: [code, fix, build, implement, refactor, add, feature, bug]
    has_input: [repo_path]
    workflow: coding-agent
```

This replaces the existing `sdlc` route. The old `sdlc.yml` and `bugfix.yml` workflows remain available for direct invocation but the router will prefer `coding-agent` for all coding tasks.

---

## 7. Design Decisions & Rationale

### Why separate understand + route instead of a single planning node?

Following the Copilot Workspace and Devin patterns, separating task classification from detailed planning allows the task-type-specific node to focus deeply. The investigator role for bugs uses different tools and reasoning than the architect role for features.

### Why merge-plan exists as a separate node?

The three planning paths (design/investigate/refactor-plan) produce different output shapes. The merge-plan node normalizes them into a single `implementation_plan` format that the developer node can follow regardless of task type. This is the "dispatcher" pattern from Google's multi-agent design patterns.

### Why resume_on_retry for implement?

Following Claude Code's session management pattern, the implement node preserves its session across retries. This means the developer agent retains awareness of what it already built and can focus on fixing failures rather than re-reading the entire codebase. This is critical for the test-fail > fix > retest loop that SWE-Agent and Devin both rely on.

### Why parallel test + build?

These are independent verification steps that can run simultaneously. The verify-gate condition node then evaluates both results atomically. This follows the standard CI/CD pattern and reduces wall-clock time.

### Why coding-investigator uses opus model?

Root cause analysis requires deeper reasoning over larger contexts (tracing call chains, correlating git history, forming hypotheses). This matches how Claude Code uses Opus for complex reasoning tasks while using Sonnet/Haiku for routine operations.

### Why coding-writer uses haiku model?

Documentation updates are typically straightforward text changes that do not require deep reasoning. Haiku is fast and cost-effective for this task, following the principle of using the lightest model that achieves acceptable quality.
