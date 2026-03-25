# Architecture

Technical reference diagrams for 402-mcp. For a quick overview, see the [README](../README.md).

## System architecture

How 402-mcp connects AI agents to paid APIs via multiple payment rails.

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

The full lifecycle: discover pricing, pay the invoice, store the credential, fetch the data.

```mermaid
sequenceDiagram
    participant Agent as AI Agent
    participant MCP as 402-mcp
    participant API as L402 API
    participant Wallet as Wallet (NWC/Cashu)

    Agent->>MCP: l402-discover(url)
    MCP->>API: GET /endpoint
    API-->>MCP: 402 + invoice + macaroon
    MCP-->>Agent: price: 10 sats, server: toll-booth

    Agent->>Agent: Reason about pricing

    Agent->>MCP: l402-fetch(url)
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

Agents discover paid APIs without knowing URLs upfront. `l402-search` queries Nostr relays for kind 31402 service announcements — the decentralised registry for L402 services.

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

402-mcp tries payment methods in priority order, falling back automatically.

```mermaid
graph TD
    Pay["Pay Invoice"]
    Pay --> NWC{"NWC configured?"}
    NWC -->|Yes| NWCPay["Pay via Lightning wallet<br/>(fully autonomous)"]
    NWC -->|No| CashuQ{"Cashu tokens<br/>available?"}
    CashuQ -->|Yes| CashuPay["Melt ecash tokens<br/>(fully autonomous)"]
    CashuQ -->|No| HumanPay["Present QR code<br/>(human pays)"]
```
