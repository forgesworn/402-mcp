import { validateUrl, type ResolvedAddress } from './ssrf-guard.js'
import { SsrfError, TimeoutError, RetryExhaustedError, DowngradeError, ResponseTooLargeError } from './errors.js'

export interface ResilientFetchOptions {
  timeoutMs?: number
  retries?: number
  retryOn?: (status: number) => boolean
  backoffMs?: number
}

export interface ResilientFetchConfig {
  timeoutMs?: number
  retries?: number
  retryOn?: (status: number) => boolean
  backoffMs?: number
  maxResponseBytes?: number
  ssrfAllowPrivate?: boolean
}

const MAX_REDIRECTS = 5
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_RETRIES = 2
const DEFAULT_BACKOFF_MS = 1_000
const JITTER_FACTOR = 0.25

function defaultRetryOn(status: number): boolean {
  return status >= 500
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status)
}

function jitteredDelay(baseMs: number): number {
  const jitter = baseMs * JITTER_FACTOR * (2 * Math.random() - 1)
  return Math.max(0, baseMs + jitter)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * For plain HTTP URLs, rewrite the hostname to the resolved IP address so
 * that `fetch()` connects to the same IP that passed SSRF validation. This
 * closes the DNS rebinding TOCTOU window where an attacker's DNS could return
 * a public IP for validation then a private IP for the actual connection.
 *
 * For HTTPS URLs this is not possible because TLS certificate validation
 * requires the original hostname. HTTPS is inherently resistant to DNS
 * rebinding; an attacker cannot present a valid certificate for the target
 * hostname from a private IP.
 *
 * Returns `{ pinnedUrl, hostHeader }` where `hostHeader` is the original
 * Host value to send (only set when the URL was rewritten).
 */
function pinUrlToResolvedIp(
  url: string,
  resolved: ResolvedAddress | undefined,
): { pinnedUrl: string; hostHeader: string | undefined } {
  if (!resolved) return { pinnedUrl: url, hostHeader: undefined }

  const parsed = new URL(url)
  if (parsed.protocol !== 'http:') return { pinnedUrl: url, hostHeader: undefined }

  const originalHost = parsed.host // includes port if present
  const { address, family } = resolved
  const ipLiteral = family === 6 ? `[${address}]` : address

  parsed.hostname = ipLiteral
  return { pinnedUrl: parsed.toString(), hostHeader: originalHost }
}

/**
 * Create a resilient fetch function with SSRF protection, timeout, and retry.
 *
 * The returned function is signature-compatible with `typeof fetch` when called
 * with two args, and accepts an optional third arg for per-call overrides.
 */
export function createResilientFetch(
  fetchFn: typeof fetch,
  config: ResilientFetchConfig = {},
): (url: string | URL, init?: RequestInit, options?: ResilientFetchOptions) => Promise<Response> {
  const globalTimeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const globalRetries = config.retries ?? DEFAULT_RETRIES
  const globalRetryOn = config.retryOn ?? defaultRetryOn
  const globalBackoff = config.backoffMs ?? DEFAULT_BACKOFF_MS
  const globalMaxResponseBytes = config.maxResponseBytes ?? 0
  const allowPrivate = config.ssrfAllowPrivate ?? false

  return async function resilientFetch(
    url: string | URL,
    init?: RequestInit,
    options?: ResilientFetchOptions,
  ): Promise<Response> {
    const timeoutMs = options?.timeoutMs ?? globalTimeout
    const retries = options?.retries ?? globalRetries
    const retryOn = options?.retryOn ?? globalRetryOn
    const backoffMs = options?.backoffMs ?? globalBackoff
    const urlStr = url.toString()

    // SSRF check on the initial URL (never retried).
    // The resolved address is used to pin HTTP connections to the validated IP,
    // closing the DNS rebinding TOCTOU window.
    const resolved = await validateUrl(urlStr, allowPrivate)

    const totalAttempts = 1 + retries
    let lastError: Error | undefined

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      if (attempt > 0) {
        const delay = jitteredDelay(backoffMs * Math.pow(2, attempt - 1))
        await sleep(delay)
      }

      try {
        let response = await fetchWithTimeoutAndRedirects(
          fetchFn, urlStr, init, timeoutMs, allowPrivate, urlStr, resolved,
        )

        // If retryable status and we have retries left, continue
        if (retryOn(response.status) && attempt < totalAttempts - 1) {
          lastError = new Error(`HTTP ${response.status}`)
          continue
        }

        if (globalMaxResponseBytes > 0) {
          const reader = response.body?.getReader()
          if (reader) {
            const chunks: Uint8Array[] = []
            let totalBytes = 0
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              totalBytes += value.byteLength
              if (totalBytes > globalMaxResponseBytes) {
                reader.cancel()
                throw new ResponseTooLargeError(globalMaxResponseBytes)
              }
              chunks.push(value)
            }
            const buffered = new Blob(chunks as BlobPart[])
            response = new Response(buffered, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            })
          }
        }

        return response
      } catch (err) {
        // SSRF errors are never retried (redirect to private IP)
        if (err instanceof SsrfError) throw err

        lastError = err as Error

        // Timeouts and network errors are retryable
        if (attempt < totalAttempts - 1) {
          continue
        }
      }
    }

    // Final attempt failed
    if (retries === 0) throw lastError!
    throw new RetryExhaustedError(totalAttempts, urlStr, lastError!)
  }
}

async function fetchWithTimeoutAndRedirects(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  allowPrivate: boolean,
  originalUrl: string,
  resolved?: ResolvedAddress,
): Promise<Response> {
  let currentUrl = url
  let currentInit = init ? { ...init } : {}
  let redirectCount = 0
  let currentResolved = resolved

  while (true) {
    // Pin HTTP URLs to the validated IP to prevent DNS rebinding
    const { pinnedUrl, hostHeader } = pinUrlToResolvedIp(currentUrl, currentResolved)

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    const fetchInit: RequestInit = {
      ...currentInit,
      signal: controller.signal,
      redirect: 'manual',
    }

    // When we rewrote the hostname to an IP, send the original Host header
    // so the upstream server can route the request correctly.
    if (hostHeader) {
      const headers = new Headers(fetchInit.headers)
      headers.set('Host', hostHeader)
      fetchInit.headers = headers
    }

    let response: Response
    try {
      response = await fetchFn(pinnedUrl, fetchInit)
    } catch (err) {
      clearTimeout(timeoutId)
      if (controller.signal.aborted) {
        throw new TimeoutError(timeoutMs, currentUrl)
      }
      throw err
    }

    clearTimeout(timeoutId)

    if (!isRedirect(response.status)) {
      return response
    }

    // Handle redirect
    redirectCount++
    if (redirectCount > MAX_REDIRECTS) {
      throw new Error(`Too many redirects (${MAX_REDIRECTS})`)
    }

    const location = response.headers.get('location')
    if (!location) return response

    // Resolve relative URLs against the original (non-pinned) URL
    currentUrl = new URL(location, currentUrl).toString()

    // Block HTTPS-to-HTTP downgrade
    if (new URL(originalUrl).protocol === 'https:' && new URL(currentUrl).protocol === 'http:') {
      throw new DowngradeError(originalUrl, currentUrl)
    }

    // SSRF check on redirect target; capture the resolved address for pinning
    currentResolved = await validateUrl(currentUrl, allowPrivate)

    // 301/302/303 change POST to GET and drop body
    if ([301, 302, 303].includes(response.status)) {
      const method = currentInit.method?.toUpperCase()
      if (method && method !== 'GET' && method !== 'HEAD') {
        currentInit = { ...currentInit, method: 'GET', body: undefined }
      }
    }
    // 307/308 preserve method and body (no change needed)
  }
}
