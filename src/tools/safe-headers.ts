/**
 * Whitelist of response headers safe to expose to AI agents.
 * Excludes authentication tokens, cookies, and internal server details.
 */
const SAFE_HEADERS = new Set([
  'content-type',
  'content-length',
  'content-encoding',
  'cache-control',
  'etag',
  'last-modified',
  'date',
  'x-credit-balance',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'retry-after',
  'access-control-allow-origin',
  'vary',
])

/** Returns only whitelisted response headers, stripping security-sensitive values. */
export function filterResponseHeaders(headers: Headers): Record<string, string> {
  const filtered: Record<string, string> = {}
  for (const [key, value] of headers.entries()) {
    if (SAFE_HEADERS.has(key.toLowerCase())) {
      filtered[key] = value
    }
  }
  return filtered
}
