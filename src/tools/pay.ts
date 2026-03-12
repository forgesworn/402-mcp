import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ChallengeCache } from '../l402/challenge-cache.js'
import type { WalletMethod, WalletProvider } from '../wallet/types.js'
import type { ResilientFetchOptions } from '../fetch/resilient-fetch.js'

export interface PayDeps {
  cache: ChallengeCache
  resolveWallet: (method?: WalletMethod) => WalletProvider | undefined
  storeCredential: (origin: string, macaroon: string, preimage: string, paymentHash: string, server: 'toll-booth' | null) => void
  maxAutoPaySats: number
  fetchFn: (url: string | URL, init?: RequestInit, options?: ResilientFetchOptions) => Promise<Response>
}

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

  // Set server origin for human wallet polling
  if (wallet.method === 'human' && cachedUrl && 'setServerOrigin' in wallet) {
    (wallet as any).setServerOrigin(new URL(cachedUrl).origin)
  }

  const result = await wallet.payInvoice(invoice)

  if (result.paid && result.preimage) {
    const origin = cachedUrl ? new URL(cachedUrl).origin : ''
    deps.storeCredential(
      origin,
      macaroon,
      result.preimage,
      paymentHash ?? '',
      null,
    )

    // Remove from cache
    if (paymentHash) deps.cache.delete(paymentHash)
  }

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        paid: result.paid,
        preimage: result.preimage,
        credentialsStored: result.paid,
        method: result.method,
        reason: result.reason,
      }, null, 2),
    }],
  }
}

export function registerPayTool(server: McpServer, deps: PayDeps): void {
  server.registerTool(
    'l402_pay',
    {
      description: 'Pay a specific L402 invoice. Use this when you want to reason about costs before paying rather than auto-paying via l402_fetch. Can reuse a cached challenge from l402_discover by passing just the paymentHash. Methods: "nwc" (autonomous Lightning), "cashu" (autonomous ecash), "human" (present QR code and poll for settlement).',
      inputSchema: {
        invoice: z.string().optional().describe('BOLT-11 invoice to pay. Optional if paymentHash matches a cached challenge from l402_discover.'),
        macaroon: z.string().optional().describe('Macaroon from the L402 challenge. Optional if paymentHash matches a cached challenge.'),
        paymentHash: z.string().optional().describe('Payment hash to look up cached challenge from l402_discover.'),
        method: z.enum(['nwc', 'cashu', 'human']).optional().describe('Payment method override. Defaults to wallet priority: NWC > Cashu > human.'),
      },
    },
    async (args) => handlePay(args, deps),
  )
}
