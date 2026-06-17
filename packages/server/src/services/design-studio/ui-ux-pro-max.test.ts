import { describe, expect, it } from 'vitest';
import { generateProMaxDesignIntelligence, renderProMaxMarkdown } from './ui-ux-pro-max.js';

describe('UI/UX Pro Max Design Studio integration', () => {
  it('generates supplemental design intelligence from vendored data without external setup', async () => {
    const insight = await generateProMaxDesignIntelligence({
      workspaceName: 'Acme SaaS',
      profile: {
        summaryMarkdown: 'A dense B2B SaaS dashboard with tables, cards, forms, filters, and analytics.',
        colors: [{ name: 'accent', value: '#4763cf', role: 'accent' }],
        typography: 'Inter for headings and body text.',
        spacing: 'Compact 8px grid.',
        components: [{ name: 'Button', description: 'Small radius action buttons with clear hover and disabled states.' }],
        iconography: 'Lucide outline icons.',
        layoutPatterns: 'Sidebar navigation with dashboard cards and data tables.',
        consistency: { consistent: true, issues: [] },
      },
      scan: {
        empty: false,
        fingerprint: 'test',
        files: [
          {
            path: 'package.json',
            content: JSON.stringify({ dependencies: { react: '^19.0.0', '@vitejs/plugin-react': '^5.0.0' } }),
          },
        ],
      },
    });

    expect(insight.source).toBe('ui-ux-pro-max');
    expect(insight.category).toBeTruthy();
    expect(insight.style.name).toBeTruthy();
    expect(insight.stack).toBe('react');
    expect(insight.uxGuidelines.length).toBeGreaterThan(0);

    const markdown = renderProMaxMarkdown(insight);
    expect(markdown).toContain('UI/UX Pro Max Design Intelligence');
    expect(markdown).toContain('Repository-derived Allen Design Studio tokens');
  });
});
