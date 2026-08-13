# AI Agent Instructions

This project uses [CLAUDE.md](./CLAUDE.md) as the primary source of AI agent instructions. It covers:

- Build, test, and typecheck commands
- Project structure and conventions
- Security patterns and rationale
- Dependency API notes (cashu-ts v2, @forgesworn/nwc-kit, farrier-kit)
- Testing conventions (handler extraction, mock injection)

All AI coding agents (Cursor, Copilot, Gemini, etc.) should read `CLAUDE.md` for project context.

## Quick reference

```bash
npm run build       # tsc → build/
npm test            # vitest run
npm run typecheck   # tsc --noEmit
```

- **British English** — colour, initialise, behaviour, licence
- **ESM-only** — `"type": "module"`, target ES2022, module Node16
- **Tool pattern** — each tool exports `handle*` (testable) + `register*Tool` (MCP wiring)
- **Tests** live in `tests/`, not co-located with source
