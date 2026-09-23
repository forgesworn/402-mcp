import { z } from 'zod'
import { verifyPreimage } from 'farrier-kit'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { PendingPayment } from '../store/pending-payments.js'
import type { PaymentLookup } from '../wallet/types.js'
import type { ConfirmWithHuman } from './confirm.js'
import { safeErrorMessage } from './safe-error.js'

export interface ReconcileDeps {
  pendingPayments: {
    get(paymentHash: string): PendingPayment | undefined
    remove(paymentHash: string): boolean
    list(): PendingPayment[]
  }
  /** Asks the wallet that attempted the payment what became of it. */
  lookupPayment: (entry: PendingPayment) => Promise<PaymentLookup>
  storeCredential: (origin: string, macaroon: string, preimage: string, paymentHash: string, server: 'toll-booth' | null) => boolean
  confirmWithHuman: ConfirmWithHuman
}

function summary(p: PendingPayment) {
  return { paymentHash: p.paymentHash, origins: p.origins, costSats: p.costSats, protocol: p.protocol, method: p.method, createdAt: p.createdAt }
}

function reply(body: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
    ...(isError ? { isError: true as const } : {}),
  }
}

/**
 * Resolves a payment whose outcome was unknown. Settled (with a preimage that
 * hashes to the payment hash) or definitely failed clears it and lifts the
 * auto-pay block on its service; anything else leaves it in place.
 */
export async function handleReconcile(
  args: { paymentHash?: string; preimage?: string; abandon?: boolean },
  deps: ReconcileDeps,
) {
  try {
    if (!args.paymentHash) {
      const pending = deps.pendingPayments.list().map(summary)
      return reply({
        unresolved: pending,
        message: pending.length === 0
          ? 'No payments have an unknown outcome.'
          : 'Call l402-reconcile with each paymentHash to resolve it. Auto-pay to these services is paused until then.',
      })
    }

    const paymentHash = args.paymentHash.toLowerCase()
    const entry = deps.pendingPayments.get(paymentHash)
    if (!entry) {
      return reply({ paymentHash, resolved: false, message: 'No unresolved payment has this payment hash.' }, true)
    }

    let lookup: PaymentLookup
    if (args.preimage !== undefined) {
      if (!verifyPreimage(args.preimage, paymentHash)) {
        return reply({ paymentHash, resolved: false, message: 'That preimage does not hash to this payment hash.' }, true)
      }
      lookup = { state: 'settled', preimage: args.preimage.toLowerCase() }
    } else if (args.abandon) {
      const answer = await deps.confirmWithHuman(
        `Stop tracking the ${entry.costSats ?? 'unknown'} sat payment to ${entry.origins.join(', ') || 'an unknown service'} (hash ${paymentHash.slice(0, 12)}…)? ` +
        'Only approve once you have checked your wallet and this payment did not go out: auto-pay to this service resumes.',
      )
      if (answer !== 'accepted') {
        return reply({
          paymentHash,
          resolved: false,
          message: answer === 'unsupported'
            ? 'Abandoning an unresolved payment needs the human to approve it, and this client cannot ask them. Resolve it with a preimage, or wait for the wallet to report it.'
            : 'The human did not approve abandoning this payment.',
        }, true)
      }
      deps.pendingPayments.remove(paymentHash)
      return reply({ paymentHash, resolved: true, state: 'abandoned', message: 'No longer tracked. Auto-pay to this service is allowed again.' })
    } else {
      lookup = await deps.lookupPayment(entry)
    }

    if (lookup.state === 'settled') {
      // A wallet's report is checked here too: only a matching preimage clears it.
      if (!verifyPreimage(lookup.preimage, paymentHash)) {
        return reply({ paymentHash, resolved: false, state: 'pending', message: 'The wallet returned a preimage that does not match this payment.' }, true)
      }
      let credentialsStored = false
      if (entry.protocol === 'l402' && entry.macaroon && entry.origins[0]) {
        credentialsStored = deps.storeCredential(entry.origins[0], entry.macaroon, lookup.preimage, paymentHash, null)
      }
      deps.pendingPayments.remove(paymentHash)
      return reply({
        paymentHash,
        resolved: true,
        state: 'settled',
        credentialsStored,
        message: credentialsStored
          ? 'The payment settled and its credential is stored; l402-fetch will use it.'
          : 'The payment settled. Auto-pay to this service is allowed again.',
      })
    }

    if (lookup.state === 'failed') {
      deps.pendingPayments.remove(paymentHash)
      return reply({
        paymentHash,
        resolved: true,
        state: 'failed',
        message: `${lookup.reason ?? 'The payment failed.'} No money moved, and auto-pay to this service is allowed again.`,
      })
    }

    return reply({
      paymentHash,
      resolved: false,
      state: 'pending',
      message: `${lookup.reason ?? 'The outcome is still unknown.'} Auto-pay to this service stays paused.`,
    }, true)
  } catch (err) {
    return reply({ error: safeErrorMessage(err) }, true)
  }
}

/** Registers the l402-reconcile tool with the MCP server. */
export function registerReconcileTool(server: McpServer, deps: ReconcileDeps): void {
  server.registerTool(
    'l402-reconcile',
    {
      description: 'Resolve a payment whose outcome is unknown. While one is unresolved, auto-pay to that service is paused. Call with no arguments to list them, or with a paymentHash to ask the wallet (NWC lookup_invoice, or the Cashu mint for a reserved melt). A settled payment stores its credential when it can; a failed one is cleared. A preimage that hashes to the payment hash also settles it. abandon: true asks the human to confirm that the payment did not go out.',
      annotations: { destructiveHint: false, openWorldHint: true },
      inputSchema: {
        paymentHash: z.string().regex(/^[0-9a-fA-F]{64}$/).optional().describe('Payment hash from an unknown-outcome payment. Omit to list unresolved payments.'),
        preimage: z.string().regex(/^[0-9a-fA-F]{64}$/).optional().describe('Settlement preimage, if the human has one from their wallet'),
        abandon: z.boolean().optional().describe('Stop tracking the payment. Requires the human to approve through the client.'),
      },
    },
    async (args) => handleReconcile(args, deps),
  )
}
