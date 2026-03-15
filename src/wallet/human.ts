import type { WalletProvider, PaymentResult } from './types.js'
import type { ResilientFetchOptions } from '../fetch/resilient-fetch.js'

export interface PollOptions {
  initialIntervalS: number
  maxIntervalS: number
  timeoutS: number
  checkSettlement: (paymentHash: string) => Promise<{ settled: boolean; preimage?: string }>
}

/** Polls a toll-booth server for invoice settlement, returning once paid or timed out. */
export async function pollForSettlement(
  paymentHash: string,
  options: PollOptions,
): Promise<PaymentResult> {
  const deadline = Date.now() + options.timeoutS * 1000
  let intervalMs = options.initialIntervalS * 1000

  while (Date.now() < deadline) {
    const result = await options.checkSettlement(paymentHash)
    if (result.settled) {
      return { paid: true, preimage: result.preimage, method: 'human' }
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)))
    intervalMs = Math.min(intervalMs * 2, options.maxIntervalS * 1000)
  }

  return { paid: false, method: 'human', reason: `Payment timed out after ${options.timeoutS}s` }
}

export interface HumanWalletOptions {
  initialIntervalS: number
  maxIntervalS: number
  timeoutS: number
  generateQr: (data: string) => Promise<string>
  fetchFn: (url: string | URL, init?: RequestInit, options?: ResilientFetchOptions) => Promise<Response>
}

/** Creates a human-in-the-loop wallet that presents QR codes and polls for settlement. */
export function createHumanWallet(options: HumanWalletOptions): WalletProvider & { setServerOrigin(origin: string): void } {
  let serverOrigin = ''

  return {
    method: 'human',
    available: true,

    setServerOrigin(origin: string) {
      serverOrigin = origin
    },

    async payInvoice(invoice: string): Promise<PaymentResult> {
      const qrDataUri = await options.generateQr(invoice)
      console.error(`\nScan to pay: ${qrDataUri}\n`)

      const { decodeBolt11 } = await import('../l402/bolt11.js')
      const decoded = decodeBolt11(invoice)
      if (!decoded?.paymentHash) {
        return { paid: false, method: 'human', reason: 'Could not decode invoice payment hash' }
      }

      if (!serverOrigin) {
        return { paid: false, method: 'human', reason: 'No server origin set for settlement polling' }
      }

      return pollForSettlement(decoded.paymentHash, {
        initialIntervalS: options.initialIntervalS,
        maxIntervalS: options.maxIntervalS,
        timeoutS: options.timeoutS,
        checkSettlement: async (hash: string) => {
          try {
            const res = await options.fetchFn(`${serverOrigin}/invoice-status/${hash}`, undefined, { retries: 0 })
            if (!res.ok) return { settled: false }
            const data = await res.json() as Record<string, unknown>
            const preimage = typeof data.preimage === 'string' && data.preimage.length > 0
              ? data.preimage
              : undefined
            return { settled: data.settled === true, preimage }
          } catch {
            return { settled: false }
          }
        },
      })
    },
  }
}
