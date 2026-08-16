import { bech32 } from '@scure/base'
import { isValidHex64 } from 'farrier-kit'

/**
 * A wallet never shows a bare note secret. LUD-25 defines the note as the
 * withdraw LNURL carrying the secret as its `k1`, and wallets display that as
 * bech32 (`LNURL1...`) or `lnurlw://`. So the secret always arrives wrapped,
 * and the wrapper carries the mint origin with it.
 */
export interface ParsedNote {
  /** The bearer secret (`k1`), 64 hex chars. */
  secret: string
  /** Mint origin, e.g. `https://mint.example.com`, when the input carried one. */
  mint?: string
}

/** LNURL bech32 has no useful length ceiling; the default 90 rejects real notes. */
const BECH32_LIMIT = 2000

function decodeBech32Lnurl(input: string): string | null {
  try {
    const decoded = bech32.decode(input.toLowerCase() as `${string}1${string}`, BECH32_LIMIT)
    if (decoded.prefix !== 'lnurl') return null
    return new TextDecoder().decode(bech32.fromWords(decoded.words))
  } catch {
    return null
  }
}

function fromUrl(raw: string): ParsedNote | null {
  let url: URL
  try {
    // LUD-17: lnurlw:// is the https URL under a scheme that marks it a
    // withdraw link. Onion hosts are the documented http exception.
    url = new URL(raw.replace(/^lnurlw:\/\//i, raw.includes('.onion') ? 'http://' : 'https://'))
  } catch {
    return null
  }
  const k1 = url.searchParams.get('k1')
  if (!k1 || !isValidHex64(k1)) return null
  return { secret: k1.toLowerCase(), mint: url.origin }
}

/**
 * Accepts any form a wallet or QR code hands over: a bech32 `LNURL1...` string,
 * an `lnurlw://` or `https://` withdraw URL, or a bare 64-hex secret. Returns
 * null rather than throwing, since the input is frequently a paste error and
 * the value is a bearer secret that must not reach an exception message.
 */
export function parseNote(input: string): ParsedNote | null {
  const trimmed = input.trim().replace(/^lightning:/i, '')
  if (trimmed.length === 0) return null

  if (isValidHex64(trimmed)) return { secret: trimmed.toLowerCase() }

  if (/^lnurl1/i.test(trimmed)) {
    const url = decodeBech32Lnurl(trimmed)
    return url === null ? null : fromUrl(url)
  }

  return fromUrl(trimmed)
}
