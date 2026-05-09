import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Agenomics Documentation',
  description: 'Agenomics Protocol on Solana',
  // Public docs ship only lowercase / kebab-case top-level pages.
  // Everything in SCREAMING_SNAKE_CASE.md is an internal ops/audit
  // document and stays out of docs.agenomics.xyz.
  srcExclude: [
    // Architecture / audit narrative
    'ARCHITECTURE.md',
    'ARCHITECTURE_AUDIT.md',
    'ARCHITECTURE_DEEP_CRITIQUE.md',
    'ARCHITECTURE_REAUDIT_*.md',
    'SECURITY_AUDIT.md',
    'AUDIT_SCOPE.md',
    'audits/**',
    // ADRs are engineering records, not public docs surface. Some also
    // contain Vue-template-incompatible markdown (e.g. ADR-123's
    // unescaped <tag> text), which would crash the build if shipped.
    'adr/**',
    // Mainnet / release ops runbooks
    'MAINNET_CHECKLIST.md',
    'MAINNET_DEPLOY_RUNBOOK.md',
    'PRE_MAINNET_ROADMAP.md',
    'PROTOCOL_AUTHORITY_OPERATIONS.md',
    'INCIDENT_RESPONSE.md',
    'SDK_PUBLISH.md',
    'SMOKE_TESTING.md',
    'WEB3_V2_MIGRATION.md',
    // Devnet / environment notes
    'DEVNET_FAUCETS.md',
    'SQUADS_DEVNET.md',
    // Project tracking + research notes
    'STATUS.md',
    'VIDEO_SCRIPTS.md',
    'SENDAIFUN_ECOSYSTEM_ANALYSIS.md',
    'SOLANA_ECOSYSTEM_ANALYSIS.md',
    'decisionbranches.md',
    // Operational runbooks
    'runbooks/**',
  ],
  // Several legacy pages link to docs that are intentionally excluded
  // (e.g. ARCHITECTURE.md) or live outside docs/ (e.g. ../SUMMARY.md).
  // Don't fail the build on them; the sidebar navigation is the
  // authoritative entry surface for public docs.
  ignoreDeadLinks: true,
  themeConfig: {
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Getting Started', link: '/getting-started' },
      { text: 'API Reference', link: '/api-reference' },
      { text: 'Integration Guide', link: '/integration-guide' },
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
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/agenomics-labs/protocol' },
    ],
  },
});
