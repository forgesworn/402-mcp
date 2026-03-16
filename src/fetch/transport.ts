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

type TransportType = 'onion' | 'hns' | 'https' | 'http'

function classifyUrl(url: string): TransportType {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'http'
  }

  const hostname = parsed.hostname.toLowerCase()

  if (hostname.endsWith('.onion')) return 'onion'

  const tld = hostname.split('.').pop() ?? ''
  if (!COMMON_TLDS.has(tld)) return 'hns'

  if (parsed.protocol === 'https:') return 'https'
  return 'http'
}

/**
 * Filter and sort URLs by client capabilities and preference order.
 *
 * - .onion URLs are filtered out when `hasTorProxy` is false
 * - URLs are sorted by `preference` order (lower index = higher priority)
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
    const type = classifyUrl(url)
    if (type === 'onion' && !capabilities.hasTorProxy) return false
    return true
  })

  // Sort by preference index (stable — Array.prototype.sort is stable in Node 18+)
  return filtered.slice().sort((a, b) => {
    const typeA = classifyUrl(a)
    const typeB = classifyUrl(b)
    const idxA = preference.indexOf(typeA)
    const idxB = preference.indexOf(typeB)
    // Not in preference list → place at end (index = Infinity)
    const posA = idxA === -1 ? Infinity : idxA
    const posB = idxB === -1 ? Infinity : idxB
    return posA - posB
  })
}
