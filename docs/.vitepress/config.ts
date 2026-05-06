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
    // Note: this also drops the three ADRs the sidebar still links to
    // (ADR-032/034/035). Those entries have already been 404 in
    // production for 20+ days — broadening the exclusion to ADR-100+
    // (ADR-123 has Vue-template-incompatible angle brackets) preserves
    // current observable behavior. Track sidebar fix separately.
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
