# Regulatory Compliance Guidance

*This document is reference guidance — not legal advice. Consult qualified legal counsel before making compliance decisions.*

## Client-Side Software Classification

402-mcp is a local MCP server that runs entirely on the user's own machine. It enables AI agents to discover and pay for L402-gated APIs, but it never receives, holds, or transmits funds on behalf of anyone else. Payment is delegated to the user's own wallet via one of three mechanisms:

| Payment method | How it works |
|----------------|-------------|
| **NWC (Nostr Wallet Connect)** | The agent sends a payment request to the user's own Lightning wallet via NIP-47. The wallet — not 402-mcp — signs and broadcasts the payment. |
| **Cashu token file** | The agent melts ecash tokens from a local file at the user's configured mint. See [Cashu Tokens](#cashu-tokens) below. |
| **Manual QR payment** | The agent displays a Lightning invoice and polls until the user pays it from any wallet they choose. |

In all three cases, 402-mcp acts as a user-side tool — analogous to a browser with a wallet extension. It helps the user pay, but it does not accept value from others, pool funds, or intermediate payments between parties.

### Regulatory position

- **Not a payment service.** 402-mcp does not initiate payments on behalf of third parties. It initiates payments on behalf of its own operator — the user who installed and configured it.
- **Not a money transmitter.** Under FinCEN guidance FIN-2019-G001, client-side software that does not accept and transmit value is not a money services business. 402-mcp fits squarely within this exclusion: it sends payment instructions to the user's own wallet, which independently decides whether to execute them.
- **Not regulated under UK PSR 2017.** The Payment Services Regulations 2017 regulate entities that hold funds or initiate payments on behalf of others. 402-mcp does neither — it is local software operating under the user's direct control.
- **Not a CASP under EU MiCA.** The Markets in Crypto-Assets Regulation defines Crypto-Asset Service Providers as entities that provide custody, exchange, transfer, or advisory services on behalf of clients. 402-mcp provides none of these — it is a local tool that the user runs for their own benefit.

### Honest caveats

- Regulatory classification depends on jurisdiction and on the specific facts of deployment. An operator who modifies 402-mcp to pool funds, accept deposits, or intermediate payments between parties may cross into regulated territory.
- The NWC payment method grants 402-mcp the technical ability to instruct the user's wallet to pay invoices up to the configured spend caps. Whether this constitutes "control" over funds in a regulatory sense is jurisdiction-dependent.

## Data Handling and Privacy

All data is stored locally on the user's machine. 402-mcp has no server-side component, no accounts, no analytics, and no tracking. Nothing is sent to third parties.

### Local storage

| Data | Location | Protection |
|------|----------|-----------|
| Credentials (macaroons, preimages) | `~/.402-mcp/credentials.json` | AES-256-GCM encryption at rest |
| Cashu tokens | User-configured path | Plaintext JSON file |
| Encryption key | OS keychain (preferred) or `~/.402-mcp/encryption.key` (fallback, `0o600`) | OS credential manager or filesystem permissions |
| Spend tracking | In-memory only | Not persisted across sessions |

### Credential lifecycle

- **Encryption at rest.** Credentials are encrypted with AES-256-GCM using a random 12-byte IV per operation. The encryption key is stored in the OS keychain where available (macOS Keychain, GNOME Keyring, Windows Credential Vault). A file-based fallback is used when the keychain is unavailable, with a warning emitted at startup.
- **7-day auto-expiry.** Credentials older than 7 days are automatically purged. The TTL is enforced on every read and via periodic cleanup.
- **File-only NWC authority.** Raw `NWC_URI` values are deleted and refused.
  `NWC_URI_FILE` must point to a bounded private regular `0600` file. The URI
  grants spending authority over the user's wallet and is never accepted in an
  MCP argument, command line, registry password field, or raw environment value.
- **Safe listing.** The `listSafe()` API never exposes macaroons or preimages in tool responses. Only metadata (host, path, expiry) is surfaced.

### Privacy

- **No personal data collection.** 402-mcp does not process personal data beyond what the user stores locally on their own machine.
- **No server-side storage.** There is no backend, no database, no cloud component.
- **GDPR.** Data subject requests (access, erasure, portability) are not applicable in the traditional sense — the user has direct filesystem access to all data 402-mcp creates. Deleting `~/.402-mcp/` removes everything.
- **No data sent to third parties.** The only outbound network traffic is to the L402/x402 API endpoints the user explicitly asks the agent to call, and to the user's own wallet (via NWC relay or Cashu mint).

See [`docs/security.md`](docs/security.md) for full details on encryption implementation, SSRF protection, and input validation.

## Cashu Tokens

When configured with a Cashu token file (`CASHU_TOKENS`), the agent holds ecash tokens in a local file and melts them at mints to pay Lightning invoices. This is standard ecash client behaviour — equivalent to spending cash from a physical wallet.

### Client vs. mint distinction

402-mcp is a Cashu **client**, not a mint. It does not issue tokens, does not accept deposits, and does not redeem tokens for others. The primary regulatory risk in the Cashu chain sits with the **mint operator**, who issues bearer ecash tokens and redeems them on demand.

### Regulatory considerations for Cashu mints

Cashu mints issue bearer ecash tokens that may be classified as **Electronic Money Tokens (EMTs)** under EU MiCA, requiring authorisation as an Electronic Money Institution (EMI) or credit institution. The MiCA transition deadline for existing service providers is **1 July 2026**. 402-mcp users should be aware that the mint they interact with may or may not be operating under an appropriate regulatory framework.

### Spend safeguards

402-mcp enforces spend caps that provide consumer-protection-style safeguards against runaway autonomous spending:

| Cap | Default | Purpose |
|-----|---------|---------|
| `MAX_AUTO_PAY_SATS` | 1000 sats | Per-request ceiling — payments above this require human approval |
| `MAX_SPEND_PER_MINUTE_SATS` | 10000 sats | Rolling 60-second window — prevents rapid successive payments from exceeding a total budget |

Both caps are enforced atomically via `SpendTracker.tryRecord()` to prevent TOCTOU race conditions. Definitely rejected payments release their reservation. A timeout, abort, publication failure, malformed response, or invalid settlement proof retains it and returns an unknown payment state that must be reconciled before retrying.

---

For encryption, SSRF protection, and transport hardening details, see [`docs/security.md`](docs/security.md).

For the server-side perspective, see [toll-booth REGULATORY.md](https://github.com/forgesworn/toll-booth/blob/main/REGULATORY.md).
