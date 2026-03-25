# Security

402-mcp handles real money, so security is a first-class concern. This document covers the protections built into every layer.

## Spend safety

Two complementary caps prevent runaway autonomous spending:

- **`MAX_AUTO_PAY_SATS`** (default 1000) caps any single autonomous payment. Above this threshold the agent must ask for human approval.
- **`MAX_SPEND_PER_MINUTE_SATS`** (default 10000) enforces a rolling 60-second window cap across all payments, preventing rapid successive payments from exceeding a total budget even if each individual payment is below the per-payment cap.

Both limits are enforced via an atomic `tryRecord(sats, limit)` method on the `SpendTracker`. This single-call pattern checks *and* records the spend in one step, closing a TOCTOU (time-of-check-to-time-of-use) race that existed when `wouldExceed()` and `record()` were separate calls — concurrent callers could both pass the check before either recorded. If a payment fails after `tryRecord` succeeds, `unrecord(sats)` rolls back the entry so failed payments do not consume spend-limit headroom.

The tracker also caps its internal entry list at 10,000 entries and evicts stale records to prevent unbounded memory growth.

## SSRF protection

All outbound HTTP requests pass through an SSRF guard (`src/fetch/ssrf-guard.ts`) that blocks connections to internal networks:

- **IPv4:** loopback (127.x), private ranges (10.x, 172.16-31.x, 192.168.x), link-local (169.254.x), CGNAT (100.64-127.x), reserved/Class E (240+), documentation nets (TEST-NET-1/2/3), benchmarking, broadcast, and IETF protocol assignments.
- **IPv6:** loopback (::1), unspecified (::), link-local (fe80::/10), deprecated site-local (fec0::/10), and ULA private ranges (fc00::/7).
- **IPv4-mapped IPv6:** both dotted-quad (::ffff:127.0.0.1) and hex (::ffff:7f00:1) forms are detected and the embedded IPv4 address is checked against the IPv4 blocklist.
- **NAT64:** the well-known prefix 64:ff9b::/96 is detected in both hex and dotted-quad forms and the embedded IPv4 is validated.
- **Cloud metadata endpoints:** blocked implicitly because they reside on link-local (169.254.169.254) or private IP ranges.
- **Multi-homed bypass prevention:** DNS resolution uses `lookup({ all: true })` to resolve *all* A/AAAA records. Every resolved address is validated, preventing an attacker from hiding a private IP behind a public one.
- **IPv6 zone ID stripping:** zone/scope identifiers (e.g. `fe80::1%25eth0`) are stripped before validation so they cannot be used to bypass the guard.

### DNS rebinding protection

For plain HTTP URLs, the resolved IP address is pinned into the fetch URL itself, so `fetch()` connects to the same IP that passed SSRF validation. This closes the DNS rebinding TOCTOU window where an attacker's DNS could return a public IP for validation then a private IP for the actual connection. The original `Host` header is preserved so the upstream server routes correctly.

For HTTPS, IP pinning is not possible (TLS certificate validation requires the original hostname), but HTTPS is inherently resistant to DNS rebinding because an attacker cannot present a valid TLS certificate for the target hostname from a private IP.

### Local development

Set `SSRF_ALLOW_PRIVATE=true` to bypass all SSRF checks. This is intended **only** for local development against localhost services and must never be enabled in production.

## Credential encryption

Stored credentials (macaroons, preimages, payment hashes) are encrypted at rest using **AES-256-GCM** with a random 12-byte IV per encryption operation. The authenticated encryption tag prevents tampering.

The 256-bit encryption key is sourced in priority order:

1. **OS keychain** (via `keytar`) — the key is stored in the system credential manager (macOS Keychain, GNOME Keyring, Windows Credential Vault). This keeps the key out of the filesystem entirely.
2. **File-based fallback** — if the OS keychain is unavailable, a random key is generated and written to `~/.402-mcp/encryption.key` with `0o600` permissions (owner read/write only). A warning is emitted at startup: the credentials are encrypted but the key is accessible to anyone with file access.

The credential store directory is created with `0o700` permissions. Writes use an atomic rename pattern (write to `.tmp`, then `renameSync`) to prevent data loss on crash. Legacy plaintext credential files are automatically migrated to encrypted format on first load.

### Preimage validation

Before any credential is stored, the preimage is validated:

- Must be a non-empty string containing only hexadecimal characters (`[0-9a-fA-F]`).
- Must be exactly 64 hex characters (32 bytes — the size of a SHA-256 preimage).
- Macaroons are validated against a base64-safe character set (`[A-Za-z0-9+/_\-=]`).

These checks prevent header injection attacks, since preimages and macaroons are sent raw in `Authorization: L402 {macaroon}:{preimage}` headers.

## HTTP transport hardening

When running in HTTP mode (`TRANSPORT=http`), the server applies several layers of defence:

- **Loopback-only binding** — the server binds to `127.0.0.1` by default. A warning is emitted if `BIND_ADDRESS` is changed to a non-loopback address.
- **Rate limiting** — a sliding-window rate limiter allows 100 requests per 60 seconds per IP address. The bucket map is capped at 10,000 entries and stale buckets are evicted every 60 seconds to prevent memory exhaustion from IP cycling.
- **Security headers** — every response includes:
  - `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`
  - `X-Frame-Options: DENY`
  - `X-Content-Type-Options: nosniff`
  - `Cache-Control: no-store`
- **Request size limit** — the JSON body parser caps input at 100 KB.
- **Trust proxy disabled** — `trust proxy` is set to `false` to prevent `X-Forwarded-For` spoofing of the rate limiter.
- **CORS control** — `CORS_ORIGIN` defaults to disabled. A warning is emitted if set to `*` (wildcard), which would allow any website to make cross-origin requests.
- **TLS enforcement** — a warning is emitted if `NODE_TLS_REJECT_UNAUTHORIZED=0` is detected, as this disables certificate validation and re-enables HTTPS DNS rebinding attacks.

## Fetch resilience

All outbound HTTP uses the resilient fetch wrapper (`src/fetch/resilient-fetch.ts`), which provides:

- **Timeout** — configurable per-request timeout (default 30 seconds) enforced via `AbortController`. The timeout is applied per redirect hop, and a cumulative timer across the entire redirect chain prevents a malicious server from stalling each hop for the full timeout.
- **Retry with backoff** — configurable retry count (default 2 retries) with exponential backoff and jitter. Server errors (5xx) are retried by default. SSRF errors are never retried.
- **Retry disabled for money-mutating requests** — POST requests that involve payments pass `{ retries: 0 }` to prevent double-spend from retried payment submissions. Polling fetches (e.g. human-in-the-loop payment polling) also disable retry because the poll loop handles transience.
- **Redirect limits** — a maximum of 5 redirects are followed. Each redirect target is SSRF-validated independently.
- **HTTPS downgrade protection** — redirects from HTTPS to HTTP are blocked with a `DowngradeError`.
- **Response size limits** — configurable maximum response body size (default 10 MB). Responses exceeding the limit are terminated early via stream cancellation. The `Content-Length` header is checked first for fast rejection before streaming.

## Input validation

- **Preimage hex validation** — preimages are validated as strict hex before storage (see Credential encryption above).
- **Macaroon base64 validation** — macaroons are validated against a base64-safe character set before storage.
- **Blocked hop-by-hop headers** — user-supplied headers on `l402-fetch` are filtered against a blocklist of hop-by-hop and security-sensitive headers (`host`, `transfer-encoding`, `connection`, `upgrade`, `proxy-authorization`, `te`, `trailer`) to prevent request smuggling.
- **Zod schema validation** — all MCP tool inputs are validated with Zod schemas at the tool registration layer, rejecting malformed or unexpected input before any handler logic executes.
- **Path traversal prevention** — `CREDENTIAL_STORE` and `CASHU_TOKENS` paths are validated to ensure they resolve within the user's home directory.
- **NWC URI scrubbing** — the `NWC_URI` environment variable is deleted from `process.env` immediately after reading to prevent accidental exposure via process inspection or child processes.

## Reporting vulnerabilities

If you find a security issue, please report it privately via GitHub Security Advisories on the [402-mcp repository](https://github.com/forgesworn/402-mcp).
