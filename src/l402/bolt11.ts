import { decode } from 'light-bolt11-decoder'

export interface DecodedInvoice {
  costSats: number | null
  paymentHash: string | null
  expiry: number
}

/** Decodes a BOLT-11 Lightning invoice to extract amount, payment hash, and expiry. */
export function decodeBolt11(invoice: string): DecodedInvoice {
  try {
    const { sections } = decode(invoice)

    const amountSection = sections.find(s => s.name === 'amount')
    const costSats = amountSection && 'value' in amountSection
      ? Math.floor(Number(amountSection.value) / 1000)
      : null

    const hashSection = sections.find(s => s.name === 'payment_hash')
    const paymentHash = hashSection && 'value' in hashSection
      ? (hashSection.value as string)
      : null

    const expirySection = sections.find(s => s.name === 'expiry')
    const expiry = expirySection && 'value' in expirySection
      ? (expirySection.value as number)
      : 3600

    return { costSats, paymentHash, expiry }
  } catch {
    return { costSats: null, paymentHash: null, expiry: 3600 }
  }
}
