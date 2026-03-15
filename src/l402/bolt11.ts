import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const bolt11Lib = require('bolt11') as typeof import('bolt11')

export interface DecodedInvoice {
  costSats: number | null
  paymentHash: string | null
  expiry: number
}

/** Decodes a BOLT-11 Lightning invoice to extract amount, payment hash, and expiry. */
export function decodeBolt11(invoice: string): DecodedInvoice {
  try {
    const decoded = bolt11Lib.decode(invoice)

    let costSats: number | null = null
    if (decoded.satoshis != null) {
      costSats = decoded.satoshis
    } else if (decoded.millisatoshis != null) {
      costSats = Math.floor(Number(decoded.millisatoshis) / 1000)
    }

    const paymentHash = decoded.tagsObject.payment_hash ?? null

    const expiry = typeof decoded.timeExpireDate === 'number' && typeof decoded.timestamp === 'number'
      ? decoded.timeExpireDate - decoded.timestamp
      : 3600

    return { costSats, paymentHash, expiry }
  } catch {
    return { costSats: null, paymentHash: null, expiry: 3600 }
  }
}
