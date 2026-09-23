import { fetch as undiciFetch, Socks5ProxyAgent } from 'undici'

/**
 * Where outbound requests go through a SOCKS5 proxy.
 *
 * - `onion`: only `.onion` hosts use the proxy (TOR_PROXY).
 * - `all`: every request uses the proxy (SOCKS_PROXY), and this process never
 *   resolves a target host name itself.
 */
export type ProxyScope = 'onion' | 'all'

export interface ProxyRoute {
  scope: ProxyScope
  fetchFn: typeof fetch
}

/**
 * Parse and normalise a SOCKS5 proxy URL from configuration.
 *
 * Accepts `socks5://`, `socks5h://` and `socks://`. All three mean the same
 * thing here: host names are always sent to the proxy to resolve, never looked
 * up locally, so `socks5h` needs no special handling. Anything else is refused
 * at startup rather than silently sending traffic around the proxy.
 */
export function parseSocksProxyUrl(name: string, raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${name} must be a SOCKS5 URL such as socks5h://127.0.0.1:9050; got an unparseable value`)
  }
  if (!['socks5:', 'socks5h:', 'socks:'].includes(url.protocol)) {
    throw new Error(`${name} must use socks5://, socks5h:// or socks://; got ${url.protocol}//`)
  }
  if (!url.hostname || !url.port) {
    throw new Error(`${name} must include a host and port, e.g. socks5h://127.0.0.1:9050`)
  }
  if (url.pathname.replace(/\/$/, '') || url.search || url.hash) {
    throw new Error(`${name} must not include a path, query or fragment`)
  }
  const auth = url.username ? `${url.username}${url.password ? `:${url.password}` : ''}@` : ''
  return `socks5://${auth}${url.host}`
}

/** A fetch that tunnels every request through the given SOCKS5 proxy. */
export function createSocksFetch(proxyUrl: string): typeof fetch {
  const dispatcher = new Socks5ProxyAgent(proxyUrl)
  return ((input: string | URL, init?: RequestInit) =>
    undiciFetch(input, { ...init, dispatcher } as Parameters<typeof undiciFetch>[1])) as unknown as typeof fetch
}

/** Whether a request to this host goes through the proxy. */
export function usesProxy(route: ProxyRoute | undefined, hostname: string): boolean {
  if (!route) return false
  return route.scope === 'all' || hostname.toLowerCase().replace(/\.$/, '').endsWith('.onion')
}
