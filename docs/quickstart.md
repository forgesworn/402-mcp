# Quickstart

Get 402-mcp running and make your first paid API call in under 5 minutes.

## 1. Install

```bash
npx 402-mcp
```

You should see the MCP server start. Press Ctrl+C to stop it; your MCP client will manage the process. Node.js 22.4 or newer is required.

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

The agent will query Nostr relays for kind 31402 service announcements and return a list of live paid APIs, URLs, pricing, and capabilities. No wallet, no cost. This is just discovery.

Try other searches too, `l402-search("AI inference")` will find [satgate](https://github.com/TheCryptoDonkey/satgate) (pay-per-token AI inference) and any other services announcing on Nostr.

## 4. Set up a wallet

To make paid calls, you need a payment method. Pick one:

<details>
<summary>NWC: Nostr Wallet Connect (recommended)</summary>

The fastest path to fully autonomous payments. Your agent pays from your Lightning wallet without asking.

1. Use any wallet service that supports NIP-47 Nostr Wallet Connect with NIP-44 v2 encryption.
2. Create a connection in that wallet with `pay_invoice` permission and a spending budget. Adding `lookup_invoice` lets `l402-reconcile` ask the wallet about payments whose outcome is unknown.
3. Create a private file for the URI. Make it owner-only before the secret goes in, and paste the URI with an editor rather than `echo`, so it stays out of shell history:

   ```bash
   mkdir -p ~/.402-mcp
   touch ~/.402-mcp/wallet.nwc
   chmod 600 ~/.402-mcp/wallet.nwc
   # open ~/.402-mcp/wallet.nwc in an editor, paste the URI on one line, save
   ```

   The URI looks like `nostr+walletconnect://<wallet-pubkey-hex>?relay=<wss-relay-url>&secret=<secret-hex>`: a 64-character hex wallet pubkey and secret, one to eight `relay` values, an optional `lud16`, and no other parameters. 402-mcp refuses a file that is empty, larger than 8 KiB, not a regular file, or (on macOS and Linux) readable by group or others.
4. Pass only that file's absolute path to 402-mcp:

**Claude Code:**
```bash
claude mcp remove 402-mcp
claude mcp add 402-mcp -e NWC_URI_FILE="$HOME/.402-mcp/wallet.nwc" -e MAX_AUTO_PAY_SATS=1000 -- npx 402-mcp
```

**Claude Desktop / Cursor:** Add the `env` block to your config:
```json
{
  "mcpServers": {
    "l402": {
      "command": "npx",
      "args": ["402-mcp"],
      "env": {
        "NWC_URI_FILE": "/absolute/path/to/wallet.nwc",
        "MAX_AUTO_PAY_SATS": "1000"
      }
    }
  }
}
```

`MAX_AUTO_PAY_SATS` caps any single payment. 402-mcp will not pay anything dearer from a configured wallet: the price and invoice go back to the agent, which should ask you. Whether it asks is up to the agent; 402-mcp does not enforce that. Below the cap, a payment the agent makes with `autoPay` is not put to you first; set a budget on the NWC connection in your wallet as the hard limit.
Raw `NWC_URI` values are refused so the bearer credential cannot leak through a
process environment or MCP configuration.

</details>

<details>
<summary>Cashu: ecash tokens</summary>

If you have Cashu tokens, point 402-mcp at your token file:

**Claude Code:**
```bash
claude mcp remove 402-mcp
claude mcp add 402-mcp -e CASHU_TOKENS="/path/to/tokens.json" -- npx 402-mcp
```

The agent melts tokens to pay invoices, fully autonomous, no Lightning node needed.

</details>

<details>
<summary>No wallet: human-in-the-loop</summary>

No setup needed. The human payer is used only when no other payer (NWC, Cashu or LNURLcash) is available. When the agent calls `l402-fetch` with `autoPay`, it does not wait: it returns a payment page link for toll-booth servers, or a Lightning invoice as a QR code. Pay it with any Lightning wallet (Phoenix, Strike, Cash App, etc.). The agent then calls `l402-pay`, which polls for settlement and carries on. That confirmation needs the server to report settlement, which toll-booth does through its payment page; other L402 servers do not, so without a wallet this flow works fully only with toll-booth.

</details>

## 5. Make a paid API call

Now ask your agent:

> "Get me a joke from sats-for-laughs using the l402 tools"

Watch what happens:

1. The agent discovers the endpoint and its pricing
2. It checks your spend limits via `l402-config`
3. It calls `l402-fetch` with `autoPay: true`, and 402-mcp pays the invoice automatically (or shows you a QR). Without `autoPay` nothing is paid: the price and a `paymentHash` come back instead
4. The joke comes back, and the credential is cached for future requests

That's it. Your AI agent just paid for an API call autonomously.

## What's next

- **More APIs**: try [satgate](https://github.com/TheCryptoDonkey/satgate) for pay-per-token AI inference
- **Tool reference**: see the full [tool list](../README.md#tools) in the README
- **Architecture**: detailed diagrams in [docs/architecture.md](./architecture.md)
- **Security**: spend safety, SSRF protection, encryption in [docs/security.md](./security.md)
- **Contributing**: development setup and guidelines in [CONTRIBUTING.md](../CONTRIBUTING.md)

## Troubleshooting

**Service unavailable?** Use `l402-search` to find other live services, the Nostr relay network has a growing catalogue.

**Payment failed?** Check your wallet balance and that the NWC URI in your file is correct. Try `l402-config` to verify your payment methods are detected. Only the first available payer is tried (NWC, then Cashu, then LNURLcash, then human), so a failure is reported rather than retried with another; pass `method` to `l402-pay` to choose one.

**Want to see what's stored?** Use `l402-credentials` to list cached credentials and `l402-balance` to check remaining credits.
