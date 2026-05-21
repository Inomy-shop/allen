## Allen Change

Describe what changed and which Allen surface it affects: workflow engine, agents, server/API, workspaces, chat, integrations, UI, docs, or tests.

## Behavior

Explain the before/after behavior. For workflow or agent changes, include the workflow name, node, agent, and expected execution trace impact.

## Validation

- [ ] `npm run build`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run test:e2e` or focused manual test when this touches UI, workspaces, execution traces, chat, integrations, auth, or agent execution

## Safety

- [ ] I did not include `.env`, API keys, OAuth tokens, SSH keys, private repo contents, customer data, or proprietary prompts.
- [ ] I reviewed repo-write, terminal, MCP, secret, auth, and integration risks if this changes agent execution or workspaces.
- [ ] I updated README, `.env.example`, workflow docs, or troubleshooting notes if setup or behavior changed.
- [ ] I kept the PR focused on one Allen change.

## Linked Issues

Closes #
