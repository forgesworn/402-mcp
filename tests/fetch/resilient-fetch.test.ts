import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SsrfError, TimeoutError, RetryExhaustedError, DowngradeError } from '../../src/fetch/errors.js'

// Mock the SSRF guard
const mockValidateUrl = vi.fn()
vi.mock('../../src/fetch/ssrf-guard.js', () => ({
  validateUrl: (...args: unknown[]) => mockValidateUrl(...args),
}))

const { createResilientFetch } = await import('../../src/fetch/resilient-fetch.js')

describe('createResilientFetch', () => {
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockFetch = vi.fn()
    mockValidateUrl.mockReset()
    mockValidateUrl.mockResolvedValue(undefined)
  })

  describe('SSRF guard integration', () => {
    it('calls validateUrl before fetch', async () => {
      mockFetch.mockResolvedValue(new Response('ok', { status: 200 }))
      const resilientFetch = createResilientFetch(mockFetch, { ssrfAllowPrivate: false })
      await resilientFetch('http://example.com')
      expect(mockValidateUrl).toHaveBeenCalledWith('http://example.com', false)
      expect(mockFetch).toHaveBeenCalled()
    })

    it('does not fetch if SSRF guard throws', async () => {
      mockValidateUrl.mockRejectedValue(new SsrfError('private IP', 'http://10.0.0.1'))
      const resilientFetch = createResilientFetch(mockFetch, { ssrfAllowPrivate: false })
      await expect(resilientFetch('http://10.0.0.1')).rejects.toThrow(SsrfError)
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('passes ssrfAllowPrivate to validateUrl', async () => {
      mockFetch.mockResolvedValue(new Response('ok', { status: 200 }))
      const resilientFetch = createResilientFetch(mockFetch, { ssrfAllowPrivate: true })
      await resilientFetch('http://localhost:3000')
      expect(mockValidateUrl).toHaveBeenCalledWith('http://localhost:3000', true)
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
})
