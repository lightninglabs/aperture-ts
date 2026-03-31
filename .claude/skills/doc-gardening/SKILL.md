---
name: doc-gardening
description: >
  Maintain the per-package documentation graph (CLAUDE.md) and root docs
  (README.md, ARCHITECTURE.md) after code changes. Use when a new package
  was created, types/interfaces/dependencies changed significantly, after
  a large refactor, or to bootstrap docs for an undocumented codebase.
argument-hint: "[package-name or 'all']"
allowed-tools: Read, Grep, Glob, Bash(ls *), Bash(find *), Bash(cp *), Bash(cat *), Write, Edit
---

# Doc Gardening (TypeScript Monorepo)

Maintain per-package documentation for the aperture-ts pnpm monorepo.
Handles both **generating docs for new packages** and **updating stale docs**.

If `$ARGUMENTS` is a specific package name (e.g., `core` or `http`), scope
work to that package only. If `$ARGUMENTS` is `all` or empty, scan the
entire repo.

## Phase 1: Detect Changes

Determine what needs attention.

**For scoped runs** (specific package):
- Read the package's `src/` directory and existing `CLAUDE.md` (if any).
- Determine if new or stale.

**For full runs** (`all` or no argument):

```bash
# Find packages missing CLAUDE.md
for dir in packages/*/; do
  [ ! -f "$dir/CLAUDE.md" ] && echo "MISSING: $dir"
done

# Find packages with TS changes on current branch (if on a branch)
git diff --name-only main...HEAD -- '*.ts' 2>/dev/null | \
  sed 's|/src/.*||' | sort -u
```

Classify each affected package:
- **New** — has `src/` directory but no `CLAUDE.md`.
- **Stale** — has `CLAUDE.md` but source changed since last update.

## Phase 2: Read Package Sources

For each affected package, gather:

1. `package.json` — name, description, dependencies, exports.
2. `src/index.ts` — public API surface (what gets exported).
3. Key exported types and interfaces — read primary `.ts` files.
4. Internal module structure — subdirectories under `src/`.
5. **Package relationships** — which workspace packages it depends on
   (check `dependencies` in `package.json` for `workspace:*` refs) and
   which depend on it.
6. **External integrations** — Cloudflare Workers APIs, WASM modules,
   Web Crypto API usage, etc.

Use the Explore agent for packages with many files, or direct Read/Grep for
small packages. Be thorough — per-package docs must be accurate, not guessed.

## Phase 3: Generate or Update CLAUDE.md

Follow the template in [template.md](template.md).

**For new packages**: Create from scratch using the template.
**For stale packages**: Read existing `CLAUDE.md`, diff against current source,
update only what changed. Do not rewrite content that is still accurate.

## Phase 4: Update Root ARCHITECTURE.md (if needed)

Check if:
- A new package needs to be added to the architecture overview.
- Dependencies changed between packages.
- A package was removed or renamed.

## Phase 5: Update Root README.md (if needed)

If the package structure changed, ensure the README's package listing is
current.

## Phase 6: Validate

Review each generated `CLAUDE.md`:
- All listed types actually exist in the source.
- Dependency relationships are accurate.
- Invariants are meaningful (not generic).

Report what was created/updated.

## Notes

- Skip `node_modules/`, `dist/`, and generated files.
- For the `wasm/` package, document Go source files (`.go`) not TypeScript.
- Prefer reading actual source over guessing from file names.
- When listing types, focus on the top 5-8 most important exported
  types/interfaces per package.
