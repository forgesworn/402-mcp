import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { WalletMethod } from '../wallet/types.js'
import type { DecodedInvoice } from '../l402/bolt11.js'
import type { ResilientFetchOptions } from '../fetch/resilient-fetch.js'
import type { SpendTracker } from '../spend-tracker.js'

export interface BuyCreditsDeps {
  fetchFn: (url: string | URL, init?: RequestInit, options?: ResilientFetchOptions) => Promise<Response>
  payInvoice: (invoice: string, method?: WalletMethod) => Promise<{ paid: boolean; preimage?: string; method: string }>
  storeCredential: (origin: string, macaroon: string, preimage: string, paymentHash: string) => void
  decodeBolt11: (invoice: string) => DecodedInvoice
  maxSpendPerMinuteSats: number
  spendTracker: SpendTracker
}

export async function handleBuyCredits(
  args: { url: string; amountSats?: number; method?: WalletMethod },
  deps: BuyCreditsDeps,
) {
  const origin = new URL(args.url).origin

  try {
    // Discovery mode: probe a 402 to get credit_tiers from the response body
    if (args.amountSats === undefined) {
      const response = await deps.fetchFn(args.url, { method: 'GET' })

      if (response.status !== 402) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: `Expected 402 but got ${response.status}. This may not be an L402 endpoint.` }),
          }],
          isError: true as const,
        }
      }

      let body: Record<string, unknown> = {}
      try { body = await response.json() as Record<string, unknown> } catch { /* non-JSON */ }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ tiers: body.credit_tiers ?? [] }, null, 2),
        }],
      }
    }

    // Purchase mode: create invoice and pay
    const response = await deps.fetchFn(`${origin}/create-invoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountSats: args.amountSats }),
    }, { retries: 0 })

    const data = await response.json() as Record<string, unknown>
    const invoice = data.bolt11 as string
    const macaroon = data.macaroon as string
    const creditSats = data.credit_sats as number

    // Check per-minute spend limit before paying
    if (deps.spendTracker.wouldExceed(args.amountSats, deps.maxSpendPerMinuteSats)) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: 'Per-minute spend limit reached.' }),
        }],
        isError: true as const,
      }
    }

    const payResult = await deps.payInvoice(invoice, args.method)

    if (payResult.paid && payResult.preimage) {
      deps.spendTracker.record(args.amountSats)
      const decoded = deps.decodeBolt11(invoice)
      deps.storeCredential(origin, macaroon, payResult.preimage, decoded.paymentHash ?? '')

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            paid: true,
            amountSats: args.amountSats,
            creditsReceived: creditSats,
            method: payResult.method,
          }, null, 2),
        }],
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ paid: false, reason: 'Payment failed' }),
      }],
      isError: true as const,
    }
  } catch (err) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: String(err) }),
      }],
      isError: true as const,
    }
  }
}

export function registerBuyCreditsTool(server: McpServer, deps: BuyCreditsDeps): void {
  server.registerTool(
    'l402_buy_credits',
    {
      description: 'Buy credits from a toll-booth server with volume discounts. Omit amountSats to discover available tiers. Provide amountSats to purchase a specific tier. Only works with toll-booth servers.',
      inputSchema: {
        url: z.url().describe('The toll-booth server URL'),
        amountSats: z.number().positive().optional().describe('Amount in sats to purchase. Omit to list available tiers.'),
        method: z.enum(['nwc', 'cashu', 'human']).optional().describe('Payment method override'),
      },
    },
    async (args) => handleBuyCredits(args, deps),
  )
}
