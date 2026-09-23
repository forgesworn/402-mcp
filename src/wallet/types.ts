export type WalletMethod = 'nwc' | 'cashu' | 'lnurlcash' | 'human'

export interface PayInvoiceOptions {
  serverOrigin?: string
}

export interface PaymentResult {
  paid: boolean
  preimage?: string
  method: WalletMethod
  reason?: string
  /** The request may have executed but settlement could not be proven. */
  outcome?: 'unknown'
  /**
   * Where settlement can still be proven later, for an `unknown` outcome
   * that has one. A caller holding this can ask again rather than treating
   * the payment as lost; reconcile also polls it on its own.
   */
  verifyUrl?: string
}

/** What a wallet can say, after the fact, about a payment it attempted. */
export type PaymentLookup =
  | { state: 'settled'; preimage: string }
  | { state: 'failed'; reason?: string }
  | { state: 'pending'; reason?: string }

export interface WalletProvider {
  method: WalletMethod
  available: boolean
  payInvoice(invoice: string, options?: PayInvoiceOptions): Promise<PaymentResult>
  /**
   * Asks the wallet what became of an earlier payment. Only a preimage that
   * hashes to `paymentHash` may be reported as settled, and only a wallet's
   * definite answer as failed; anything else is pending.
   */
  lookupPayment?(paymentHash: string): Promise<PaymentLookup>
}
