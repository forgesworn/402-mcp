/**
 * IETF Payment authentication challenge parser (draft-ryan-httpauth-payment-01).
 *
 * Detects and parses `WWW-Authenticate: Payment` challenges. When the method
 * is `lightning`, decodes the base64url charge request to extract the BOLT11
 * invoice and payment hash.
 */

export interface IETFPaymentChallenge {
  /** HMAC-SHA256 challenge binding ID. */
  id: string
  /** Protection space (e.g. 'api.example.com'). */
  realm: string
  /** Payment method (e.g. 'lightning'). */
  method: string
  /** Payment intent (e.g. 'charge', 'session'). */
  intent: string
  /** Base64url-encoded JCS charge request. */
  request: string
  /** RFC 3339 expiry timestamp. */
  expires?: string
  /** Human-readable service description. */
  description?: string
  // Decoded from request when method is 'lightning':
  /** BOLT11 invoice string. */
  invoice?: string
  /** Payment hash (64-char hex). */
  paymentHash?: string
  /** Amount in satoshis. */
  amountSats?: number
}

/**
 * Detects whether a 402 response contains an IETF Payment challenge.
 * Handles multi-scheme WWW-Authenticate headers (e.g. L402 + Payment).
 */
export function isIETFPaymentChallenge(headers: Headers): boolean {
  const auth = headers.get('www-authenticate') ?? ''
  return /(?:^|,\s*)Payment\s/i.test(auth)
}

/** Extracts a quoted or unquoted parameter value from an auth-param string. */
function extractParam(params: string, name: string): string | undefined {
  // Quoted: name="value"
  const quotedRe = new RegExp(`${name}="([^"]*)"`)
  const quoted = params.match(quotedRe)
  if (quoted) return quoted[1]

  // Unquoted: name=value (terminated by comma, space, or end)
  const unquotedRe = new RegExp(`${name}=([^,\\s"]+)`)
  const unquoted = params.match(unquotedRe)
  return unquoted?.[1]
}

/**
 * Parses an IETF Payment challenge from a WWW-Authenticate header value.
 * Supports multi-scheme headers — extracts the Payment portion.
 */
export function parseIETFPaymentChallenge(header: string): IETFPaymentChallenge | null {
  // Find the Payment scheme — may be preceded by other schemes (L402, Bearer, etc.)
  const paymentMatch = header.match(/(?:^|,\s*)Payment\s+(.+)/i)
  if (!paymentMatch) return null

  // Take everything after "Payment " — stop at the next scheme if present
  // (schemes are separated by comma-space-uppercase)
  let params = paymentMatch[1]
  const nextScheme = params.search(/,\s*(?:L402|LSAT|Bearer|Basic|Digest)\s/i)
  if (nextScheme !== -1) params = params.substring(0, nextScheme)

  const id = extractParam(params, 'id')
  const realm = extractParam(params, 'realm')
  const method = extractParam(params, 'method')
  const intent = extractParam(params, 'intent')
  const request = extractParam(params, 'request')
  const expires = extractParam(params, 'expires')
  const description = extractParam(params, 'description')

  if (!id || !realm || !method || !intent || !request) return null

  const result: IETFPaymentChallenge = { id, realm, method, intent, request }
  if (expires) result.expires = expires
  if (description) result.description = description

  // Decode Lightning charge request
  if (method === 'lightning') {
    try {
      const decoded = JSON.parse(Buffer.from(request, 'base64url').toString()) as Record<string, unknown>
      const details = decoded.methodDetails as Record<string, unknown> | undefined
      if (details) {
        if (typeof details.invoice === 'string') result.invoice = details.invoice
        if (typeof details.paymentHash === 'string') result.paymentHash = details.paymentHash
      }
      const amount = parseInt(String(decoded.amount), 10)
      if (Number.isFinite(amount) && amount > 0) result.amountSats = amount
    } catch { /* non-decodable request — still return the parsed challenge */ }
  }

  return result
}
