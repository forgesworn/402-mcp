# AGENTS.md - 402-mcp

L402 client MCP: AI agents discover, pay for, and consume Lightning and ecash payment-gated APIs within human-set limits. x402 support is experimental and uses a custom format, not the x402 specification.

## Commands

```bash
npm run build       # tsc -> build/
npm test            # vitest run
npm run typecheck   # tsc --noEmit
npm run lint        # eslint src/
```

## Running

```bash
# Stdio transport (default - used by MCP clients like Claude Desktop)
node build/index.js

# HTTP transport (needs a bearer token file; stateless, one server per request)
TRANSPORT=http HTTP_AUTH_TOKEN_FILE=~/.402-mcp/http.token PORT=3402 node build/index.js
```

Key environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `NWC_URI_FILE` | - | Absolute path to a private 0600 file containing the NWC bearer URI |
| `CASHU_TOKENS` | - | Path to Cashu token store file (must be within home dir) |
| `LNURLCASH_NOTES` | - | Path to LNURLcash (LUD-25) bearer note store file (must be within home dir) |
| `MAX_AUTO_PAY_SATS` | `1000` | Auto-pay threshold per request (`0` disables auto-pay) |
| `MAX_SPEND_PER_MINUTE_SATS` | `10000` | Rolling 60s spend cap (`0` blocks auto-pay) |
| `MAX_SPEND_PER_DAY_SATS` | `5000` | Rolling 24h spend cap, persisted in `~/.402-mcp/spend-ledger.json` (`0` blocks auto-pay) |
| `CREDENTIAL_STORE` | `~/.402-mcp/credentials.json` | Path to credential store (must be within home dir) |
| `TRANSPORT` | `stdio` | `stdio` or `http` |
| `PORT` | `3402` | HTTP transport listen port |
| `BIND_ADDRESS` | `127.0.0.1` | HTTP transport bind address |
| `HTTP_AUTH_TOKEN_FILE` | - | Private 0600 bearer token file; required for `TRANSPORT=http` |
| `HTTP_ALLOWED_HOSTS` | - | Extra Host header values for DNS rebinding protection |
| `CORS_ORIGIN` | `false` | CORS origin for HTTP transport (`*` or specific origin) |
| `TRANSPORT_PREFERENCE` | `onion,hns,https,http` | Preferred transport order for multi-URL services (comma-separated) |
| `TOR_PROXY` | - | SOCKS5 proxy for `.onion` requests only (e.g. `socks5h://127.0.0.1:9050`) |
| `SOCKS_PROXY` | - | SOCKS5 proxy for every paid-API request. Set this or `TOR_PROXY`, not both |
| `HNS_GATEWAY_URL` | `https://query.hdns.io/` | DNS-over-HTTPS resolver for Handshake names |
| `HUMAN_PAY_TIMEOUT_S` | `600` | Timeout for human wallet QR payment (seconds) |
| `HUMAN_PAY_POLL_S` | `3` | Poll interval for human wallet payment (seconds) |
| `FETCH_TIMEOUT_MS` | `30000` | Outbound HTTP request timeout |
| `FETCH_MAX_RETRIES` | `2` | Max retries for non-mutating requests |
| `FETCH_MAX_RESPONSE_BYTES` | `10485760` | Max response body size (10 MiB) |
| `SSRF_ALLOW_PRIVATE` | `false` | Allow requests to private IPs (local dev only) |
| `ALLOW_INSECURE_TLS` | `false` | Acknowledge risk when `NODE_TLS_REJECT_UNAUTHORIZED=0`; without it (or `SSRF_ALLOW_PRIVATE=true`) startup fails |

`NWC_URI` and `HTTP_AUTH_TOKEN` are refused at startup: bearer secrets come only from the `*_FILE` variables. `src/config.ts` is the source of truth for this table; keep README.md, llms.txt and llms-full.txt in step with it.

## Structure

```
src/
  index.ts              # Entry point: runs on import (loads config, connects a transport)
  config.ts             # Environment variable parsing, defaults
  http-security.ts      # HTTP transport: bearer auth, Host allowlist
  spend-tracker.ts      # Atomic rolling-window spend limiter (60s and persisted 24h)
  fetch/                # Resilient fetch: SSRF guard, timeout, retry, transports, SOCKS, HNS
  tools/                # One file per MCP tool (handler + registration)
  wallet/               # Payment implementations (NWC, Cashu melt, LNURLcash, human)
  store/                # Persistent stores (credentials, Cashu tokens, LNURLcash notes, pending payments)
  l402/                 # L402 protocol utilities (parse, detect, cache, bolt11)
  ietf-payment/         # WWW-Authenticate: Payment challenges and credentials
  xcashu/               # X-Cashu (NUT-18) challenge parse and direct payment
  xlnurlcash/           # X-LNURLcash (LUD-25) challenge parse and bearer-note payment
  x402/                 # Experimental custom x402 format (parse, payment details)
  widgets/              # MCP Apps widget HTML (built to src/widgets/dist by npm run build)
tests/                  # Tests mirror src/ structure (tests/tools/, tests/wallet/, etc.)
  e2e/                  # Integration tests against in-process toll-booth
```

## Testing

Tests live in `tests/` (NOT co-located with source). Each handler's `handle*` function is tested directly with injected deps (mock fetch, mock stores). Use `vi.fn()` for deps; cast with `as unknown as typeof fetch` for fetch mocks.

## Dependency API notes

- **cashu-ts v3** (`@cashu/cashu-ts` ^3.6.1; Node 22.4 or newer): `getDecodedToken()` returns `{ mint, proofs, unit }` at top level. There is NO `.token` array. The wallet class is `Wallet` (`new Wallet(mintUrl, { unit })`), not `CashuWallet`.
- **cashu-ts melt flow:** call `wallet.createMeltQuote(invoice)`, then `wallet.send(amountNeeded, proofs, { includeFees: true })` (returns `{ send, keep }`) before `wallet.meltProofs(meltQuote, send)`, so proofs are selected properly. See `src/wallet/cashu.ts`.
- **NWC:** use `@forgesworn/nwc-kit`; do not implement NIP-47 or NIP-44 locally. The client requires signed capability discovery and NIP-44 v2.
- **nostr-tools NIP-44:** use `getConversationKey(privkey, pubkey)` then `encrypt(plaintext, conversationKey)`. Do not use NIP-04.
- **Payment proof:** use farrier-kit to decode the challenged BOLT-11 invoice and verify the returned preimage before reporting payment.

## Conventions

- British English: colour, initialise, behaviour, licence.
- ESM-only: `"type": "module"`, target ES2022, module Node16.
- Git: commit messages use `type: description` format.
- Git: do NOT include `Co-Authored-By` lines in commits.
- Tool pattern: each tool file exports a `handle*` function (testable) and a `register*Tool` function (MCP wiring).
- Zero toll-booth dependency: works with any L402 server (toll-booth is a devDependency only, for integration tests).

## Payment selection

Two separate orders, do not conflate them:

- **Challenge rail** (`handleFetch` in `src/tools/fetch.ts`), by the header the server sent: `X-LNURLcash`, then `X-Cashu`, then `X-Payment-Required: x402` (shown to the human, never paid), then `WWW-Authenticate: Payment`, then `WWW-Authenticate: L402`. LNURLcash and xCashu are paid straight from their own stores, not through the payer order below. If no note covers an LNURLcash price, the later rails are tried.
- **Payer for a Lightning invoice** (L402, IETF Payment, `l402-pay`, `l402-buy-credits`): `resolveWallet` returns the first available provider in the order NWC, Cashu, LNURLcash, human. NWC is available when configured; Cashu and LNURLcash when their store holds a balance. There is no fallback to the next payer when a payment fails. Human is last and always available, so it pays only when no other provider is available or `method: 'human'` is passed to `l402-pay` or `l402-buy-credits` (`l402-fetch` has no method override).

## Package exports

`package.json` `main` and `exports["."]` point at `build/index.js`, which loads config and connects a transport as soon as it is imported. Never import the package root from library code; use the subpaths (`402-mcp/tools/*`, `l402/*`, `x402/*`, `xcashu/*`, `xlnurlcash/*`, `ietf-payment/*`, `store/*`, `fetch/*`, `spend-tracker`). Declaration files are emitted beside each `.js` file (`declaration: true`), so subpaths resolve their types without a `types` field.

## Security patterns

- **Atomic spend tracking:** always use `spendTracker.tryRecord(sats, limit)`, never split `wouldExceed()` + `record()`. The split pattern has a TOCTOU race where concurrent callers both pass the check before either records.
- **Preimage validation:** `storeCredential()` in `index.ts` validates preimage is hex before storing. Preimages are sent raw in `Authorization: L402 {macaroon}:{preimage}` headers.
- **HTTP security headers:** HTTP transport sets `X-Content-Type-Options`, `X-Frame-Options`, `Cache-Control`, `CSP`.

## Fetch resilience

All outbound HTTP uses resilient fetch (timeout, retry, SSRF guard). Money-mutating POSTs pass `{ retries: 0 }` to disable retry. Polling fetches (pay.ts) also disable retry (the poll loop handles transience). Set `SSRF_ALLOW_PRIVATE=true` for local development against localhost.
