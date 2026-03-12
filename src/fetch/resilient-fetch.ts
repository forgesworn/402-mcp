import { validateUrl } from './ssrf-guard.js'
import { SsrfError, TimeoutError, RetryExhaustedError, DowngradeError } from './errors.js'

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

    // SSRF check on the initial URL (never retried)
    await validateUrl(urlStr, allowPrivate)

    const totalAttempts = 1 + retries
    let lastError: Error | undefined

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      if (attempt > 0) {
        const delay = jitteredDelay(backoffMs * Math.pow(2, attempt - 1))
        await sleep(delay)
      }

      try {
        const response = await fetchWithTimeoutAndRedirects(
          fetchFn, urlStr, init, timeoutMs, allowPrivate, urlStr,
        )

        // If retryable status and we have retries left, continue
        if (retryOn(response.status) && attempt < totalAttempts - 1) {
          lastError = new Error(`HTTP ${response.status}`)
          continue
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
): Promise<Response> {
  let currentUrl = url
  let currentInit = init ? { ...init } : {}
  let redirectCount = 0

  while (true) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    const fetchInit: RequestInit = {
      ...currentInit,
      signal: controller.signal,
      redirect: 'manual',
    }

    let response: Response
    try {
      response = await fetchFn(currentUrl, fetchInit)
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

    // Resolve relative URLs
    currentUrl = new URL(location, currentUrl).toString()

    // Block HTTPS-to-HTTP downgrade
    if (new URL(originalUrl).protocol === 'https:' && new URL(currentUrl).protocol === 'http:') {
      throw new DowngradeError(originalUrl, currentUrl)
    }

    // SSRF check on redirect target
    await validateUrl(currentUrl, allowPrivate)

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
