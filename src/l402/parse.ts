export interface L402Challenge {
  macaroon: string
  invoice: string
}

export function parseL402Challenge(header: string): L402Challenge | null {
  const match = header.match(/^(?:L402|LSAT)\s+(.+)$/i)
  if (!match) return null

  const params = match[1]

  const macaroonMatch = params.match(/macaroon="([A-Za-z0-9_\-=]+)"|macaroon=([A-Za-z0-9_\-=]+)(?:[,\s]|$)/)
  const invoiceMatch = params.match(/invoice="(lnbc[A-Za-z0-9]+)"|invoice=(lnbc[A-Za-z0-9]+)(?:[,\s]|$)/)

  if (!macaroonMatch || !invoiceMatch) return null

  return {
    macaroon: macaroonMatch[1] ?? macaroonMatch[2],
    invoice: invoiceMatch[1] ?? invoiceMatch[2],
  }
}
