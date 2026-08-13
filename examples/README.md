# 402-mcp examples

## Configuration examples

### Claude Desktop / Cursor

Create a private file containing your Nostr Wallet Connect URI, run
`chmod 600 /absolute/path/to/402-mcp.nwc`, then copy
`claude-desktop-config.json` into your MCP client configuration and replace the
example `NWC_URI_FILE` path.

### HTTP transport

For network access (e.g. remote agents or multi-client setups):

```bash
TRANSPORT=http PORT=3402 NWC_URI_FILE="/run/secrets/402-mcp.nwc" npx 402-mcp
```

## Typical agent workflow

An AI agent using 402-mcp follows this pattern:

```
1. l402-config()
   → Check what payment methods are available and the spending limits

2. l402-search("weather data")
   → Discover L402 services on Nostr relays matching "weather data"
   → Returns service URLs, pricing, and capabilities

3. l402-discover("https://api.example.com/weather")
   → Probe the endpoint: 5 sats/request, toll-booth server detected

4. l402-buy-credits("https://api.example.com/weather", 100)
   → Buy 100 sats of credits (toll-booth returns 110 credits at this tier)

5. l402-fetch("https://api.example.com/weather?city=London")
   → 200 OK, weather data returned, 109 credits remaining

6. l402-balance("https://api.example.com/weather")
   → 109 credits remaining (no network request needed)
```

## Payment method priority

402-mcp tries payment methods in this order:

1. **NWC** — if `NWC_URI_FILE` points to a private bearer file, pays via Lightning wallet (fully autonomous)
2. **Cashu** — if `CASHU_TOKENS` points to a token file, melts ecash (fully autonomous)
3. **Human-in-the-loop** — presents a QR code and polls for settlement

Configure only the methods you want available. If you only set `NWC_URI_FILE`, Cashu and human fallback are skipped.
