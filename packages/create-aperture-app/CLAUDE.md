# create-aperture-app

## Purpose

Scaffolding CLI that generates a new paid API or paid MCP server project
pre-configured with `@aperture/http` and `@aperture/core` on Cloudflare
Workers. Runnable via `npx create-aperture-app`.

## Key Types

- `cli.ts` — Entry point: parses args, copies template, writes package.json

## Module Structure

- `src/cli.ts` — CLI logic (project name, template selection, file copy)
- `templates/rest-worker/` — REST API template with one paid + one free route
- `templates/mcp-worker/` — MCP tool server template with L402 transport challenge

## Relationships

- **Depends on** (via templates):
  - [`@aperture/core`](../core/CLAUDE.md) — templates import macaroon issuer/verifier, types
  - [`@aperture/http`](../http/CLAUDE.md) — templates import runtime factory, adapters, invoice providers
- **Depended on by**: None (end-user scaffolding tool)

## Templates

### rest-worker
- One paid route (`/v1/search`, 10 sats, POST)
- One free route (`/health`)
- `MockInvoiceProvider` for local dev
- In-memory challenge store

### mcp-worker
- One paid MCP tool route (`/mcp`, 5 sats, POST)
- HTTP 402 transport-level challenge
- Returns JSON-RPC MCP tool response

## Deep Docs

- [`@aperture/core` CLAUDE.md](../core/CLAUDE.md) — Protocol types used by templates
- [`@aperture/http` CLAUDE.md](../http/CLAUDE.md) — Worker runtime used by templates
- [README.md](../../README.md) — Quick start guide, project structure
