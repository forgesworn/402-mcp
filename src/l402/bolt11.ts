import { msatsToSatsFloor, tryDecodeBolt11 } from 'farrier-kit/bolt11'

export interface DecodedInvoice {
  costSats: number | null
  paymentHash: string | null
  expiry: number
}

/** Decodes a BOLT-11 Lightning invoice to extract amount, payment hash, and expiry. */
export function decodeBolt11(invoice: string): DecodedInvoice {
  const decoded = tryDecodeBolt11(invoice)
  if (!decoded) {
    return { costSats: null, paymentHash: null, expiry: 3600 }
  }

  return {
    costSats: decoded.amountMsats === null ? null : msatsToSatsFloor(decoded.amountMsats),
    paymentHash: decoded.paymentHashHex,
    expiry: decoded.expirySeconds,
  }
}
