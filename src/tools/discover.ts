import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { parseL402Challenge } from '../l402/parse.js'
import { detectServer } from '../l402/detect.js'
import type { ChallengeCache } from '../l402/challenge-cache.js'
import type { DecodedInvoice } from '../l402/bolt11.js'
import type { ResilientFetchOptions } from '../fetch/resilient-fetch.js'
import { safeErrorMessage } from './safe-error.js'

export interface DiscoverDeps {
  fetchFn: (url: string | URL, init?: RequestInit, options?: ResilientFetchOptions) => Promise<Response>
  cache: ChallengeCache
  decodeBolt11: (invoice: string) => DecodedInvoice
}

/** Probes an L402 endpoint to discover pricing and server type without making a payment. */
export async function handleDiscover(
  args: { url: string; method?: string },
  deps: DiscoverDeps,
) {
  try {
    const response = await deps.fetchFn(args.url, { method: args.method ?? 'GET' })

    if (response.status !== 402) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: `Expected 402 but got ${response.status}. This endpoint may not require payment.`,
            status: response.status,
          }),
        }],
        isError: true as const,
      }
    }

    const authHeader = response.headers.get('www-authenticate') ?? ''
    const challenge = parseL402Challenge(authHeader)

    if (!challenge) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: 'No valid L402 challenge in WWW-Authenticate header' }),
        }],
        isError: true as const,
      }
    }

    let body: unknown = {}
    try {
      body = await response.json()
    } catch {
      // Body may not be JSON
    }

    const decoded = deps.decodeBolt11(challenge.invoice)
    const serverInfo = detectServer(response.headers, body)

    // Cache the challenge for later use by l402_pay
    deps.cache.set({
      invoice: challenge.invoice,
      macaroon: challenge.macaroon,
      paymentHash: decoded.paymentHash ?? '',
      costSats: decoded.costSats,
      expiresAt: Date.now() + decoded.expiry * 1000,
      url: args.url,
    })

    const result: Record<string, unknown> = {
      url: args.url,
      costSats: decoded.costSats,
      invoice: challenge.invoice,
      macaroon: challenge.macaroon,
      paymentHash: decoded.paymentHash,
    }

    if (serverInfo.type === 'toll-booth') {
      result.server = 'toll-booth'
      const bodyObj = body as Record<string, unknown>
      if (bodyObj.credit_tiers && Array.isArray(bodyObj.credit_tiers)) {
        result.creditTiers = bodyObj.credit_tiers
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
      }],
    }
  } catch (err) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: safeErrorMessage(err) }),
      }],
      isError: true as const,
    }
  }
}

/** Registers the l402_discover tool with the MCP server. */
export function registerDiscoverTool(
  server: McpServer,
  deps: DiscoverDeps,
): void {
  server.registerTool(
    'l402_discover',
    {
      description: 'Probe an endpoint to discover its L402 pricing without committing to payment. Returns the cost in sats, available payment methods, and credit tiers (if toll-booth server). The challenge is cached so a subsequent l402_pay can reuse it.',
      inputSchema: {
        url: z.url().describe('The URL to probe for L402 pricing'),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).optional().default('GET').describe('HTTP method to use'),
      },
    },
    async (args) => handleDiscover(args, deps),
  )
}
