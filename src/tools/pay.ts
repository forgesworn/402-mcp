import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ChallengeCache } from '../l402/challenge-cache.js'
import type { WalletMethod, WalletProvider } from '../wallet/types.js'
import type { ResilientFetchOptions } from '../fetch/resilient-fetch.js'
import type { DecodedInvoice } from '../l402/bolt11.js'
import type { SpendTracker } from '../spend-tracker.js'
import { safeErrorMessage } from './safe-error.js'

export interface PayDeps {
  cache: ChallengeCache
  resolveWallet: (method?: WalletMethod) => WalletProvider | undefined
  storeCredential: (origin: string, macaroon: string, preimage: string, paymentHash: string, server: 'toll-booth' | null) => boolean
  maxAutoPaySats: number
  maxSpendPerMinuteSats: number
  spendTracker: SpendTracker
  decodeBolt11: (invoice: string) => DecodedInvoice
  fetchFn: (url: string | URL, init?: RequestInit, options?: ResilientFetchOptions) => Promise<Response>
}

/** Pays a Lightning invoice using the configured wallet priority (NWC, Cashu, human). */
export async function handlePay(
  args: {
    invoice?: string
    macaroon?: string
    paymentHash?: string
    method?: WalletMethod
  },
  deps: PayDeps,
) {
  // Resolve invoice and macaroon from cache if paymentHash provided
  let invoice = args.invoice
  let macaroon = args.macaroon
  const paymentHash = args.paymentHash
  let cachedUrl: string | undefined

  if (paymentHash) {
    const cached = deps.cache.get(paymentHash)
    if (cached) {
      invoice = invoice ?? cached.invoice
      macaroon = macaroon ?? cached.macaroon
      cachedUrl = cached.url
    }
  }

  if (!invoice) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ paid: false, reason: 'No invoice provided and none cached for this paymentHash' }),
      }],
      isError: true as const,
    }
  }

  if (!macaroon) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ paid: false, reason: 'No macaroon provided and none cached for this paymentHash' }),
      }],
      isError: true as const,
    }
  }

  const wallet = deps.resolveWallet(args.method)
  if (!wallet) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ paid: false, reason: 'No wallet available for the requested payment method' }),
      }],
      isError: true as const,
    }
  }

  // Decode invoice to determine cost — done before try so catch can roll back
  const decoded = deps.decodeBolt11(invoice)
  const costSats = decoded.costSats

  // Reject amountless invoices — cannot enforce spend limits without a known cost
  if (costSats === null) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ paid: false, reason: 'Invoice has no encoded amount — cannot enforce spend limits. Pay manually or use an invoice with an explicit amount.' }),
      }],
      isError: true as const,
    }
  }

  if (costSats > deps.maxAutoPaySats) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ paid: false, reason: `Invoice cost (${costSats} sats) exceeds auto-pay limit (${deps.maxAutoPaySats} sats)` }),
      }],
      isError: true as const,
    }
  }

  // Atomic spend-limit check before payment
  if (!deps.spendTracker.tryRecord(costSats, deps.maxSpendPerMinuteSats)) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ paid: false, reason: 'Per-minute spend limit reached.' }),
      }],
      isError: true as const,
    }
  }

  try {
    // Set server origin for human wallet polling
    if (wallet.method === 'human' && cachedUrl && 'setServerOrigin' in wallet) {
      (wallet as any).setServerOrigin(new URL(cachedUrl).origin)
    }

    const result = await wallet.payInvoice(invoice)

    // Roll back spend-limit reservation if payment failed
    if (!result.paid || !result.preimage) {
      deps.spendTracker.unrecord(costSats)
    }

    let credentialsStored = false
    if (result.paid && result.preimage) {
      const origin = cachedUrl ? new URL(cachedUrl).origin : ''
      if (origin) {
        credentialsStored = deps.storeCredential(
          origin,
          macaroon,
          result.preimage,
          paymentHash ?? '',
          null,
        )
      }

      // Remove from cache
      if (paymentHash) deps.cache.delete(paymentHash)
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          paid: result.paid,
          credentialsStored,
          method: result.method,
        }, null, 2),
      }],
    }
  } catch (err) {
    // Roll back spend reservation on exception (payment may not have completed)
    deps.spendTracker.unrecord(costSats)

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: safeErrorMessage(err) }),
      }],
      isError: true as const,
    }
  }
}

/** Registers the l402_pay tool with the MCP server. */
export function registerPayTool(server: McpServer, deps: PayDeps): void {
  server.registerTool(
    'l402_pay',
    {
      description: 'Pay a specific L402 invoice. Use this when you want to reason about costs before paying rather than auto-paying via l402_fetch. Can reuse a cached challenge from l402_discover by passing just the paymentHash. Methods: "nwc" (autonomous Lightning), "cashu" (autonomous ecash), "human" (present QR code and poll for settlement).',
      inputSchema: {
        invoice: z.string().max(20_000).optional().describe('BOLT-11 invoice to pay. Optional if paymentHash matches a cached challenge from l402_discover.'),
        macaroon: z.string().max(10_000).optional().describe('Macaroon from the L402 challenge. Optional if paymentHash matches a cached challenge.'),
        paymentHash: z.string().max(128).optional().describe('Payment hash to look up cached challenge from l402_discover.'),
        method: z.enum(['nwc', 'cashu', 'human']).optional().describe('Payment method override. Defaults to wallet priority: NWC > Cashu > human.'),
      },
    },
    async (args) => handlePay(args, deps),
  )
}
