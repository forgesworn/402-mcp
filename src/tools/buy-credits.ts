import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { WalletMethod } from '../wallet/types.js'
import type { DecodedInvoice } from '../l402/bolt11.js'
import type { ResilientFetchOptions } from '../fetch/resilient-fetch.js'
import type { SpendTracker } from '../spend-tracker.js'
import { safeErrorMessage } from './safe-error.js'

const CreateInvoiceResponse = z.object({
  bolt11: z.string().min(1).max(20_000),
  macaroon: z.string().min(1).max(10_000),
  credit_sats: z.number().optional(),
})

export interface BuyCreditsDeps {
  fetchFn: (url: string | URL, init?: RequestInit, options?: ResilientFetchOptions) => Promise<Response>
  payInvoice: (invoice: string, options?: { serverOrigin?: string; method?: WalletMethod }) => Promise<{ paid: boolean; preimage?: string; method: string }>
  storeCredential: (origin: string, macaroon: string, preimage: string, paymentHash: string) => boolean
  decodeBolt11: (invoice: string) => DecodedInvoice
  maxAutoPaySats: number
  maxSpendPerMinuteSats: number
  spendTracker: SpendTracker
  generateQr: (invoice: string) => Promise<{ png: string; text: string }>
  walletMethod: () => WalletMethod | undefined
}

/** Purchases a volume discount credit tier from a toll-booth server. */
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

    if (!response.ok) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: `Failed to create invoice (HTTP ${response.status})` }),
        }],
        isError: true as const,
      }
    }

    const raw: unknown = await response.json()
    const validated = CreateInvoiceResponse.safeParse(raw)
    if (!validated.success) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: 'Invalid server response: missing or malformed bolt11/macaroon' }),
        }],
        isError: true as const,
      }
    }
    const { bolt11: invoice, macaroon, credit_sats: creditSats } = validated.data

    // Verify the invoice amount matches what we requested — a malicious server
    // could return an invoice for a much larger amount than amountSats, or omit
    // the amount entirely to bypass verification.
    const decoded = deps.decodeBolt11(invoice)
    if (decoded.costSats === null) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: 'Server returned an amountless invoice. Refusing to pay — cannot verify amount matches requested amount.' }),
        }],
        isError: true as const,
      }
    }
    if (decoded.costSats !== args.amountSats) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: `Invoice amount (${decoded.costSats} sats) does not match requested amount (${args.amountSats} sats). Refusing to pay.` }),
        }],
        isError: true as const,
      }
    }

    // Per-request cap — consistent with l402-fetch and l402-redeem-cashu.
    // Skip for human wallet: the user approves manually via QR, so the auto-pay cap
    // should not block their explicit choice to buy a larger tier.
    const effectiveMethod = args.method ?? deps.walletMethod()
    if (effectiveMethod !== 'human' && decoded.costSats > deps.maxAutoPaySats) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: `Amount ${decoded.costSats} sats exceeds per-request limit (${deps.maxAutoPaySats} sats). Reduce the amount or ask the user to confirm.` }),
        }],
        isError: true as const,
      }
    }

    // Atomic check-and-record: prevents TOCTOU race between limit check and payment
    const spendAmount = decoded.costSats
    if (!deps.spendTracker.tryRecord(spendAmount, deps.maxSpendPerMinuteSats)) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: 'Per-minute spend limit reached.' }),
        }],
        isError: true as const,
      }
    }

    const payResult = await deps.payInvoice(invoice, { method: args.method, serverOrigin: origin })

    // Roll back spend-limit reservation if payment failed
    if (!payResult.paid || !payResult.preimage) {
      deps.spendTracker.unrecord(spendAmount)
    }

    if (payResult.paid && payResult.preimage) {
      const stored = deps.storeCredential(origin, macaroon, payResult.preimage, decoded.paymentHash ?? '')

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            paid: true,
            amountSats: args.amountSats,
            creditsReceived: typeof creditSats === 'number' ? creditSats : null,
            credentialsStored: stored,
            method: payResult.method,
            ...(stored ? {} : { warning: 'Payment succeeded but credential validation failed — credits may be inaccessible' }),
          }, null, 2),
        }],
        ...(stored ? {} : { isError: true as const }),
      }
    }

    // Human wallet timed out — return QR so user can pay manually
    if (payResult.method === 'human') {
      let qrText: string | undefined
      let qrPngBase64: string | undefined
      try {
        const qr = await deps.generateQr(invoice)
        qrText = qr.text
        qrPngBase64 = qr.png.replace(/^data:image\/png;base64,/, '')
      } catch {
        // QR generation failed — text response still has invoice
      }

      const json = JSON.stringify({
        paid: false,
        invoice,
        paymentHash: decoded.paymentHash,
        costSats: args.amountSats,
        message: `Scan QR to pay ${args.amountSats} sats. After payment, call l402-pay with the paymentHash.`,
      }, null, 2)

      // Combine QR + JSON in one text block so terminals render the QR with newlines
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [{
        type: 'text' as const,
        text: qrText ? `${qrText}\n\n${json}` : json,
      }]

      if (qrPngBase64) {
        content.push({
          type: 'image' as const,
          data: qrPngBase64,
          mimeType: 'image/png',
        })
      }

      return { content }
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
        text: JSON.stringify({ error: safeErrorMessage(err) }),
      }],
      isError: true as const,
    }
  }
}

/** Registers the l402-buy-credits tool with the MCP server. */
export function registerBuyCreditsTool(server: McpServer, deps: BuyCreditsDeps): void {
  server.registerTool(
    'l402-buy-credits',
    {
      description: 'Buy credits from a toll-booth server with volume discounts. Omit amountSats to discover available tiers. Provide amountSats to purchase a specific tier. Only works with toll-booth servers.',
      annotations: { destructiveHint: true, openWorldHint: true },
      inputSchema: {
        url: z.url().describe('The toll-booth server URL'),
        amountSats: z.number().int().positive().optional().describe('Amount in sats to purchase. Omit to list available tiers.'),
        method: z.enum(['nwc', 'cashu', 'human']).optional().describe('Payment method override'),
      },
    },
    async (args) => handleBuyCredits(args, deps),
  )
}
