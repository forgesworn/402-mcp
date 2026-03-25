import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export interface StoreTokenDeps {
  storeCredential: (origin: string, macaroon: string, preimage: string, paymentHash: string, server: 'toll-booth' | null) => boolean
}

/** Parses and stores an L402 token (macaroon:preimage) for a given origin. */
export function handleStoreToken(
  args: { url: string; token: string },
  deps: StoreTokenDeps,
) {
  const origin = (() => { try { return new URL(args.url).origin } catch { return '' } })()
  if (!origin) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Invalid URL' }) }],
      isError: true as const,
    }
  }

  // Token format: macaroon:preimage (preimage is last 64 hex chars after final colon)
  const lastColon = args.token.lastIndexOf(':')
  if (lastColon === -1) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Invalid token format — expected macaroon:preimage' }) }],
      isError: true as const,
    }
  }

  const macaroon = args.token.slice(0, lastColon)
  const preimage = args.token.slice(lastColon + 1)

  // Extract payment hash from macaroon identifier if possible
  // Toll-booth macaroons encode the payment hash as the identifier (first caveat)
  let paymentHash = ''
  try {
    const decoded = Buffer.from(macaroon, 'base64')
    const text = decoded.toString('utf8')
    const hashMatch = text.match(/payment_hash = ([0-9a-f]{64})/)
    if (hashMatch) paymentHash = hashMatch[1]
  } catch {
    // Can't extract — leave empty
  }

  const stored = deps.storeCredential(origin, macaroon, preimage, paymentHash, 'toll-booth')

  if (!stored) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Token validation failed — check macaroon and preimage format' }) }],
      isError: true as const,
    }
  }

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        stored: true,
        origin,
        paymentHash: paymentHash || undefined,
      }, null, 2),
    }],
  }
}

/** Registers the l402-store-token tool with the MCP server. */
export function registerStoreTokenTool(server: McpServer, deps: StoreTokenDeps): void {
  server.registerTool(
    'l402-store-token',
    {
      description: 'Store an L402 token (macaroon:preimage) obtained from a payment page. Use this when a user pastes back a token from a toll-booth payment page. The token is stored as a credential so subsequent l402-fetch calls are authenticated.',
      annotations: { readOnlyHint: false, idempotentHint: true },
      inputSchema: {
        url: z.url().describe('The service URL this token is for'),
        token: z.string().min(10).max(30_000).describe('The L402 token in macaroon:preimage format'),
      },
    },
    (args) => handleStoreToken(args, deps),
  )
}
