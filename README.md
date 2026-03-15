# 402-mcp

[![MIT licence](https://img.shields.io/badge/licence-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%3E%3D18-green)](https://nodejs.org/)
[![Nostr](https://img.shields.io/badge/Nostr-Zap%20me-purple)](https://primal.net/p/npub1mgvlrnf5hm9yf0n5mf9nqmvarhvxkc6remu5ec3vf8r0txqkuk7su0e7q2)

L402 + x402 client MCP that gives AI agents economic agency. Discover, pay for, and consume any payment-gated API - no human registration, no API keys, no middlemen.

Works with **any L402-compliant server** (toll-booth, Aperture, or any future implementation), with bonus features when talking to a [toll-booth](https://github.com/TheCryptoDonkey/toll-booth) instance.

## Why 402-mcp?

The L402 ecosystem is growing fast - Lightning Labs' [lightning-agent-tools](https://github.com/lightninglabs/lightning-agent-tools), Coinbase's x402, and others. 402-mcp is the **payment-rail agnostic** alternative:

| | 402-mcp | Lightning Labs agent tools |
|---|---|---|
| **Payment rails** | NWC + Cashu + human fallback | Lightning only |
| **Node required?** | No — connects to any NWC wallet | Yes — runs LND |
| **Server compatibility** | Any L402 server | Aperture-focused |
| **Spend safety** | Per-payment cap + rolling 60s window | Per-call max-cost |
| **Credential storage** | Encrypted at rest (AES-256-GCM) | File permissions |
| **Privacy** | No PII, SSRF protection, error sanitisation | Standard |

Use Lightning Labs' tools if you want agents that **run their own Lightning node**. Use 402-mcp if you want agents that **pay from any wallet without infrastructure**.

## Quick start

```bash
npx 402-mcp
```

### Claude Desktop / Cursor

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "l402": {
      "command": "npx",
      "args": ["402-mcp"],
      "env": {
        "NWC_URI": "nostr+walletconnect://...",
        "MAX_AUTO_PAY_SATS": "1000"
      }
    }
  }
}
```

See [examples/](./examples/) for more configuration samples.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NWC_URI` | - | Nostr Wallet Connect URI for autonomous Lightning payments |
| `CASHU_TOKENS` | - | Path to Cashu token store file |
| `MAX_AUTO_PAY_SATS` | 1000 | Safety cap; payments above this require human confirmation |
| `CREDENTIAL_STORE` | `~/.402-mcp/credentials.json` | Persistent macaroon/credential storage |
| `TRANSPORT` | `stdio` | Transport mode: `stdio` or `http` |
| `PORT` | 3402 | HTTP server port (when `TRANSPORT=http`) |

## Tools

### Core L402 (any server)

| Tool | Description |
|------|-------------|
| `l402_config` | Introspect payment capabilities (wallets, limits, credential count) |
| `l402_discover` | Probe an endpoint to discover pricing without paying |
| `l402_fetch` | HTTP request with L402 support; auto-pays if within budget |
| `l402_pay` | Pay a specific invoice (NWC, Cashu, or human-in-the-loop) |
| `l402_credentials` | List stored credentials and cached balances |
| `l402_balance` | Check cached credit balance for a server |
| `l402_search` | Discover L402 services on Nostr relays (kind 31402 announcements) |

### toll-booth extensions

| Tool | Description |
|------|-------------|
| `l402_buy_credits` | Browse and purchase volume discount tiers |
| `l402_redeem_cashu` | Redeem Cashu tokens directly (avoids Lightning round-trip) |

## How it works

```mermaid
graph LR
    A["1. l402_config()"] --> B["2. l402_discover(url)"]
    B --> C["3. Agent reasons<br/>about pricing"]
    C --> D["4. l402_buy_credits()<br/>or l402_fetch()"]
    D --> E["5. l402_fetch(url)<br/>with credentials"]
    E --> F["6. Data returned<br/>+ balance cached"]
```

**Example session:**

```
Agent: "I need routing data from routing.trotters.cc"

1. l402_config()
   -> nwcConfigured: true, maxAutoPaySats: 1000

2. l402_discover("https://routing.trotters.cc/api/route")
   -> 10 sats/request, toll-booth detected, tiers available

3. Agent reasons: "I need ~20 requests. The 500-sat tier
   gives 555 credits. Better value."

4. l402_buy_credits(url, amountSats=500)
   -> Paid 500 sats, received 555 credits

5. l402_fetch("https://routing.trotters.cc/api/route?from=...&to=...")
   -> 200 OK, route data, 545 credits remaining
```

## Service discovery

Agents can discover paid APIs without knowing URLs upfront. `l402_search` queries Nostr relays for kind 31402 service announcements — the decentralised registry for L402 services.

```mermaid
sequenceDiagram
    participant Agent as AI Agent
    participant MCP as 402-mcp
    participant Relay as Nostr Relays

    Agent->>MCP: l402_search("routing")
    MCP->>Relay: Subscribe kind 31402
    Relay-->>MCP: Matching service events
    MCP-->>Agent: Services with URLs, pricing, capabilities
    Agent->>MCP: l402_discover(service_url)
    Note over Agent: Continue with payment flow...
```

## Payment methods

```mermaid
graph TD
    Pay["Pay Invoice"]
    Pay --> NWC{"NWC configured?"}
    NWC -->|Yes| NWCPay["Pay via Lightning wallet<br/>(fully autonomous)"]
    NWC -->|No| CashuQ{"Cashu tokens<br/>available?"}
    CashuQ -->|Yes| CashuPay["Melt ecash tokens<br/>(fully autonomous)"]
    CashuQ -->|No| HumanPay["Present QR code<br/>(human pays)"]
```

Three payment rails, tried in priority order:

1. **NWC** (Nostr Wallet Connect) - fully autonomous; pays from your connected wallet
2. **Cashu** - fully autonomous; melts ecash tokens to pay invoices
3. **Human-in-the-loop** - presents QR code, polls for settlement

The agent can override the method per-call, or you can configure only the methods you want.

## Safety

`MAX_AUTO_PAY_SATS` caps any single autonomous payment. Above this limit, the agent must ask the human for approval. The agent can read this limit via `l402_config` and factor it into purchasing decisions.

## Privacy

402-mcp stores credentials locally on your machine only (`~/.402-mcp/credentials.json`, encrypted at rest). No data is sent to any third party. No accounts, no tracking, no analytics. Payments use Lightning or Cashu - pseudonymous by design.

## Architecture

```mermaid
graph TB
    Agent["AI Agent<br/>(Claude, Cursor, etc.)"]
    MCP["402-mcp<br/>MCP Server"]

    subgraph Wallets["Payment Rails"]
        NWC["NWC<br/>(Lightning)"]
        Cashu["Cashu<br/>(Ecash)"]
        Human["Human-in-the-loop<br/>(QR code)"]
    end

    subgraph Storage["Local Storage"]
        Creds["Credential Store<br/>(AES-256-GCM)"]
        Tokens["Cashu Token Store"]
    end

    subgraph Servers["Any L402 Server"]
        TB["toll-booth"]
        Aperture["Aperture"]
        Other["Any L402<br/>implementation"]
    end

    Nostr["Nostr Relays<br/>(Service Discovery)"]

    Agent <-->|"MCP protocol<br/>(stdio / HTTP)"| MCP
    MCP --> NWC
    MCP --> Cashu
    MCP --> Human
    MCP <--> Creds
    MCP <--> Tokens
    MCP <-->|"HTTP + L402"| TB
    MCP <-->|"HTTP + L402"| Aperture
    MCP <-->|"HTTP + L402"| Other
    MCP <-->|"kind 31402"| Nostr
```

## Payment flow

```mermaid
sequenceDiagram
    participant Agent as AI Agent
    participant MCP as 402-mcp
    participant API as L402 API
    participant Wallet as Wallet (NWC/Cashu)

    Agent->>MCP: l402_discover(url)
    MCP->>API: GET /endpoint
    API-->>MCP: 402 + invoice + macaroon
    MCP-->>Agent: price: 10 sats, server: toll-booth

    Agent->>Agent: Reason about pricing

    Agent->>MCP: l402_fetch(url)
    MCP->>API: GET /endpoint
    API-->>MCP: 402 + invoice + macaroon
    MCP->>MCP: Amount ≤ MAX_AUTO_PAY_SATS?
    MCP->>Wallet: Pay invoice
    Wallet-->>MCP: preimage
    MCP->>MCP: Store credential
    MCP->>API: GET /endpoint + Authorization: L402
    API-->>MCP: 200 OK + data
    MCP-->>Agent: Response data + balance
```

## Ecosystem

| Project | Role |
|---------|------|
| [toll-booth](https://github.com/TheCryptoDonkey/toll-booth) | Payment-rail agnostic HTTP 402 middleware |
| [satgate](https://github.com/TheCryptoDonkey/satgate) | Pay-per-token AI inference proxy (built on toll-booth) |
| **[402-mcp](https://github.com/TheCryptoDonkey/402-mcp)** | **MCP client — AI agents discover, pay, and consume L402 + x402 APIs** |
| [402-announce](https://github.com/TheCryptoDonkey/402-announce) | Publish L402 services on Nostr for decentralised discovery |

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and guidelines.

---

Built by [@TheCryptoDonkey](https://github.com/TheCryptoDonkey).

- Lightning tips: `thedonkey@strike.me`
- Nostr: `npub1mgvlrnf5hm9yf0n5mf9nqmvarhvxkc6remu5ec3vf8r0txqkuk7su0e7q2`

---

## Licence

[MIT](LICENSE)
