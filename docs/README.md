# Allen Documentation

Allen is an agentic operating system for software development. These docs explain how to set up Allen, understand its main concepts, contribute safely, and operate the built-in agent/workflow system.

## Start here

- [First workflow](first-workflow.md) - run Allen locally and launch a safe first workflow.
- [Architecture](architecture.md) - high-level system map and package responsibilities.
- [Security and sandboxing](security.md) - repo execution, credentials, public links, workspaces, and operator responsibilities.
- [Troubleshooting](troubleshooting.md) - common setup, auth, MongoDB, Claude Code, workspace, integration, and test failures.
- [Known limitations](known-limitations.md) - current alpha constraints.

## Core concepts

- [Workflows](concepts/workflows.md) - repeatable multi-step processes for agent work.
- [Agents](concepts/agents.md) - configured AI workers with roles, tools, and permissions.
- [Teams](concepts/teams.md) - the seeded agent organization and responsibility model.
- [Skills](concepts/skills.md) - routing and operating guidance for choosing the right path.
- [Workspaces](concepts/workspaces.md) - isolated repo worktrees for agent tasks.
- [Artifacts](concepts/artifacts.md) - durable outputs from agents and workflows.
- [Integrations](concepts/integrations.md) - GitHub, Linear, Slack, MCP, and provider connections.

## Modules

- [Engine](modules/engine.md) - workflow runtime and agent execution orchestration.
- [Server](modules/server.md) - API, persistence, integrations, workspaces, and dispatch.
- [UI](modules/ui.md) - React app for chat, workflows, executions, workspaces, settings, and review.
- [Desktop](modules/desktop.md) - Electron host for the shared Allen product.
- [E2E](modules/e2e.md) - Playwright coverage for full-product flows.

## Operations and setup

- [Context engine setup](context-engine-setup.md) - install the optional context engine from the UI.
- [Context engine installation](context-engine-installation.md) - manual Python, model, Postgres/pgvector, and Neo4j setup details.
- [Context engine](context-engine.md) - runtime context retrieval, mandatory injection, selection policy, and usage tracking.
- [Curated and mandatory context](context-engine-curated-and-mandatory-context.md) - field-level guidance for creating and editing context entries.
- [Self-healing monitoring](SELF_HEALING_MONITORING.md) - how Allen watches its own runtime and routes incidents.
- [Desktop packaging](desktop-packaging.md) - local macOS packaging and smoke validation.

## Contributor references

- [Documentation guidelines](documentation-guidelines.md) - how to keep public docs useful and high-level.
- [Allen design system reference](allen-design-system-reference.md) - visual language for Allen UI work.
- [Context engine best practices](context-engine-best-practices.md) - guidance for repo context quality.
- [Claude prompting best practices](claude-prompting-best-practices.md) - prompt guidance for Claude-backed agents.
- [Gemini prompting best practices](gemini-prompting-best-practices.md) - prompt guidance for Gemini-backed agents.
