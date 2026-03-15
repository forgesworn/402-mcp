# Contributing to 402-mcp

## Setup

```bash
git clone https://github.com/TheCryptoDonkey/402-mcp.git
cd 402-mcp
npm install
npm run build
```

## Development commands

```bash
npm run build       # Compile TypeScript → build/
npm test            # Run tests (vitest)
npm run test:watch  # Run tests in watch mode
npm run typecheck   # Type-check without emitting
```

## Project structure

```
src/
  index.ts              # Entry point: transport setup, tool registration
  config.ts             # Environment variable parsing, defaults
  fetch/                # Resilient fetch: SSRF guard, timeout, retry
  tools/                # One file per MCP tool (handler + registration)
  wallet/               # Payment implementations (NWC, Cashu, human)
  store/                # Persistent JSON stores (credentials, Cashu tokens)
  l402/                 # L402 protocol utilities (parse, detect, cache, bolt11)
tests/                  # Tests mirror src/ structure
  e2e/                  # Integration tests against in-process toll-booth
```

## Conventions

- **British English** — colour, initialise, behaviour, licence
- **ESM-only** — `"type": "module"`, target ES2022, module Node16
- **Tool pattern** — each tool file exports a `handle*` function (testable with injected deps) and a `register*Tool` function (MCP wiring)
- **Tests** live in `tests/`, not co-located with source. Each handler's `handle*` function is tested directly with mock deps using `vi.fn()`
- **Commit messages** use `type: description` format (e.g. `feat:`, `fix:`, `refactor:`, `docs:`)

## Adding a new tool

1. Create `src/tools/your-tool.ts` exporting `handleYourTool` and `registerYourToolTool`
2. Wire the registration in `src/index.ts`
3. Add tests in `tests/tools/your-tool.test.ts`
4. Update the tool tables in `README.md` and `llms.txt`

## Running locally

```bash
# Stdio transport (default)
node build/index.js

# HTTP transport
TRANSPORT=http PORT=3402 node build/index.js
```

Set `SSRF_ALLOW_PRIVATE=true` when testing against localhost services.

## Pull requests

1. Fork and create a feature branch
2. Ensure `npm run typecheck && npm test` passes
3. Keep commits focused — one logical change per commit
4. Open a PR against `main`
