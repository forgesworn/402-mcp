import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ResilientFetchOptions } from '../fetch/resilient-fetch.js'
import type { SpendTracker } from '../spend-tracker.js'
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
  decodeToken: (token: string) => { proofs: Array<{ amount: number }> }
  maxAutoPaySats: number
  maxSpendPerMinuteSats: number
  spendTracker: SpendTracker
}

/** Redeems Cashu ecash tokens directly with a toll-booth server, bypassing the Lightning round-trip. */
export async function handleRedeemCashu(
  args: { url: string; token: string },
  deps: RedeemCashuDeps,
) {
  const origin = new URL(args.url).origin

  // Decode token to determine its value and enforce spend limits
  let tokenSats: number
  try {
    const decoded = deps.decodeToken(args.token)
    tokenSats = decoded.proofs.reduce((sum, p) => sum + p.amount, 0)
  } catch {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: 'Failed to decode Cashu token' }),
      }],
      isError: true as const,
    }
  }

  if (tokenSats <= 0) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: 'Cashu token has no value' }),
      }],
      isError: true as const,
    }
  }

  if (tokenSats > deps.maxAutoPaySats) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: `Token value (${tokenSats} sats) exceeds MAX_AUTO_PAY_SATS (${deps.maxAutoPaySats}). Increase the limit or use a smaller token.` }),
      }],
      isError: true as const,
    }
  }

  if (!deps.spendTracker.tryRecord(tokenSats, deps.maxSpendPerMinuteSats)) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: 'Per-minute spend limit reached.' }),
      }],
      isError: true as const,
    }
  }

  // Track whether the server has consumed the token so the catch block
  // knows whether to roll back the spend-tracker reservation.
  let redeemSucceeded = false

  try {
    // Step 1: Create invoice to get paymentHash and statusToken
    const invoiceResponse = await deps.fetchFn(`${origin}/create-invoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, { retries: 0 })

    if (!invoiceResponse.ok) {
      deps.spendTracker.unrecord(tokenSats)
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
      deps.spendTracker.unrecord(tokenSats)
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
      deps.spendTracker.unrecord(tokenSats)
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: `Cashu redemption failed (HTTP ${redeemResponse.status})` }),
        }],
        isError: true as const,
      }
    }

    // Past this point the server has consumed the token — the spend is
    // irreversible. Do NOT unrecord tokenSats from here on, even if
    // local steps (parsing, credential storage) fail.
    redeemSucceeded = true

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
    // Only roll back spend if the error occurred before the redeem POST
    // succeeded — after that, the server has consumed the token and the
    // spend is irreversible.
    if (!redeemSucceeded) {
      deps.spendTracker.unrecord(tokenSats)
    }
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
