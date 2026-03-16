import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SsrfError, TimeoutError, RetryExhaustedError, DowngradeError, ResponseTooLargeError, TransportUnavailableError } from '../../src/fetch/errors.js'

// Mock the SSRF guard
const mockValidateUrl = vi.fn()
vi.mock('../../src/fetch/ssrf-guard.js', () => ({
  validateUrl: (...args: unknown[]) => mockValidateUrl(...args),
}))

const { createResilientFetch, withTransportFallback, isTransportError } = await import('../../src/fetch/resilient-fetch.js')

describe('createResilientFetch', () => {
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockFetch = vi.fn()
    mockValidateUrl.mockReset()
    // By default return a resolved address (simulates public IP validation).
    // Tests for allowPrivate mode override this to return undefined.
    mockValidateUrl.mockResolvedValue({ address: '93.184.216.34', family: 4 })
  })

  describe('SSRF guard integration', () => {
    it('calls validateUrl before fetch', async () => {
      mockFetch.mockResolvedValue(new Response('ok', { status: 200 }))
      const resilientFetch = createResilientFetch(mockFetch, { ssrfAllowPrivate: false })
      await resilientFetch('http://example.com')
      expect(mockValidateUrl).toHaveBeenCalledWith('http://example.com', false)
      expect(mockFetch).toHaveBeenCalled()
    })

    it('pins HTTP URL to resolved IP for fetch', async () => {
      mockValidateUrl.mockResolvedValue({ address: '93.184.216.34', family: 4 })
      mockFetch.mockResolvedValue(new Response('ok', { status: 200 }))
      const resilientFetch = createResilientFetch(mockFetch, { ssrfAllowPrivate: false })
      await resilientFetch('http://example.com/path')

      // fetch should receive the IP-pinned URL
      const fetchedUrl = mockFetch.mock.calls[0][0]
      expect(fetchedUrl).toBe('http://93.184.216.34/path')

      // Host header should carry the original hostname
      const fetchInit = mockFetch.mock.calls[0][1]
      const headers = new Headers(fetchInit.headers)
      expect(headers.get('Host')).toBe('example.com')
    })

    it('pins HTTP URL to resolved IPv6 address', async () => {
      mockValidateUrl.mockResolvedValue({ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 })
      mockFetch.mockResolvedValue(new Response('ok', { status: 200 }))
      const resilientFetch = createResilientFetch(mockFetch, { ssrfAllowPrivate: false })
      await resilientFetch('http://example.com/path')

      const fetchedUrl = mockFetch.mock.calls[0][0]
      expect(fetchedUrl).toBe('http://[2606:2800:220:1:248:1893:25c8:1946]/path')

      const fetchInit = mockFetch.mock.calls[0][1]
      const headers = new Headers(fetchInit.headers)
      expect(headers.get('Host')).toBe('example.com')
    })

    it('does not rewrite HTTPS URLs (TLS requires original hostname)', async () => {
      mockValidateUrl.mockResolvedValue({ address: '93.184.216.34', family: 4 })
      mockFetch.mockResolvedValue(new Response('ok', { status: 200 }))
      const resilientFetch = createResilientFetch(mockFetch, { ssrfAllowPrivate: false })
      await resilientFetch('https://example.com/path')

      const fetchedUrl = mockFetch.mock.calls[0][0]
      expect(fetchedUrl).toBe('https://example.com/path')

      // No Host header override needed
      const fetchInit = mockFetch.mock.calls[0][1]
      const headers = new Headers(fetchInit.headers)
      expect(headers.get('Host')).toBeNull()
    })

    it('does not fetch if SSRF guard throws', async () => {
      mockValidateUrl.mockRejectedValue(new SsrfError('private IP', 'http://10.0.0.1'))
      const resilientFetch = createResilientFetch(mockFetch, { ssrfAllowPrivate: false })
      await expect(resilientFetch('http://10.0.0.1')).rejects.toThrow(SsrfError)
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('passes ssrfAllowPrivate to validateUrl', async () => {
      mockValidateUrl.mockResolvedValue(undefined) // allowPrivate returns undefined
      mockFetch.mockResolvedValue(new Response('ok', { status: 200 }))
      const resilientFetch = createResilientFetch(mockFetch, { ssrfAllowPrivate: true })
      await resilientFetch('http://localhost:3000')
      expect(mockValidateUrl).toHaveBeenCalledWith('http://localhost:3000', true)

      // No pinning when allowPrivate (resolved is undefined);
      // URL passes through as-is (no URL parsing/reconstruction)
      const fetchedUrl = mockFetch.mock.calls[0][0]
      expect(fetchedUrl).toBe('http://localhost:3000')
    })
  })

  describe('timeout', () => {
    it('throws TimeoutError when request exceeds timeout', async () => {
      mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal
          if (signal) {
            signal.addEventListener('abort', () => reject(signal.reason))
          }
        })
      })

      const resilientFetch = createResilientFetch(mockFetch, {
        timeoutMs: 100,
        retries: 0,
      })

      await expect(resilientFetch('http://example.com')).rejects.toThrow(TimeoutError)
    }, 10_000)
  })

  describe('retry on network error', () => {
    it('retries on TypeError and succeeds', async () => {
      mockFetch
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }))

      const resilientFetch = createResilientFetch(mockFetch, {
        retries: 1,
        backoffMs: 1,
      })

      const res = await resilientFetch('http://example.com')
      expect(res.status).toBe(200)
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('retries on 5xx and succeeds', async () => {
      mockFetch
        .mockResolvedValueOnce(new Response('error', { status: 503 }))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }))

      const resilientFetch = createResilientFetch(mockFetch, {
        retries: 1,
        backoffMs: 1,
      })

      const res = await resilientFetch('http://example.com')
      expect(res.status).toBe(200)
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('retries on timeout and succeeds on next attempt', async () => {
      let callCount = 0
      mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
        callCount++
        if (callCount === 1) {
          return new Promise((_resolve, reject) => {
            const signal = init?.signal
            if (signal) {
              signal.addEventListener('abort', () => reject(signal.reason))
            }
          })
        }
        return new Response('ok', { status: 200 })
      })

      const resilientFetch = createResilientFetch(mockFetch, {
        retries: 1,
        timeoutMs: 100,
        backoffMs: 1,
      })

      const res = await resilientFetch('http://example.com')
      expect(res.status).toBe(200)
      expect(mockFetch).toHaveBeenCalledTimes(2)
    }, 10_000)

    it('throws RetryExhaustedError after all retries fail', async () => {
      mockFetch.mockRejectedValue(new TypeError('fetch failed'))

      const resilientFetch = createResilientFetch(mockFetch, {
        retries: 2,
        backoffMs: 1,
      })

      await expect(resilientFetch('http://example.com')).rejects.toThrow(RetryExhaustedError)
      expect(mockFetch).toHaveBeenCalledTimes(3)
    })
  })

  describe('no retry on 4xx', () => {
    it('returns 402 immediately without retry', async () => {
      mockFetch.mockResolvedValue(new Response('payment required', { status: 402 }))

      const resilientFetch = createResilientFetch(mockFetch, {
        retries: 2,
        backoffMs: 1,
      })

      const res = await resilientFetch('http://example.com')
      expect(res.status).toBe(402)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('returns 404 immediately without retry', async () => {
      mockFetch.mockResolvedValue(new Response('not found', { status: 404 }))

      const resilientFetch = createResilientFetch(mockFetch, {
        retries: 2,
        backoffMs: 1,
      })

      const res = await resilientFetch('http://example.com')
      expect(res.status).toBe(404)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('per-call options', () => {
    it('disables retry with { retries: 0 }', async () => {
      mockFetch.mockRejectedValue(new TypeError('fetch failed'))

      const resilientFetch = createResilientFetch(mockFetch, {
        retries: 2,
        backoffMs: 1,
      })

      await expect(
        resilientFetch('http://example.com', undefined, { retries: 0 }),
      ).rejects.toThrow(TypeError)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('redirect following with SSRF checks', () => {
    it('follows redirect and checks new URL', async () => {
      const redirectResponse = new Response(null, {
        status: 301,
        headers: { Location: 'http://other.example.com/api' },
      })
      const finalResponse = new Response('ok', { status: 200 })

      mockFetch
        .mockResolvedValueOnce(redirectResponse)
        .mockResolvedValueOnce(finalResponse)

      const resilientFetch = createResilientFetch(mockFetch, { retries: 0 })
      const res = await resilientFetch('http://example.com/old')

      expect(res.status).toBe(200)
      expect(mockValidateUrl).toHaveBeenCalledTimes(2)
      expect(mockValidateUrl).toHaveBeenCalledWith('http://other.example.com/api', false)
    })

    it('blocks redirect to private IP', async () => {
      const redirectResponse = new Response(null, {
        status: 302,
        headers: { Location: 'http://internal.corp/secret' },
      })

      mockFetch.mockResolvedValueOnce(redirectResponse)
      mockValidateUrl
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new SsrfError('private IP', 'http://internal.corp/secret'))

      const resilientFetch = createResilientFetch(mockFetch, { retries: 0 })
      await expect(resilientFetch('http://example.com')).rejects.toThrow(SsrfError)
    })

    it('changes POST to GET on 301 redirect', async () => {
      const redirectResponse = new Response(null, {
        status: 301,
        headers: { Location: 'http://example.com/new' },
      })
      const finalResponse = new Response('ok', { status: 200 })

      mockFetch
        .mockResolvedValueOnce(redirectResponse)
        .mockResolvedValueOnce(finalResponse)

      const resilientFetch = createResilientFetch(mockFetch, { retries: 0 })
      await resilientFetch('http://example.com/old', { method: 'POST', body: 'data' })

      const secondCall = mockFetch.mock.calls[1]
      expect(secondCall[1].method).toBe('GET')
      expect(secondCall[1].body).toBeUndefined()
      // Host header should be set since this is HTTP with IP pinning
      const headers = new Headers(secondCall[1].headers)
      expect(headers.get('Host')).toBe('example.com')
    })

    it('preserves POST on 307 redirect', async () => {
      const redirectResponse = new Response(null, {
        status: 307,
        headers: { Location: 'http://example.com/new' },
      })
      const finalResponse = new Response('ok', { status: 200 })

      mockFetch
        .mockResolvedValueOnce(redirectResponse)
        .mockResolvedValueOnce(finalResponse)

      const resilientFetch = createResilientFetch(mockFetch, { retries: 0 })
      await resilientFetch('http://example.com/old', { method: 'POST', body: 'data' })

      const secondCall = mockFetch.mock.calls[1]
      expect(secondCall[1].method).toBe('POST')
      expect(secondCall[1].body).toBe('data')
    })

    it('blocks HTTPS to HTTP downgrade', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(new Response(null, {
          status: 301,
          headers: { location: 'http://api.example.com/resource' },
        }))

      const fetch = createResilientFetch(mockFetch, { retries: 0 })
      await expect(fetch('https://api.example.com/resource', {}, { retries: 0 }))
        .rejects.toThrow(DowngradeError)
    })

    it('allows HTTP to HTTPS upgrade', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(new Response(null, {
          status: 301,
          headers: { location: 'https://api.example.com/resource' },
        }))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }))

      const fetch = createResilientFetch(mockFetch, { retries: 0 })
      const res = await fetch('http://api.example.com/resource', {}, { retries: 0 })
      expect(res.status).toBe(200)
    })

    it('allows HTTPS to HTTPS redirect', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(new Response(null, {
          status: 301,
          headers: { location: 'https://other.example.com/resource' },
        }))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }))

      const fetch = createResilientFetch(mockFetch, { retries: 0 })
      const res = await fetch('https://api.example.com/resource', {}, { retries: 0 })
      expect(res.status).toBe(200)
    })

    it('throws after 5 redirects', async () => {
      const makeRedirect = (n: number) =>
        new Response(null, { status: 302, headers: { Location: `http://example.com/${n}` } })

      for (let i = 0; i < 6; i++) {
        mockFetch.mockResolvedValueOnce(makeRedirect(i + 1))
      }

      const resilientFetch = createResilientFetch(mockFetch, { retries: 0 })
      await expect(resilientFetch('http://example.com/start')).rejects.toThrow('Too many redirects')
    })
  })

  describe('SSRF errors are never retried', () => {
    it('does not retry when SSRF guard blocks initial URL', async () => {
      mockValidateUrl.mockRejectedValue(new SsrfError('private IP', 'http://10.0.0.1'))

      const resilientFetch = createResilientFetch(mockFetch, { retries: 2, backoffMs: 1 })
      await expect(resilientFetch('http://10.0.0.1')).rejects.toThrow(SsrfError)
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe('response body size limit', () => {
    it('returns response when body is under limit', async () => {
      const body = 'a'.repeat(100)
      mockFetch.mockResolvedValueOnce(new Response(body, { status: 200 }))
      const resilientFetch = createResilientFetch(mockFetch, { retries: 0, maxResponseBytes: 1000 })

      const res = await resilientFetch('https://api.example.com')
      expect(await res.text()).toBe(body)
    })

    it('throws ResponseTooLargeError when body exceeds limit', async () => {
      const body = 'a'.repeat(1000)
      mockFetch.mockResolvedValueOnce(new Response(body, { status: 200 }))
      const resilientFetch = createResilientFetch(mockFetch, { retries: 0, maxResponseBytes: 100 })

      await expect(resilientFetch('https://api.example.com'))
        .rejects.toThrow(ResponseTooLargeError)
    })

    it('does not enforce limit when maxResponseBytes is 0', async () => {
      const body = 'a'.repeat(10000)
      mockFetch.mockResolvedValueOnce(new Response(body, { status: 200 }))
      const resilientFetch = createResilientFetch(mockFetch, { retries: 0, maxResponseBytes: 0 })

      const res = await resilientFetch('https://api.example.com')
      expect(await res.text()).toBe(body)
    })
  })
})

describe('isTransportError', () => {
  it('returns true for TransportUnavailableError', () => {
    expect(isTransportError(new TransportUnavailableError('http://x.onion'))).toBe(true)
  })

  it('returns true for ECONNREFUSED', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    expect(isTransportError(err)).toBe(true)
  })

  it('returns true for ETIMEDOUT', () => {
    const err = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })
    expect(isTransportError(err)).toBe(true)
  })

  it('returns true for ENOTFOUND', () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
    expect(isTransportError(err)).toBe(true)
  })

  it('returns true for UND_ERR_CONNECT_TIMEOUT', () => {
    const err = Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
    expect(isTransportError(err)).toBe(true)
  })

  it('returns false for ECONNRESET (mid-response reset — not a transport failure)', () => {
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    expect(isTransportError(err)).toBe(false)
  })

  it('returns false for SsrfError', () => {
    expect(isTransportError(new SsrfError('private IP', 'http://10.0.0.1'))).toBe(false)
  })

  it('returns false for plain Error', () => {
    expect(isTransportError(new Error('something else'))).toBe(false)
  })

  it('returns false for non-Error', () => {
    expect(isTransportError('string error')).toBe(false)
    expect(isTransportError(null)).toBe(false)
  })
})

describe('withTransportFallback', () => {
  beforeEach(() => {
    mockValidateUrl.mockReset()
    mockValidateUrl.mockResolvedValue({ address: '93.184.216.34', family: 4 })
  })

  it('returns response from first URL when it succeeds', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    const res = await withTransportFallback(['https://a.example.com'], {}, fetchFn)
    expect(res.status).toBe(200)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(fetchFn).toHaveBeenCalledWith('https://a.example.com', {}, undefined)
  })

  it('falls back to second URL on ECONNREFUSED from first', async () => {
    const connRefused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    const fetchFn = vi.fn()
      .mockRejectedValueOnce(connRefused)
      .mockResolvedValueOnce(new Response('ok from b', { status: 200 }))

    const res = await withTransportFallback(
      ['https://a.example.com', 'https://b.example.com'],
      {},
      fetchFn,
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok from b')
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('does NOT fall back on HTTP 403 (non-transport error)', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
      .mockResolvedValueOnce(new Response('ok from b', { status: 200 }))

    const res = await withTransportFallback(
      ['https://a.example.com', 'https://b.example.com'],
      {},
      fetchFn,
    )
    // 403 is returned as-is — no fallback
    expect(res.status).toBe(403)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('does NOT fall back on SsrfError', async () => {
    const fetchFn = vi.fn()
      .mockRejectedValueOnce(new SsrfError('private IP', 'http://a.example.com'))
      .mockResolvedValueOnce(new Response('ok from b', { status: 200 }))

    await expect(
      withTransportFallback(['https://a.example.com', 'https://b.example.com'], {}, fetchFn),
    ).rejects.toThrow(SsrfError)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('does NOT fall back on ECONNRESET', async () => {
    const connReset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    const fetchFn = vi.fn()
      .mockRejectedValueOnce(connReset)
      .mockResolvedValueOnce(new Response('ok from b', { status: 200 }))

    await expect(
      withTransportFallback(['https://a.example.com', 'https://b.example.com'], {}, fetchFn),
    ).rejects.toThrow('socket hang up')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('throws when all transports fail with transport errors', async () => {
    const connRefused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    const fetchFn = vi.fn().mockRejectedValue(connRefused)

    await expect(
      withTransportFallback(['https://a.example.com', 'https://b.example.com'], {}, fetchFn),
    ).rejects.toThrow('connect ECONNREFUSED')
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('throws generic "All transports exhausted" when urls array is empty', async () => {
    const fetchFn = vi.fn()
    await expect(withTransportFallback([], {}, fetchFn)).rejects.toThrow('All transports exhausted')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('falls back on TransportUnavailableError (e.g. .onion without Tor proxy)', async () => {
    const noTor = new TransportUnavailableError('http://secret.onion', 'Tor proxy required for .onion addresses')
    const fetchFn = vi.fn()
      .mockRejectedValueOnce(noTor)
      .mockResolvedValueOnce(new Response('ok from clearnet', { status: 200 }))

    const res = await withTransportFallback(
      ['http://secret.onion', 'https://clear.example.com'],
      {},
      fetchFn,
    )
    expect(res.status).toBe(200)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('passes options to the underlying fetch function', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    const options = { retries: 0, timeoutMs: 5000 }
    await withTransportFallback(['https://a.example.com'], { method: 'POST' }, fetchFn, options)
    expect(fetchFn).toHaveBeenCalledWith('https://a.example.com', { method: 'POST' }, options)
  })
})
