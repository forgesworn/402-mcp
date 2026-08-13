export type WalletMethod = 'nwc' | 'cashu' | 'human'

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
}

export interface WalletProvider {
  method: WalletMethod
  available: boolean
  payInvoice(invoice: string, options?: PayInvoiceOptions): Promise<PaymentResult>
}
