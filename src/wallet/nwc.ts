import { NwcClient, NwcError, inspectNwcConnection } from '@forgesworn/nwc-kit'
import type { NwcClientOptions } from '@forgesworn/nwc-kit'
import { tryDecodeBolt11, verifyPreimage } from 'farrier-kit'
import type { WalletProvider, PaymentResult, PayInvoiceOptions } from './types.js'

/**
 * Creates a Nostr Wallet Connect provider that reports success only after an
 * authenticated wallet response and independent BOLT-11 settlement proof.
 */
export function createNwcWallet(nwcUri: string, clientOptions: NwcClientOptions = {}): WalletProvider {
  // Fail during configuration instead of advertising a wallet that can never
  // pay. Public inspection does not return the bearer secret.
  inspectNwcConnection(nwcUri)
  return {
    method: 'nwc',
    available: true,

    async payInvoice(invoice: string, _options?: PayInvoiceOptions): Promise<PaymentResult> {
      const decoded = tryDecodeBolt11(invoice)
      if (!decoded) {
        return { paid: false, method: 'nwc', reason: 'Invalid BOLT-11 invoice' }
      }
      if (decoded.amountMsats === null) {
        return { paid: false, method: 'nwc', reason: 'Amountless BOLT-11 invoices require an explicit amount and are refused' }
      }

      let client: NwcClient | undefined
      try {
        client = new NwcClient(nwcUri, clientOptions)
        const paid = await client.payInvoice({ invoice })
        if (!verifyPreimage(paid.preimage, decoded.paymentHashHex)) {
          return {
            paid: false,
            method: 'nwc',
            outcome: 'unknown',
            reason: 'NWC wallet responded but settlement could not be proven. Reconcile the original invoice before retrying.',
          }
        }
        return { paid: true, preimage: paid.preimage, method: 'nwc' }
      } catch (error) {
        if (error instanceof NwcError) {
          if (error.code === 'WALLET_ERROR') {
            return { paid: false, method: 'nwc', reason: error.message }
          }
          if (['PUBLISH_FAILED', 'RESPONSE_TIMEOUT', 'REQUEST_ABORTED', 'CLIENT_CLOSED', 'INVALID_RESPONSE'].includes(error.code)) {
            return {
              paid: false,
              method: 'nwc',
              outcome: 'unknown',
              reason: 'NWC payment outcome is unknown. Reconcile the original invoice before retrying.',
            }
          }
        }
        // Connection URIs are bearer credentials. Never surface raw errors,
        // relay diagnostics, or exception strings that could contain one.
        return {
          paid: false,
          method: 'nwc',
          outcome: 'unknown',
          reason: 'NWC payment outcome is unknown. Reconcile the original invoice before retrying.',
        }
      } finally {
        client?.close()
      }
    },
  }
}
