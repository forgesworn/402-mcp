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

export interface WalletProvider {
  method: WalletMethod
  available: boolean
  payInvoice(invoice: string, options?: PayInvoiceOptions): Promise<PaymentResult>
}
