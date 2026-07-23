/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  docs: [
    {
      type: 'category',
      label: 'Start Here',
      collapsed: false,
      items: [
        'getting-started/overview',
        'getting-started/installation',
        'getting-started/run-allen',
        'getting-started/first-workflow',
      ],
    },
    {
      type: 'category',
      label: 'Core Features',
      collapsed: false,
      items: [
        'operator-guide/desktop-app',
        'concepts/chat',
        'concepts/agents',
        'concepts/teams',
        'concepts/repositories',
        'concepts/workspaces',
        'concepts/workflows',
        'concepts/skills',
        'concepts/artifacts',
        'concepts/integrations',
        'concepts/context-engine',
      ],
    },
    {
      type: 'category',
      label: 'Feature Guides',
      collapsed: false,
      items: [
        'guides/start-a-chat',
        'guides/add-a-repository',
        'guides/create-or-open-a-workspace',
        'guides/designer-studio-workflow',
        'guides/monitor-execution',
        'guides/use-artifacts',
      ],
    },
    {
      type: 'category',
      label: 'Integrations',
      collapsed: false,
      items: [
        'integrations/mcp',
        'integrations/linear',
        'integrations/google-workspace',
        'integrations/github',
        'integrations/slack',
        'integrations/model-providers',
      ],
    },
    {
      type: 'category',
      label: 'Admin and Builder Guides',
      items: [
        'guides/add-an-mcp-server',
        'guides/add-a-model',
        'guides/change-models',
        'guides/create-an-agent',
        'guides/create-a-workflow',
        'guides/run-a-workflow',
      ],
    },
    {
      type: 'category',
      label: 'Operator Reference',
      items: [
        'operator-guide/context-management',
        'operator-guide/self-healing-and-monitoring',
        'operator-guide/troubleshooting',
        'reference/workflows',
        'reference/agents',
        'reference/models',
        'reference/mcp',
        'reference/environment',
        'reference/ports',
        'reference/security',
        'reference/known-limitations',
      ],
    },
  ],
};

module.exports = sidebars;
