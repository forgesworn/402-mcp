# Architecture

Technical reference diagrams for 402-mcp. For a quick overview, see the [README](../README.md).

## System architecture

How 402-mcp connects AI agents to paid APIs using several payer methods.

```mermaid
graph TB
    Agent["AI Agent<br/>(Claude, Cursor, etc.)"]
    MCP["402-mcp<br/>MCP Server"]

    subgraph Wallets["Payer Methods"]
        NWC["NWC<br/>(Lightning)"]
        Cashu["Cashu<br/>(Ecash)"]
        LNURLcash["LNURLcash<br/>(Bearer notes)"]
        Human["Human-in-the-loop<br/>(QR code)"]
    end

    subgraph Storage["Local Storage"]
        Creds["Credential Store<br/>(AES-256-GCM)"]
        Tokens["Cashu Token Store"]
        Notes["LNURLcash Note Store"]
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
    MCP --> LNURLcash
    MCP --> Human
    MCP <--> Creds
    MCP <--> Tokens
    MCP <--> Notes
    MCP <-->|"HTTP + L402"| TB
    MCP <-->|"HTTP + L402"| Aperture
    MCP <-->|"HTTP + L402"| Other
    MCP <-->|"kind 31402"| Nostr
```

## Payment flow

The full lifecycle: discover pricing, pay the invoice, store the credential, fetch the data.

```mermaid
sequenceDiagram
    participant Agent as AI Agent
    participant MCP as 402-mcp
    participant API as L402 API
    participant Wallet as Payer (NWC/Cashu/LNURLcash)

    Agent->>MCP: l402-discover(url)
    MCP->>API: GET /endpoint
    API-->>MCP: 402 + invoice + macaroon
    MCP-->>Agent: price: 10 sats, server: toll-booth

    Agent->>Agent: Reason about pricing

    Agent->>MCP: l402-fetch(url, autoPay: true)
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

## Service discovery

Agents discover paid APIs without knowing URLs upfront. `l402-search` queries Nostr relays for kind 31402 service announcements, the decentralised registry for L402 services.

```mermaid
sequenceDiagram
    participant Agent as AI Agent
    participant MCP as 402-mcp
    participant Relay as Nostr Relays

    Agent->>MCP: l402-search("routing")
    MCP->>Relay: Subscribe kind 31402
    Relay-->>MCP: Matching service events
    MCP-->>Agent: Services with URLs, pricing, capabilities
    Agent->>MCP: l402-discover(service_url)
    Note over Agent: Continue with payment flow...
```

## Payment method selection

For a Lightning invoice, 402-mcp picks the first available payer in this order. Only that one is tried: if its payment fails, the failure is reported and the next payer is not used. `l402-pay` and `l402-buy-credits` can choose a payer with their `method` argument; `l402-fetch` cannot.

```mermaid
graph TD
    Pay["Pay Invoice"]
    Pay --> NWC{"NWC configured?"}
    NWC -->|Yes| NWCPay["Pay via Lightning wallet<br/>(fully autonomous)"]
    NWC -->|No| CashuQ{"Cashu store<br/>has a balance?"}
    CashuQ -->|Yes| CashuPay["Melt ecash tokens<br/>(fully autonomous)"]
    CashuQ -->|No| NoteQ{"LNURLcash store<br/>has a balance?"}
    NoteQ -->|Yes| NotePay["Melt bearer notes<br/>(fully autonomous)"]
    NoteQ -->|No| HumanPay["Return payment page or QR code<br/>(human pays, then l402-pay polls)"]
```

## Challenge selection

The payer order above applies to Lightning invoices only. `l402-fetch` first looks at which challenge the server sent, and checks them in this order: `X-LNURLcash`, `X-Cashu`, `X-Payment-Required: x402`, `WWW-Authenticate: Payment`, then `WWW-Authenticate: L402`. An LNURLcash note or an xCashu token is paid straight from its own store and does not go through the payer order. If no note covers an LNURLcash price, the later challenges in the same response are tried. x402 payment details are shown to the human and never paid autonomously.
