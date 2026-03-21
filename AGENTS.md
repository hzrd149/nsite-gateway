# AGENTS.md

## Purpose

- This repo is `nsite-gateway`, a Deno + Hono gateway for serving static sites
  on Nostr.
- Keep changes minimal, repo-specific, and consistent with the current
  Deno-first architecture.
- There is no existing `AGENTS.md` baseline to preserve.
- No `.cursorrules`, `.cursor/rules/`, or `.github/copilot-instructions.md`
  files exist here currently.

## Project Layout

- Entrypoint: `main.ts`
- App construction: `src/server.ts`
- Main request flow: `src/site.ts`
- Nostr loading and relay logic: `src/nostr.ts`
- Cache backends: `src/cache.ts`
- Blob lookup and streaming: `src/blossom.ts`
- DNS and hostname resolution: `src/dns.ts`, `src/nsite-host.ts`
- Event parsing and manifest lookup: `src/events.ts`
- Request log helpers: `src/request-log.ts`
- Tests: `src/__tests__/`

## Core Commands

- Setup env: `cp .env.example .env`
- Dev server: `deno task dev`
- Start server: `deno task start`
- Direct run:
  `deno run --unstable-kv --allow-env --allow-net --allow-read --allow-write main.ts`
- Type-check: `deno task check`
- Format: `deno fmt`
- Format check: `deno fmt --check`
- Lint: `deno lint`
- Run all tests: `deno test`

## Single-Test Commands

- Run one test file: `deno test src/__tests__/nsite-host.test.ts`
- Run one named test:
  `deno test src/__tests__/nsite-host.test.ts --filter 'legacy named-site'`
- `--filter` is substring/regex-style matching on the `Deno.test(...)` name.

## Validation Expectations

- There is no separate bundle/build step; `deno task check` is the main
  build-style validation.
- For most changes run: `deno fmt`, `deno task check`, `deno test`.
- For targeted fixes, prefer: `deno fmt <files>`, `deno task check`, then a
  focused `deno test <file> --filter '...'`.
- If you touch docs or commands, prefer `deno task ...` when a task exists.
- If you change request routing, manifest resolution, or hostname parsing, add
  or run a focused regression test.

## Known Tooling Reality

- `deno lint` currently reports pre-existing repo issues.
- Do not assume the repo is lint-clean before your change.
- Avoid introducing new lint problems in files you touch.
- Do not reintroduce Node, pnpm, or `package.json` workflows.

## Formatting Rules

- Let `deno fmt` control formatting; do not hand-wrap against it.
- Preserve the file's existing import grouping and spacing unless there is a
  local reason to improve it.
- Keep comments sparse; this codebase generally avoids explanatory noise.
- Use ASCII unless the file already requires something else.
- Preserve the current terse style; avoid introducing long architectural
  commentary.

## Imports

- Put third-party imports before local relative imports.
- Use `import type` for type-only imports where practical.
- Keep local imports relative and include the `.ts` extension.
- Avoid unused imports and unnecessary mass reordering.
- Follow nearby style if a file already has a clear pattern.

## Types And APIs

- Prefer explicit return types on exported functions.
- Prefer `type` aliases; they are used more than `interface` here.
- Model result states with narrow unions when behavior branches materially.
- Use `undefined` for absence when that matches surrounding code.
- Avoid expanding legacy `any` usage.
- Keep public helpers small and focused.

## Naming

- `camelCase` for functions, locals, and helpers.
- `PascalCase` for types and classes.
- `UPPER_SNAKE_CASE` for env-derived constants and protocol constants.
- Reuse domain terms consistently: `pubkey`, `identifier`, `manifest`, `relay`,
  `hostname`, `server`, `blossom`.
- Prefer descriptive names over abbreviations unless the term is already
  standard in Nostr/Deno code.

## Control Flow

- Prefer early returns over nested conditionals.
- Keep request-handling logic linear and explicit.
- Use small helper functions for parsing, normalization, and response
  construction.
- Prefer direct async/await over layered promise chains.
- Use `Promise.all` only when work is truly independent.
- Preserve the current pattern of returning narrow result objects instead of
  mutating shared state.

## Error Handling

- Follow the repo's resilience-first approach for network, DNS, URL, and file
  operations.
- For expected failures, return `undefined`, `null`, `false`, or `[]` instead of
  throwing when callers can recover.
- Wrap non-fatal remote and filesystem operations in `try`/`catch`.
- Normalize unknown errors with
  `error instanceof Error ? error.message : String(error)`.
- In HTTP paths, prefer logging plus an explicit `Response` over process-level
  failure.
- Only throw when the caller cannot reasonably continue.

## Logging

- Use the shared `debug` logger from `src/logger.ts` for module-level debug
  logs.
- Scope loggers with `logger.extend("scope")`.
- `console.log` and `console.error` are also part of the existing style for
  startup and request logging.
- In request paths, add fields through `RequestLog` so they appear in the final
  request line.
- Preserve useful operational details such as outcome, source, sha, relay/server
  counts, and upstream server choice.
- Avoid adding noisy per-chunk or per-event logs unless they are essential for
  debugging production behavior.

## HTTP Conventions

- Use native `Request`, `Response`, `Headers`, and Deno APIs.
- Preserve current `GET` and `HEAD` semantics.
- Keep cache-related headers (`Cache-Control`, `ETag`, `Last-Modified`) intact
  unless the change explicitly targets them.
- Preserve `Onion-Location` behavior when touching routing or response assembly.
- Prefer explicit response assembly over hidden middleware side effects.
- Maintain current fallback behavior for static files and `/404.html` when a
  site path or homepage misses.

## Testing Style

- Use `Deno.test(...)`.
- Use `@std/assert` assertions.
- Keep test names descriptive and behavior-based.
- Add focused regression coverage when fixing parsing, routing, or protocol edge
  cases.
- Prefer small unit tests over broad integration scaffolding unless the behavior
  crosses modules.

## Repo-Specific Patterns

- Env configuration is centralized in `src/env.ts`; avoid scattering
  `Deno.env.get(...)` calls across new modules.
- Request metadata should flow through `RequestLog` instead of ad-hoc log
  formatting in handlers.
- Cache abstractions already support in-memory and Deno KV; extend the existing
  layer instead of bypassing it.
- Networking code should tolerate partial failure from relays, DNS, blossom
  servers, and local cache services.
- Keep Nostr kind handling aligned with `src/const.ts` and nearby protocol docs
  rather than hardcoding new values in multiple places.

## Editing Guidance

- Read the target file before editing.
- Match the existing local style before inventing a new one.
- Keep diffs tight; avoid opportunistic refactors.
- Do not reformat unrelated files.
- Do not remove user changes you did not make.
- If you add config or env behavior, reflect it in docs when appropriate.

## Agent Handoff Notes

- Mention the exact validation commands you ran.
- If a command fails due to an existing repo issue, say so clearly.
- When you cannot verify a behavior mechanically, state the gap plainly.
- Favor factual repo-specific guidance over generic best practices.
