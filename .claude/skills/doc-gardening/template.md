# Per-Package CLAUDE.md Template

Use this template when generating or updating per-package documentation files.

```markdown
# {package-name}

## Purpose

{1-2 sentences: what this package does, written as if explaining to someone
unfamiliar with the codebase.}

## Key Types

- `TypeName` — {one-line purpose}
- `InterfaceName` — {one-line purpose}

## Module Structure

- `src/subdir/` — {what this subdirectory handles}

## Relationships

- **Depends on**: `@lightninglabs/aperture-pkg` (reason)
- **Depended on by**: `@lightninglabs/aperture-pkg` (reason)
- **External**: CF Workers APIs, WASM bridge, Web Crypto API, etc.

## Invariants

- {Critical invariant an agent must know when modifying this package}
- {Another invariant, if applicable}

## Testing

- {Test file locations and what they cover}
- {How to run tests: `pnpm --filter @lightninglabs/aperture-{name} test`}

## Deep Docs

- [Design Doc](../../aperture-cloudflare-workers-runtime-design.md) — sections X-Y
- [README.md](../../README.md) — project overview
```

## Guidelines

- **Purpose**: Be specific. "Parses and verifies L402 credentials" is better
  than "Handles authentication."
- **Key Types**: List the top 5-8 exported types/interfaces. Skip internal
  types unless critical to understanding the package.
- **Relationships**: Use actual `@lightninglabs/aperture-*` package names. Include the
  reason for each dependency.
- **Invariants**: Focus on things that would cause bugs if violated.
  "WASM must be initialized before calling macaroon operations" is good.
  "Uses standard TypeScript" is not.
- **Testing**: List concrete test files and what scenarios they cover.
- **Deep Docs**: Link to the design doc with specific section numbers.
