# CLAUDE.md - l402-mcp

L402 client MCP - AI agents discover, pay for, and consume any L402-gated API autonomously.

## Commands

```bash
npm run build       # tsc → build/
npm test            # vitest run
npm run typecheck   # tsc --noEmit
```

## Structure

```
src/
  index.ts              # Entry point: transport setup, tool registration
  config.ts             # Environment variable parsing, defaults
  fetch/                # Resilient fetch: SSRF guard, timeout, retry
  tools/                # One file per MCP tool (handler + registration)
  wallet/               # Payment implementations (NWC, Cashu melt, human)
  store/                # Persistent JSON stores (credentials, Cashu tokens)
  l402/                 # L402 protocol utilities (parse, detect, cache, bolt11)
tests/                  # Tests mirror src/ structure (tests/tools/, tests/wallet/, etc.)
  e2e/                  # Integration tests against in-process toll-booth
```

## Testing

Tests live in `tests/` (NOT co-located with source). Each handler's `handle*` function is tested directly with injected deps (mock fetch, mock stores). Use `vi.fn()` for deps; cast with `as unknown as typeof fetch` for fetch mocks.

## Dependency API notes

- **cashu-ts v2:** `getDecodedToken()` returns `{ mint, proofs, unit }` at top level. There is NO `.token` array.
- **cashu-ts melt flow:** Must call `wallet.send(amount, proofs, { includeFees: true })` before `wallet.meltProofs()` to select proofs properly.
- **nostr-tools NIP-44:** Use `getConversationKey(privkey, pubkey)` then `encrypt(plaintext, conversationKey)`. Decrypt is synchronous. Do NOT use NIP-04 (deprecated, cryptographically weak).

## Conventions

- **British English** - colour, initialise, behaviour, licence
- **ESM-only** - `"type": "module"`, target ES2022, module Node16
- **Git:** commit messages use `type: description` format
- **Git:** Do NOT include `Co-Authored-By` lines in commits
- **Tool pattern:** Each tool file exports a `handle*` function (testable) and a `register*Tool` function (MCP wiring)
- **Zero toll-booth dependency** - works with any L402 server (toll-booth is devDependency only, for integration tests)

## Fetch Resilience

All outbound HTTP uses resilient fetch (timeout, retry, SSRF guard).
Money-mutating POSTs pass `{ retries: 0 }` to disable retry.
Polling fetches (pay.ts) also disable retry (the poll loop handles transience).
Set `SSRF_ALLOW_PRIVATE=true` for local development against localhost.
