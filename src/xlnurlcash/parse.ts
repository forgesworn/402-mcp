export interface LnurlcashChallenge {
  /** Price in sats. */
  amount: number
  unit: 'sat'
  /** Mints whose notes the server will accept, as hosts or URLs. */
  mints: string[]
}

/**
 * Payment requests are prefixed like a bech32 human-readable part so a bare
 * string is self-describing, the way NUT-18 uses `creqA`.
 */
const PREFIX = 'lnurlcashreq1'

/** Detects whether a 402 response carries an lnurlcash challenge. */
export function isLnurlcashChallenge(headers: Headers): boolean {
  const value = headers.get('x-lnurlcash')
  return !!value && value.startsWith(PREFIX)
}

/**
 * Parses an lnurlcash payment request from the X-LNURLcash header value.
 * Format: lnurlcashreq1<base64url-json> where JSON is { a: number, u: string,
 * m: string[] }. Only unit 'sat' exists today; anything else returns null
 * rather than guessing at a denomination.
 */
export function parseLnurlcashChallenge(header: string): LnurlcashChallenge | null {
  if (!header.startsWith(PREFIX)) return null

  try {
    const b64 = header.slice(PREFIX.length)
    const json = Buffer.from(b64, 'base64url').toString('utf-8')
    const data = JSON.parse(json) as Record<string, unknown>

    // A price is only usable if it survives the conversion to msat that both
    // note selection and the mint work in, so the ceiling is checked here.
    const amount = typeof data.a === 'number' && Number.isSafeInteger(data.a) && data.a > 0
      && Number.isSafeInteger(data.a * 1000)
      ? data.a
      : null
    const unit = data.u
    const mints = Array.isArray(data.m) ? data.m.filter((m): m is string => typeof m === 'string') : null

    if (amount === null || unit !== 'sat' || !mints || mints.length === 0) return null

    return { amount, unit: 'sat', mints }
  } catch {
    return null
  }
}
