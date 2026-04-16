import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Agenomics Documentation',
  description: 'Agenomics Protocol on Solana',
  srcExclude: ['ARCHITECTURE.md', 'SECURITY_AUDIT.md', 'MAINNET_CHECKLIST.md', 'AUDIT_SCOPE.md', 'WEB3_V2_MIGRATION.md', 'adr/ADR-0*.md'],
  themeConfig: {
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Getting Started', link: '/getting-started' },
      { text: 'API Reference', link: '/api-reference' },
    ],
    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Setup Guide', link: '/getting-started' },
        ],
      },
      {
        text: 'Architecture',
        items: [
          { text: 'System Overview', link: '/architecture' },
        ],
      },
      {
        text: 'API Reference',
        items: [
          { text: 'MCP Tools', link: '/api-reference' },
        ],
      },
      {
        text: 'Integration Guide',
        items: [
          { text: 'Framework Integrations', link: '/integration-guide' },
        ],
      },
      {
        text: 'ADRs',
        items: [
          { text: 'ADR-032: npm Packages', link: '/adr/ADR-032-npm-packages' },
          { text: 'ADR-034: Documentation Site', link: '/adr/ADR-034-documentation-site' },
          { text: 'ADR-035: Dashboard Devnet', link: '/adr/ADR-035-dashboard-devnet' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/agenomics-labs/protocol' },
    ],
  },
});
