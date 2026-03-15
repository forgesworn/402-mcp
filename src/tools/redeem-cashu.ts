import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ResilientFetchOptions } from '../fetch/resilient-fetch.js'
import { safeErrorMessage } from './safe-error.js'

const InvoiceResponse = z.object({
  payment_hash: z.string().min(1).max(128),
  macaroon: z.string().min(1).max(10_000),
  payment_url: z.string().max(2048),
})

const RedeemResponseSchema = z.object({
  token_suffix: z.string().min(1).max(256),
  credited: z.number().optional(),
})

export interface RedeemCashuDeps {
  fetchFn: (url: string | URL, init?: RequestInit, options?: ResilientFetchOptions) => Promise<Response>
  storeCredential: (origin: string, macaroon: string, preimage: string, paymentHash: string) => boolean
  removeToken: (tokenStr: string) => void
}

/** Redeems Cashu ecash tokens directly with a toll-booth server, bypassing the Lightning round-trip. */
export async function handleRedeemCashu(
  args: { url: string; token: string },
  deps: RedeemCashuDeps,
) {
  const origin = new URL(args.url).origin

  try {
    // Step 1: Create invoice to get paymentHash and statusToken
    const invoiceResponse = await deps.fetchFn(`${origin}/create-invoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, { retries: 0 })

    if (!invoiceResponse.ok) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: `Failed to create invoice (HTTP ${invoiceResponse.status})` }),
        }],
        isError: true as const,
      }
    }

    const raw = await invoiceResponse.json()
    const invoiceValidated = InvoiceResponse.safeParse(raw)
    if (!invoiceValidated.success) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: 'Invalid server response: missing payment_hash, macaroon, or payment_url' }),
        }],
        isError: true as const,
      }
    }
    const { payment_hash: paymentHash, macaroon, payment_url: paymentUrl } = invoiceValidated.data

    // Extract statusToken from payment_url query param
    const statusToken = new URL(paymentUrl, origin).searchParams.get('token') ?? ''

    // Step 2: Redeem Cashu token
    const redeemResponse = await deps.fetchFn(`${origin}/cashu-redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: args.token,
        paymentHash,
        statusToken,
      }),
    }, { retries: 0 })

    if (!redeemResponse.ok) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: `Cashu redemption failed (HTTP ${redeemResponse.status})` }),
        }],
        isError: true as const,
      }
    }

    const redeemRaw = await redeemResponse.json()
    const redeemValidated = RedeemResponseSchema.safeParse(redeemRaw)
    if (!redeemValidated.success) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: 'Invalid server response: missing token_suffix' }),
        }],
        isError: true as const,
      }
    }
    const { token_suffix: tokenSuffix, credited: creditSats } = redeemValidated.data

    // Store credential — only remove the Cashu token if storage succeeds,
    // otherwise the user loses both the token and the credential.
    const stored = deps.storeCredential(origin, macaroon, tokenSuffix, paymentHash)
    if (stored) {
      deps.removeToken(args.token)
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          redeemed: true,
          creditsReceived: typeof creditSats === 'number' ? creditSats : null,
          credentialsStored: stored,
          ...(stored ? {} : { warning: 'Credential validation failed — original token preserved for retry' }),
        }, null, 2),
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

/** Registers the l402_redeem_cashu tool with the MCP server. */
export function registerRedeemCashuTool(server: McpServer, deps: RedeemCashuDeps): void {
  server.registerTool(
    'l402_redeem_cashu',
    {
      description: 'Redeem Cashu ecash tokens directly on a toll-booth server, avoiding the Lightning round-trip. Handles the two-step flow automatically (create invoice then redeem token). Only works with toll-booth servers.',
      inputSchema: {
        url: z.url().describe('The toll-booth server URL'),
        token: z.string().max(20_000).describe('Cashu token string to redeem (e.g. cashuAey...)'),
      },
    },
    async (args) => handleRedeemCashu(args, deps),
  )
}
