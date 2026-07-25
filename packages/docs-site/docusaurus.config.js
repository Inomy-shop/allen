// @ts-check

const { themes: prismThemes } = require('prism-react-renderer');

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'Allen Docs',
  tagline: 'Operate agentic software work with visible workflows, workspaces, and human checkpoints.',
  favicon: 'img/allen-favicon.svg',

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
        title: 'allen docs',
        logo: {
          alt: 'Allen',
          src: 'img/allen-favicon.svg',
          href: 'https://askallen.build',
        },
        items: [
          { label: 'Demo', href: 'https://askallen.build/#demo', position: 'left' },
          { label: 'How it works', href: 'https://askallen.build/#how', position: 'left' },
          { label: 'Integrations', href: 'https://askallen.build/#stack', position: 'left' },
          { label: 'Quickstart', href: 'https://askallen.build/#start', position: 'left' },
          { label: 'Docs', to: '/', position: 'left' },
          { label: 'GitHub', href: 'https://github.com/Inomy-shop/allen', position: 'right' },
        ],
      },
      colorMode: {
        defaultMode: 'light',
        disableSwitch: false,
        respectPrefersColorScheme: true,
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
        theme: prismThemes.github,
        darkTheme: prismThemes.vsDark,
        additionalLanguages: ['bash', 'yaml', 'json'],
      },
    }),
};

module.exports = config;
