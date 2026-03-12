import { promises as dns } from 'node:dns'
import { SsrfError } from './errors.js'

function isBlockedIp(address: string, family: number): string | null {
  if (family === 6) {
    const lower = address.toLowerCase()
    if (lower === '::1') return 'loopback'
    if (lower.startsWith('fe80:')) return 'link-local'
    const v4Match = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (v4Match) return isBlockedIp(v4Match[1], 4)
    return null
  }

  const parts = address.split('.').map(Number)
  const [a, b] = parts

  if (a === 127) return 'loopback'
  if (a === 10) return 'private IP'
  if (a === 172 && b >= 16 && b <= 31) return 'private IP'
  if (a === 192 && b === 168) return 'private IP'
  if (a === 169 && b === 254) return 'link-local'
  if (a === 0) return 'unspecified'

  return null
}

export interface ResolvedAddress {
  address: string
  family: number
}

/**
 * Validate a URL against SSRF rules and return the resolved IP address.
 *
 * Returns the DNS-resolved address so callers can pin the connection to the
 * validated IP, closing the DNS rebinding TOCTOU window for plain HTTP.
 * For HTTPS the caller cannot rewrite the hostname (TLS certificate validation
 * requires the original hostname), but HTTPS is inherently resistant to DNS
 * rebinding because the attacker cannot present a valid TLS certificate for
 * the target hostname from a private IP.
 *
 * When `allowPrivate` is true, no resolution or validation is performed and
 * `undefined` is returned.
 */
export async function validateUrl(url: string, allowPrivate = false): Promise<ResolvedAddress | undefined> {
  if (allowPrivate) return undefined

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new SsrfError('invalid URL', url)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfError(`non-HTTP scheme: ${parsed.protocol}`, url)
  }

  const hostname = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '')

  const { address, family } = await dns.lookup(hostname)
  const reason = isBlockedIp(address, family)
  if (reason) {
    throw new SsrfError(reason, url)
  }

  return { address, family }
}
