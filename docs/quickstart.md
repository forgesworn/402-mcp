# Quickstart

Get 402-mcp running and make your first paid API call in under 5 minutes.

## 1. Install

```bash
npx 402-mcp
```

You should see the MCP server start. Press Ctrl+C to stop it — your MCP client will manage the process.

## 2. Connect to your MCP client

### Claude Code

One command:

```bash
claude mcp add 402-mcp -- npx 402-mcp
```

Done. 402-mcp is now available in your Claude Code sessions.

<details>
<summary>Claude Desktop</summary>

Add to your Claude Desktop MCP configuration (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "l402": {
      "command": "npx",
      "args": ["402-mcp"]
    }
  }
}
```

Restart Claude Desktop to pick up the change.

</details>

<details>
<summary>Cursor</summary>

Add the same JSON block to your Cursor MCP configuration. See [Cursor MCP docs](https://docs.cursor.com/context/model-context-protocol) for the config file location.

</details>

## 3. Discover paid APIs (no wallet needed)

Ask your AI agent:

> "Search for paid joke APIs using l402-search"

The agent will query Nostr relays for kind 31402 service announcements and return a list of live paid APIs — URLs, pricing, and capabilities. No wallet, no cost. This is just discovery.

Try other searches too — `l402-search("AI inference")` will find [satgate](https://github.com/forgesworn/satgate) (pay-per-token AI inference) and any other services announcing on Nostr.

## 4. Set up a wallet

To make paid calls, you need a payment method. Pick one:

<details>
<summary>NWC — Nostr Wallet Connect (recommended)</summary>

The fastest path to fully autonomous payments. Your agent pays from your Lightning wallet without asking.

1. Use a wallet that supports NWC (e.g. [Alby](https://getalby.com/))
2. Generate an NWC connection URI from your wallet
3. Add it to your MCP config:

**Claude Code:**
```bash
claude mcp remove 402-mcp
claude mcp add 402-mcp -e NWC_URI="nostr+walletconnect://..." -e MAX_AUTO_PAY_SATS=1000 -- npx 402-mcp
```

**Claude Desktop / Cursor:** Add the `env` block to your config:
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

`MAX_AUTO_PAY_SATS` caps any single payment. Above this, the agent asks you first.

</details>

<details>
<summary>Cashu — ecash tokens</summary>

If you have Cashu tokens, point 402-mcp at your token file:

**Claude Code:**
```bash
claude mcp remove 402-mcp
claude mcp add 402-mcp -e CASHU_TOKENS="/path/to/tokens.json" -- npx 402-mcp
```

The agent melts tokens to pay invoices — fully autonomous, no Lightning node needed.

</details>

<details>
<summary>No wallet — human-in-the-loop</summary>

No setup needed. When the agent needs to pay, it presents a Lightning invoice with a QR code. Scan it with any Lightning wallet (Phoenix, Strike, Cash App, etc.) and the agent continues automatically once payment settles.

</details>

## 5. Make a paid API call

Now ask your agent:

> "Get me a joke from sats-for-laughs using the l402 tools"

Watch what happens:

1. The agent discovers the endpoint and its pricing
2. It checks your spend limits via `l402-config`
3. It calls `l402-fetch` — 402-mcp pays the invoice automatically (or shows you a QR)
4. The joke comes back, and the credential is cached for future requests

That's it. Your AI agent just paid for an API call autonomously.

## What's next

- **More APIs** — try [satgate](https://github.com/forgesworn/satgate) for pay-per-token AI inference
- **Tool reference** — see the full [tool list](../README.md#tools) in the README
- **Architecture** — detailed diagrams in [docs/architecture.md](./architecture.md)
- **Security** — spend safety, SSRF protection, encryption in [docs/security.md](./security.md)
- **Contributing** — development setup and guidelines in [CONTRIBUTING.md](../CONTRIBUTING.md)

## Troubleshooting

**Service unavailable?** Use `l402-search` to find other live services — the Nostr relay network has a growing catalogue.

**Payment failed?** Check your wallet balance and that your NWC URI is correct. Try `l402-config` to verify your payment methods are detected.

**Want to see what's stored?** Use `l402-credentials` to list cached credentials and `l402-balance` to check remaining credits.
