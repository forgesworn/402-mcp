export interface ServerInfo {
  type: 'toll-booth' | 'generic'
}

/** Detects whether the server is a toll-booth instance from response headers and body shape. */
export function detectServer(headers: Headers, body: unknown): ServerInfo {
  const poweredBy = headers.get('x-powered-by')
  if (poweredBy?.toLowerCase() === 'toll-booth') {
    return { type: 'toll-booth' }
  }

  if (
    body !== null &&
    typeof body === 'object' &&
    'payment_url' in body &&
    'amount_sats' in body &&
    'payment_hash' in body
  ) {
    return { type: 'toll-booth' }
  }

  return { type: 'generic' }
}
