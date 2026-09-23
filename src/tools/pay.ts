import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ChallengeCache } from '../l402/challenge-cache.js'
import type { WalletMethod, WalletProvider } from '../wallet/types.js'
import type { ResilientFetchOptions } from '../fetch/resilient-fetch.js'
import type { DecodedInvoice } from '../l402/bolt11.js'
import type { SpendTracker } from '../spend-tracker.js'
import type { PendingPayment } from '../store/pending-payments.js'
import type { ConfirmWithHuman } from './confirm.js'
import { safeErrorMessage } from './safe-error.js'

const RECONCILE_HINT = 'Call l402-reconcile with this paymentHash before paying this service again.'

export interface PayDeps {
  cache: ChallengeCache
  resolveWallet: (method?: WalletMethod) => WalletProvider | undefined
  storeCredential: (origin: string, macaroon: string, preimage: string, paymentHash: string, server: 'toll-booth' | null) => boolean
  maxAutoPaySats: number
  maxSpendPerMinuteSats: number
  spendTracker: SpendTracker
  decodeBolt11: (invoice: string) => DecodedInvoice
  fetchFn: (url: string | URL, init?: RequestInit, options?: ResilientFetchOptions) => Promise<Response>
  /** Asks the human directly (MCP elicitation) to approve an invoice no challenge produced. */
  confirmWithHuman: ConfirmWithHuman
  /** Ledger of unknown-outcome payments; any entry for a service pauses payment to it. */
  pendingPayments: {
    add(entry: PendingPayment): void
    unresolvedFor(origins: string[], pubkey?: string): PendingPayment[]
  }
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

  let cachedPaymentUrl: string | undefined
  // True only when the invoice is one a server actually sent this process in
  // a 402 challenge. Any other invoice is the agent's to supply, which is the
  // prompt-injection route to the wallet, so it needs the human's approval.
  let fromChallenge = false

  if (paymentHash) {
    const cached = deps.cache.get(paymentHash)
    if (cached) {
      fromChallenge = args.invoice === undefined || args.invoice === cached.invoice
      invoice = invoice ?? cached.invoice
      macaroon = macaroon ?? cached.macaroon
      cachedUrl = cached.url
      cachedPaymentUrl = cached.paymentUrl
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

  if (!fromChallenge && wallet.method !== 'human') {
    const answer = await deps.confirmWithHuman(
      `An agent asks to pay a ${costSats} sat Lightning invoice that did not come from a payment challenge this server received. Approve only if you asked for this payment.`,
    )
    if (answer !== 'accepted') {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            paid: false,
            reason: answer === 'unsupported'
              ? 'l402-pay only pays invoices from payment challenges this server received (via l402-fetch or l402-discover, using their paymentHash). Paying any other invoice needs the human to approve it, and this client cannot ask them.'
              : 'The human did not approve this payment.',
          }),
        }],
        isError: true as const,
      }
    }
  }

  const origin = cachedUrl ? new URL(cachedUrl).origin : undefined
  const unresolved = origin ? deps.pendingPayments.unresolvedFor([origin]) : []
  if (unresolved.length > 0 && wallet.method !== 'human') {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          paid: false,
          paymentState: 'blocked',
          unresolvedPayments: unresolved.map(p => p.paymentHash),
          reason: `Payment to this service is paused: ${unresolved.length} earlier payment(s) to it have an unknown outcome. Call l402-reconcile with each paymentHash first.`,
        }),
      }],
      isError: true as const,
    }
  }

  const recordUnknown = (method: string) => {
    if (!decoded.paymentHash) return
    deps.pendingPayments.add({
      paymentHash: decoded.paymentHash,
      origins: origin ? [origin] : [],
      invoice,
      costSats,
      protocol: 'l402',
      method,
      macaroon,
      createdAt: new Date().toISOString(),
    })
  }

  // Atomic spend-limit check before payment
  if (!deps.spendTracker.tryRecord(costSats, deps.maxSpendPerMinuteSats)) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ paid: false, reason: deps.spendTracker.refusal(costSats, deps.maxSpendPerMinuteSats) ?? 'Spend limit reached.' }),
      }],
      isError: true as const,
    }
  }

  try {
    // If we have a payment page URL (toll-booth), poll it directly for settlement.
    // This avoids the human wallet's long timeout — the user already paid via the page.
    if (cachedPaymentUrl && wallet.method === 'human') {
      const deadline = Date.now() + 120_000 // 120s — enough time to open URL, pick a tier, and pay
      let intervalMs = 2000

      while (Date.now() < deadline) {
        try {
          const res = await deps.fetchFn(cachedPaymentUrl, {
            headers: { 'Accept': 'application/json' },
          }, { retries: 0 })

          if (res.ok) {
            const data = await res.json() as Record<string, unknown>
            if (data.paid === true) {
              const preimage = typeof data.preimage === 'string' ? data.preimage : undefined
              const tokenSuffix = typeof data.token_suffix === 'string' ? data.token_suffix : undefined
              const suffix = preimage ?? tokenSuffix

              let credentialsStored = false
              if (suffix && origin) {
                credentialsStored = deps.storeCredential(origin, macaroon, suffix, paymentHash ?? '', 'toll-booth')
              }

              if (paymentHash) deps.cache.delete(paymentHash)

              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({
                    paid: true,
                    credentialsStored,
                    method: 'human',
                  }, null, 2),
                }],
              }
            }
          }
        } catch {
          // Poll failed — retry
        }

        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)))
        intervalMs = Math.min(intervalMs * 1.5, 5000)
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            paid: false,
            paymentState: 'unknown',
            reason: 'Payment not confirmed after 120s. It may still have settled: call l402-pay again with the same paymentHash to keep checking. If you selected a different tier on the payment page, store the L402 token it shows with l402-store-token.',
            paymentUrl: cachedPaymentUrl,
          }),
        }],
        isError: true as const,
      }
    }

    const result = await wallet.payInvoice(invoice, { serverOrigin: origin })

    // Roll back spend-limit reservation if payment failed
    if (!result.paid && result.outcome !== 'unknown') {
      deps.spendTracker.unrecord(costSats)
    }

    if (result.outcome === 'unknown' || (result.paid && !result.preimage)) {
      recordUnknown(result.method)
    }

    if (result.paid && !result.preimage) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            paid: false,
            paymentState: 'unknown',
            credentialsStored: false,
            method: result.method,
            reason: `The wallet reported payment without a settlement preimage. ${RECONCILE_HINT}`,
          }, null, 2),
        }],
        isError: true as const,
      }
    }

    let credentialsStored = false
    if (result.paid && result.preimage) {
      const storeOrigin = cachedUrl ? new URL(cachedUrl).origin : ''
      if (storeOrigin) {
        credentialsStored = deps.storeCredential(
          storeOrigin,
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
          paymentState: result.outcome ?? (result.paid ? 'paid' : 'failed'),
          credentialsStored,
          method: result.method,
          ...(result.reason ? { reason: result.reason } : {}),
        }, null, 2),
      }],
      ...(result.outcome === 'unknown' ? { isError: true as const } : {}),
    }
  } catch (err) {
    recordUnknown(wallet.method)
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: safeErrorMessage(err),
          paymentState: 'unknown',
          paymentHash: decoded.paymentHash,
          message: `The payment attempt threw after budget reservation. ${RECONCILE_HINT}`,
        }),
      }],
      isError: true as const,
    }
  }
}

/** Registers the l402-pay tool with the MCP server. */
export function registerPayTool(server: McpServer, deps: PayDeps): void {
  server.registerTool(
    'l402-pay',
    {
      description: 'Pay a challenge that l402-fetch or l402-discover returned, by its paymentHash, and store the credential so the next l402-fetch succeeds. For human wallets, polls the payment page for settlement for up to 120s; call it straight after showing the payment URL to the user. An invoice that did not come from such a challenge is paid only if the human approves it in the client.',
      annotations: { destructiveHint: true, openWorldHint: true },
      inputSchema: {
        invoice: z.string().max(20_000).optional().describe('BOLT-11 invoice. Leave out when paying a challenge by paymentHash; any other invoice needs the human to approve it.'),
        macaroon: z.string().max(10_000).optional().describe('Macaroon from the L402 challenge. Optional if paymentHash matches a cached challenge.'),
        paymentHash: z.string().max(128).optional().describe('Payment hash of a challenge from l402-fetch or l402-discover.'),
        method: z.enum(['nwc', 'cashu', 'lnurlcash', 'human']).optional().describe('Payment method override. Defaults to wallet priority: NWC > Cashu > LNURLcash > human.'),
      },
    },
    async (args) => handlePay(args, deps),
  )
}
