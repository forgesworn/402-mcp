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

/** A whole number of sats that survives the conversion to msat everything downstream works in. */
function satsFrom(value: unknown): number | null {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^[0-9]+$/.test(value)
        ? Number(value)
        : NaN
  if (!Number.isSafeInteger(n) || n <= 0) return null
  return Number.isSafeInteger(n * 1000) ? n : null
}

function stringsFrom(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out = value.filter((m): m is string => typeof m === 'string' && m.length > 0)
  return out.length > 0 ? out : null
}

/**
 * Parses an lnurlcash payment request from the X-LNURLcash header value:
 * `lnurlcashreq1` followed by unpadded base64url of the request's RFC 8785
 * canonical JSON.
 *
 * The request is `{ v, id, amount, currency, methodDetails: { mints } }`,
 * with the amount a decimal STRING of whole sats. That is the shape the
 * conformance vectors pin and `lnurlcash-kit` encodes.
 *
 * A shorter object, `{ a: number, u, m }`, briefly went out under the same
 * prefix before the format settled. It is still read here, because a decoder
 * that returns nothing on a string it can plainly understand helps no one,
 * and because the kit's own decoder accepts it too. Nothing emits it.
 *
 * Only `sat` exists today; anything else returns null rather than guessing at
 * a denomination.
 */
export function parseLnurlcashChallenge(header: string): LnurlcashChallenge | null {
  if (!header.startsWith(PREFIX)) return null

  try {
    const b64 = header.slice(PREFIX.length)
    const json = Buffer.from(b64, 'base64url').toString('utf-8')
    const data = JSON.parse(json) as Record<string, unknown>
    if (typeof data !== 'object' || data === null) return null

    const details = data.methodDetails
    const longForm = data.amount !== undefined || data.v !== undefined

    const amount = satsFrom(longForm ? data.amount : data.a)
    const currency = longForm ? data.currency : data.u
    const mints = stringsFrom(
      longForm
        ? typeof details === 'object' && details !== null
          ? (details as Record<string, unknown>).mints
          : undefined
        : data.m,
    )

    if (amount === null || currency !== 'sat' || !mints) return null

    return { amount, unit: 'sat', mints }
  } catch {
    return null
  }
}
