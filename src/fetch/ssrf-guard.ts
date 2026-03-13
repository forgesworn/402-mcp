import { promises as dns } from 'node:dns'
import { SsrfError } from './errors.js'

function isBlockedIp(address: string, family: number): string | null {
  if (family === 6) {
    const lower = address.toLowerCase()
    if (lower === '::1') return 'loopback'
    if (lower === '::') return 'unspecified'

    // fe80::/10 covers fe80:: through febf:: (check first 10 bits)
    const firstGroup = parseInt(lower.split(':')[0] || '0', 16)
    if ((firstGroup & 0xffc0) === 0xfe80) return 'link-local'

    if (lower.startsWith('fc') || lower.startsWith('fd')) return 'private IP (ULA)'

    // IPv4-mapped IPv6: dotted-quad form (::ffff:127.0.0.1)
    const v4Match = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (v4Match) return isBlockedIp(v4Match[1], 4)

    // IPv4-mapped IPv6: hex form (::ffff:7f00:1 = 127.0.0.1)
    const hexV4Match = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (hexV4Match) {
      const hi = parseInt(hexV4Match[1], 16)
      const lo = parseInt(hexV4Match[2], 16)
      const mapped = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
      return isBlockedIp(mapped, 4)
    }

    // NAT64 well-known prefix (64:ff9b::/96) — embeds IPv4 in low 32 bits
    const nat64Match = lower.match(/^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (nat64Match) {
      const hi = parseInt(nat64Match[1], 16)
      const lo = parseInt(nat64Match[2], 16)
      const mapped = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
      return isBlockedIp(mapped, 4)
    }
    const nat64DotMatch = lower.match(/^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/)
    if (nat64DotMatch) return isBlockedIp(nat64DotMatch[1], 4)

    return null
  }

  // Validate IPv4 format before parsing
  const parts = address.split('.')
  if (parts.length !== 4) return 'malformed IPv4'
  const nums = parts.map(Number)
  if (nums.some(n => !Number.isFinite(n) || n < 0 || n > 255)) return 'malformed IPv4'
  const [a, b] = nums

  if (a === 127) return 'loopback'
  if (a === 10) return 'private IP'
  if (a === 172 && b >= 16 && b <= 31) return 'private IP'
  if (a === 192 && b === 168) return 'private IP'
  if (a === 169 && b === 254) return 'link-local'
  if (a === 0) return 'unspecified'
  if (a === 100 && b >= 64 && b <= 127) return 'CGNAT'
  if (a >= 240) return 'reserved (Class E)'
  if (a === 192 && b === 0 && nums[2] === 0) return 'IETF protocol assignment'
  if (a === 192 && b === 0 && nums[2] === 2) return 'documentation (TEST-NET-1)'
  if (a === 198 && b === 51 && nums[2] === 100) return 'documentation (TEST-NET-2)'
  if (a === 203 && b === 0 && nums[2] === 113) return 'documentation (TEST-NET-3)'
  if (a === 198 && b >= 18 && b <= 19) return 'benchmarking'
  if (a === 255 && b === 255 && nums[2] === 255 && nums[3] === 255) return 'broadcast'

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
