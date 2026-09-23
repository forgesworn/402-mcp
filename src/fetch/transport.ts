export interface TransportCapabilities {
  hasTorProxy: boolean
}

/**
 * Well-known TLDs that are NOT Handshake names.
 * Anything outside this set is treated as a potential HNS name (heuristic only).
 */
const COMMON_TLDS = new Set([
  'com', 'org', 'net', 'io', 'dev', 'app', 'ai', 'co', 'uk', 'us', 'eu',
  'de', 'fr', 'nl', 'au', 'ca', 'jp', 'cn', 'br', 'in', 'ru', 'it', 'es',
  'info', 'biz', 'name', 'mobi', 'pro', 'tel', 'travel', 'museum', 'coop',
  'aero', 'xxx', 'edu', 'gov', 'mil', 'int', 'arpa',
  'xyz', 'online', 'site', 'tech', 'store', 'shop', 'blog', 'cloud', 'digital',
  'media', 'news', 'tv', 'radio', 'email', 'domains', 'link', 'click', 'top',
  'live', 'fun', 'today', 'world', 'global', 'network', 'systems', 'services',
  'agency', 'solutions', 'group', 'team', 'space', 'zone', 'works', 'tools',
  'me', 'cc', 'to', 'id', 'ws', 'fm', 'am', 'pm', 'ac', 'im',
  // Country codes that see common non-country usage
  'ly', 'gg', 'gg', 'sh', 'io',
])

/**
 * TLDs that are Handshake names and not ICANN ones. A TLD merely missing
 * from COMMON_TLDS is far more often an ICANN TLD this list does not know
 * (.pub, .fyi, and hundreds more) than a Handshake one.
 */
const KNOWN_HNS_TLDS = new Set(['hns'])

type TransportType = 'onion' | 'hns' | 'https' | 'http'

/** `guessed` marks an HNS classification made only because the TLD is unfamiliar. */
function classifyUrl(url: string): { type: TransportType; guessed: boolean } {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { type: 'http', guessed: false }
  }

  const hostname = parsed.hostname.toLowerCase()

  if (hostname.endsWith('.onion')) return { type: 'onion', guessed: false }

  const tld = hostname.split('.').pop() ?? ''
  if (KNOWN_HNS_TLDS.has(tld)) return { type: 'hns', guessed: false }
  if (!COMMON_TLDS.has(tld)) return { type: 'hns', guessed: true }

  if (parsed.protocol === 'https:') return { type: 'https', guessed: false }
  return { type: 'http', guessed: false }
}

/**
 * Where a URL sorts under `preference`. A guessed HNS name sorts just after
 * both the hns and https tiers, so an unfamiliar ICANN TLD never jumps ahead
 * of a service's ordinary HTTPS endpoint.
 */
function rank(url: string, preference: string[]): number {
  const { type, guessed } = classifyUrl(url)
  const idx = preference.indexOf(type)
  if (idx === -1) return Infinity
  if (!guessed) return idx
  const httpsIdx = preference.indexOf('https')
  return Math.max(idx, httpsIdx) + 0.5
}

/**
 * Filter and sort URLs by client capabilities and preference order.
 *
 * - .onion URLs are filtered out when `hasTorProxy` is false
 * - URLs are sorted by `preference` order (lower index = higher priority)
 * - A TLD that is neither familiar nor known to be Handshake sorts after https
 * - URLs whose transport type is not in the preference list are placed last
 * - Relative order is preserved within the same tier (stable sort)
 */
export function selectTransports(
  urls: string[],
  preference: string[],
  capabilities: TransportCapabilities,
): string[] {
  // Filter: remove .onion URLs when no Tor proxy is available
  const filtered = urls.filter(url => {
    const { type } = classifyUrl(url)
    if (type === 'onion' && !capabilities.hasTorProxy) return false
    return true
  })

  // Sort by preference rank (stable — Array.prototype.sort is stable in Node 18+).
  // Not in the preference list → Infinity, placed at the end.
  return filtered.slice().sort((a, b) => {
    const posA = rank(a, preference)
    const posB = rank(b, preference)
    if (posA === posB) return 0
    return posA - posB
  })
}
