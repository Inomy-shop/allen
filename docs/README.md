# Allen Documentation

Start here when setting up, operating, or contributing to Allen.

- [First workflow](first-workflow.md) - run Allen from a fresh local setup and produce a plan from a real repo.
- [Context engine setup](context-engine-setup.md) - install the Cognee-backed context engine and build repo context from the UI.
- [Context engine installation](context-engine-installation.md) - manual Python, model, Postgres/pgvector, and Neo4j setup details.
- [Context engine](context-engine.md) - runtime context retrieval, mandatory injection, Cognee selection policy, and usage tracking.
- [Curated and mandatory context](context-engine-curated-and-mandatory-context.md) - field-level guidance for creating and editing context entries.
- [Architecture](architecture.md) - how the engine, server, UI, workspaces, agents, and integrations fit together. Includes the Design tab routes, data model, and UI components.
- [Desktop Phase 0 audit](desktop-phase-0-audit.md) - initial audit for the macOS desktop app worktree and the embeddable-server refactor.
- [Desktop phase status](desktop-phase-status.md) - completed desktop phases and remaining release-operations notes.
- [Desktop packaging](desktop-packaging.md) - macOS packaging commands, packaged smoke, MongoDB binary pre-seeding, logs, and signing notes.
- [Security and sandboxing](security.md) - repo execution, secrets, public capability URLs, workspaces, MCP, and operator responsibilities.
- [Troubleshooting](troubleshooting.md) - common setup, auth, MongoDB, Claude Code, workspace, integration, and test failures.
- [Self-healing monitoring](SELF_HEALING_MONITORING.md) - how Allen's hourly self-healing loop watches its own runtime and routes incidents into repair workflows.
- [Known limitations](known-limitations.md) - current alpha constraints.
- [Claude prompting best practices](claude-prompting-best-practices.md) - prompt engineering techniques for Claude's latest models.
- [Gemini prompting best practices](gemini-prompting-best-practices.md) - prompt design strategies for Gemini AI models.
