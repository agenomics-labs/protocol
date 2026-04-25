# ADR-034: Documentation Site

## Status

Accepted

## Date

2026-04-15

## Context

AEP lacks a structured documentation site. Developers need a searchable, navigable reference covering setup, API, integrations, and architectural decisions.

## Decision

Use VitePress to build a static documentation site under `/docs`:

- **Landing page** with hero section, feature cards, and quick start.
- **Getting Started** guide covering installation, MCP server configuration, vault creation, agent registration, and first task.
- **API Reference** documenting all 20 MCP tools with parameters, types, and example responses.
- **Integration Guide** for ElizaOS, Solana Agent Kit, Claude Desktop, Claude Code, and ChatGPT.
- **ADR section** linking all architecture decision records.
- Sidebar navigation organized by: Getting Started, Architecture, API Reference, Integration Guide, ADRs.

## Consequences

- Developers have a single entry point for all AEP documentation.
- VitePress generates fast static pages deployable to GitHub Pages or Vercel.
- ADRs are accessible alongside usage docs, providing architectural context.
- Documentation lives alongside code and stays in sync with development.
