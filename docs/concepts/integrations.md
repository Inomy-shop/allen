# Integrations

Integrations connect Allen to developer tools and external systems. They let Allen read tickets, open pull requests, post messages, use MCP tools, and coordinate work outside the core app.

## Main integration areas

- **GitHub** for repository and pull request workflows.
- **Linear** for ticket browsing and dispatch.
- **Slack** for chat-driven interaction from Slack threads.
- **MCP servers** for custom tools and external systems.
- **Model providers and CLIs** for agent execution. Supported providers include Claude, Codex, DeepSeek, Kimi, Xiaomi MiMo, GLM/Z.AI, and OpenRouter. OpenRouter is a provider-only integration by default: users register the exact OpenRouter model slug and configure the API key/endpoint themselves. Non-Claude OpenRouter models are experimental for the Claude Code execution path.

## How integrations fit

```text
User or workflow needs external data/action
  -> server resolves configured integration
  -> agent or workflow uses the approved tool path
  -> output is recorded in execution state, logs, or artifacts
```

## Configuration principles

- Use least-privilege credentials.
- Store secrets outside git.
- Only expose tools that a workflow or agent actually needs.
- Review integration changes as security-sensitive.

## Related docs

- [Security and sandboxing](../security.md)
- [Troubleshooting](../troubleshooting.md)
