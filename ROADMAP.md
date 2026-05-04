# Roadmap

Allen's product direction is an agentic operating system for software development: teams assign work to agents, observe execution, intervene at checkpoints, and improve workflows over time.

This roadmap reflects backlog feature, improvement, and product-platform work for Allen. Completed, in-progress, validation, defect, and repair-only items are intentionally excluded.

## Setup and First-Run Experience

- Reduce setup time so a new Allen environment can be ready in five minutes or less.
- Add a demo repo and seeded workflow run for first-time users.
- Improve Docker/self-hosting so the server, UI, and MongoDB path is explicit and repeatable.
- Add screenshots and demo videos for MongoDB, Claude Code CLI, ports, auth bootstrap, workspaces, and integrations.

## Workflow and Agent Runtime

- Persist iterative user feedback across agent nodes and checkpoint reruns.
- Improve Allen memory and learnings capture, retrieval, filtering, and long-term usefulness.
- Clean up unnecessary, obsolete, or duplicate agents and simplify agent organization.
- Make agent routing explicit and consistent for repo/debug tasks, including visible routing reasons.

## Chat and Conversation Experience

- Add structured intake cards for investigation requests so agents receive repo, environment, URL, observed behavior, expected behavior, and allowed action.
- Add structured completion receipts for long-running coding/debug chats.
- Build native last-24h chat audit tooling for sessions, messages, outcomes, duplicate prompts, and productivity gaps.
- Detect duplicate prompts and suggest continuing relevant existing chats.

## Product Extensions

- Add configurable Google Meet transcript ingestion with workflow/agent handlers and automatic ticket sync.
- Add document management capabilities inside Allen.
- Explore and build a macOS app experience for Allen.

## Quality and CI

- Add CI jobs for e2e coverage that can run with controlled MongoDB/browser setup.

## Not in Scope for Alpha

- Running unreviewed third-party workflows against important repos.
- Treating Allen as a hardened sandbox for hostile code.
- Supporting every model provider, tracker, or desktop surface before the core workflow loop is solid.
