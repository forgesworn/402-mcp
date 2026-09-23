# Gemini Instructions — 402-mcp

L402 client MCP server. AI agents discover, pay for, and consume Lightning and ecash payment-gated APIs within human-set limits. x402 support is experimental and uses a custom format.

## Commands

- `npm run build` — compile TypeScript to build/
- `npm test` — run all tests (vitest)
- `npm run typecheck` — type-check without emitting

## Conventions

- **British English** — colour, initialise, behaviour, licence
- **ESM-only** — `"type": "module"`, target ES2022, module Node16
- **Tool pattern** — each tool file exports a `handle*` function (testable with injected deps) and a `register*Tool` function (MCP wiring)
- **Tests** live in `tests/`, not co-located with source. Each handler's `handle*` function is tested directly with mock deps using `vi.fn()`
- **Commit messages** — `type: description` format (feat:, fix:, docs:, chore:, refactor:). No Co-Authored-By lines.

## Key Patterns

- **Atomic spend tracking** — always use `spendTracker.tryRecord(sats, limit)`, never split `wouldExceed()` + `record()` (TOCTOU race)
- **Preimage validation** — validate hex format before storing. Preimages are sent raw in `Authorization: L402 {macaroon}:{preimage}` headers
- **SSRF guard** — all outbound HTTP goes through the SSRF guard. Money-mutating POSTs pass `{ retries: 0 }` to disable retry
- **cashu-ts v2** — `getDecodedToken()` returns `{ mint, proofs, unit }` at top level. There is NO `.token` array
- **nostr-tools NIP-44** — use `getConversationKey(privkey, pubkey)` then `encrypt(plaintext, conversationKey)`. Do NOT use NIP-04

## Structure

- `src/index.ts` — entry point: config, wiring, transport setup
- `src/config.ts` — environment variable parsing with validation
- `src/tools/` — one file per MCP tool (handler + registration)
- `src/wallet/` — payment implementations (NWC, Cashu, human-in-the-loop)
- `src/store/` — persistent JSON stores (credentials, Cashu tokens)
- `src/l402/` — L402 protocol utilities (parse, detect, cache, bolt11)
- `src/fetch/` — resilient fetch: SSRF guard, timeout, retry, transport selection
- `tests/` — mirrors src/ structure
