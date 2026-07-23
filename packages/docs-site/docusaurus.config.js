// @ts-check

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'Allen Docs',
  tagline: 'Operate agentic software work with visible workflows, workspaces, and human checkpoints.',
  favicon: 'img/favicon.svg',

  url: 'https://askallen.build',
  baseUrl: '/docs/',
  organizationName: 'Inomy-shop',
  projectName: 'allen',

  onBrokenLinks: 'throw',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },
  trailingSlash: false,

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          sidebarPath: require.resolve('./sidebars.js'),
          routeBasePath: '/',
          editUrl: undefined,
          showLastUpdateTime: false,
          showLastUpdateAuthor: false,
        },
        blog: false,
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      image: 'img/docs/social-card.svg',
      navbar: {
        hideOnScroll: false,
      },
      colorMode: {
        defaultMode: 'light',
        disableSwitch: true,
        respectPrefersColorScheme: false,
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Start',
            items: [
              { label: 'Overview', to: '/' },
              { label: 'Installation', to: '/getting-started/installation' },
              { label: 'First workflow', to: '/getting-started/first-workflow' },
            ],
          },
          {
            title: 'Operate',
            items: [
              { label: 'Monitor execution', to: '/guides/monitor-execution' },
              { label: 'Artifacts', to: '/concepts/artifacts' },
              { label: 'Troubleshooting', to: '/operator-guide/troubleshooting' },
            ],
          },
          {
            title: 'Reference',
            items: [
              { label: 'Environment', to: '/reference/environment' },
              { label: 'Ports', to: '/reference/ports' },
              { label: 'Security', to: '/reference/security' },
            ],
          },
        ],
        copyright: `Copyright © ${new Date().getFullYear()} Allen contributors.`,
      },
      prism: {
        additionalLanguages: ['bash', 'yaml', 'json'],
      },
    }),
};

module.exports = config;
