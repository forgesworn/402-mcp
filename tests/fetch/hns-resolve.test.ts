import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock global fetch before importing the module under test
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const { resolveHns } = await import('../../src/fetch/hns-resolve.js')

beforeEach(() => {
  mockFetch.mockReset()
})

afterEach(() => {
  vi.clearAllTimers()
})

/** Build a minimal DNS-over-HTTPS JSON response */
function dnsResponse(answers: Array<{ type: number; data: string }>) {
  return new Response(JSON.stringify({ Answer: answers }), {
    status: 200,
    headers: { 'Content-Type': 'application/dns-json' },
  })
}

describe('resolveHns', () => {
  describe('A record resolution', () => {
    it('resolves hostname via A record and returns IPv4 address', async () => {
      mockFetch.mockResolvedValueOnce(dnsResponse([{ type: 1, data: '93.184.216.34' }]))
      const result = await resolveHns('example.hns', 'https://query.hdns.io/')
      expect(result).toEqual({ address: '93.184.216.34', family: 4 })
    })

    it('queries correct DNS-over-HTTPS URL for A record', async () => {
      mockFetch.mockResolvedValueOnce(dnsResponse([{ type: 1, data: '1.2.3.4' }]))
      await resolveHns('mysite.hns', 'https://query.hdns.io/')
      expect(mockFetch).toHaveBeenCalledWith(
        'https://query.hdns.io/dns-query?name=mysite.hns&type=A',
        expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/dns-json' }) }),
      )
    })

    it('uses provided gateway URL', async () => {
      mockFetch.mockResolvedValueOnce(dnsResponse([{ type: 1, data: '5.6.7.8' }]))
      await resolveHns('test.hns', 'https://custom-gateway.example.com/')
      expect(mockFetch).toHaveBeenCalledWith(
        'https://custom-gateway.example.com/dns-query?name=test.hns&type=A',
        expect.anything(),
      )
    })
  })

  describe('AAAA record fallback', () => {
    it('falls back to AAAA record when A record returns no results', async () => {
      // A record: no Answer
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 }),
      )
      // AAAA record: resolves
      mockFetch.mockResolvedValueOnce(
        dnsResponse([{ type: 28, data: '2606:2800:220:1:248:1893:25c8:1946' }]),
      )
      const result = await resolveHns('example.hns', 'https://query.hdns.io/')
      expect(result).toEqual({ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 })
    })

    it('queries correct DNS-over-HTTPS URL for AAAA fallback', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      mockFetch.mockResolvedValueOnce(
        dnsResponse([{ type: 28, data: '::1' }]),
      )
      await resolveHns('mysite.hns', 'https://query.hdns.io/').catch(() => {})
      expect(mockFetch).toHaveBeenCalledWith(
        'https://query.hdns.io/dns-query?name=mysite.hns&type=AAAA',
        expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/dns-json' }) }),
      )
    })

    it('filters A-record entries from AAAA response (type 28 only)', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      // AAAA response includes a type 1 (A) entry — should be ignored
      mockFetch.mockResolvedValueOnce(
        dnsResponse([
          { type: 1, data: '1.2.3.4' },
          { type: 28, data: '2001:db8::1' },
        ]),
      )
      const result = await resolveHns('example.hns', 'https://query.hdns.io/')
      expect(result).toEqual({ address: '2001:db8::1', family: 6 })
    })
  })

  describe('error handling', () => {
    it('throws when both A and AAAA return no records', async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
      )
      await expect(resolveHns('nxdomain.hns', 'https://query.hdns.io/')).rejects.toThrow(
        'No DNS records found',
      )
    })

    it('throws on non-200 response for A record', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      await expect(resolveHns('example.hns', 'https://query.hdns.io/')).rejects.toThrow(
        'DNS query failed',
      )
    })

    it('throws on non-200 response for AAAA record', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      mockFetch.mockResolvedValueOnce(new Response('Server Error', { status: 500 }))
      await expect(resolveHns('example.hns', 'https://query.hdns.io/')).rejects.toThrow(
        'DNS query failed',
      )
    })

    it('throws on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('fetch failed'))
      await expect(resolveHns('example.hns', 'https://query.hdns.io/')).rejects.toThrow()
    })

    it('throws on timeout (AbortError)', async () => {
      mockFetch.mockImplementationOnce((_url: string, init: RequestInit) => {
        // Simulate the abort signal firing
        return new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new DOMException('The operation was aborted.', 'AbortError')
              reject(err)
            })
          }
        })
      })
      // Use a very short timeout
      await expect(resolveHns('example.hns', 'https://query.hdns.io/', 1)).rejects.toThrow()
    }, 3000)
  })

  describe('IP format validation', () => {
    it('rejects non-standard IPv4 from gateway (octal)', async () => {
      mockFetch.mockResolvedValueOnce(dnsResponse([{ type: 1, data: '0177.0.0.1' }]))
      await expect(resolveHns('evil.hns', 'https://query.hdns.io/')).rejects.toThrow('invalid IPv4')
    })

    it('rejects hex IPv4 from gateway', async () => {
      mockFetch.mockResolvedValueOnce(dnsResponse([{ type: 1, data: '0x7f.0.0.1' }]))
      await expect(resolveHns('evil.hns', 'https://query.hdns.io/')).rejects.toThrow('invalid IPv4')
    })

    it('rejects decimal integer IPv4 from gateway', async () => {
      mockFetch.mockResolvedValueOnce(dnsResponse([{ type: 1, data: '2130706433' }]))
      await expect(resolveHns('evil.hns', 'https://query.hdns.io/')).rejects.toThrow('invalid IPv4')
    })

    it('rejects shorthand IPv4 from gateway', async () => {
      mockFetch.mockResolvedValueOnce(dnsResponse([{ type: 1, data: '127.1' }]))
      await expect(resolveHns('evil.hns', 'https://query.hdns.io/')).rejects.toThrow('invalid IPv4')
    })

    it('rejects IPv4 with leading zeros', async () => {
      mockFetch.mockResolvedValueOnce(dnsResponse([{ type: 1, data: '010.0.0.1' }]))
      await expect(resolveHns('evil.hns', 'https://query.hdns.io/')).rejects.toThrow('invalid IPv4')
    })

    it('rejects garbage strings in address field', async () => {
      mockFetch.mockResolvedValueOnce(dnsResponse([{ type: 1, data: '../../../etc/passwd' }]))
      await expect(resolveHns('evil.hns', 'https://query.hdns.io/')).rejects.toThrow('invalid IPv4')
    })

    it('rejects invalid IPv6 from gateway', async () => {
      // No A records, then AAAA with garbage
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      mockFetch.mockResolvedValueOnce(dnsResponse([{ type: 28, data: 'not-an-ipv6' }]))
      await expect(resolveHns('evil.hns', 'https://query.hdns.io/')).rejects.toThrow('invalid IPv6')
    })

    it('accepts valid standard IPv4', async () => {
      mockFetch.mockResolvedValueOnce(dnsResponse([{ type: 1, data: '93.184.216.34' }]))
      const result = await resolveHns('good.hns', 'https://query.hdns.io/')
      expect(result).toEqual({ address: '93.184.216.34', family: 4 })
    })

    it('accepts valid IPv6', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      mockFetch.mockResolvedValueOnce(dnsResponse([{ type: 28, data: '2606:2800:220:1:248:1893:25c8:1946' }]))
      const result = await resolveHns('good.hns', 'https://query.hdns.io/')
      expect(result).toEqual({ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 })
    })
  })

  describe('gateway redirect protection', () => {
    it('rejects gateway redirect (redirect: error)', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'))
      await expect(resolveHns('example.hns', 'https://evil-gateway.com/')).rejects.toThrow()
    })
  })

  describe('A record type filtering', () => {
    it('ignores non-A record entries in A record response (type 1 only)', async () => {
      mockFetch.mockResolvedValueOnce(
        dnsResponse([
          { type: 28, data: '::1' },  // AAAA — should be ignored in A response
          { type: 1, data: '8.8.8.8' },
        ]),
      )
      const result = await resolveHns('example.hns', 'https://query.hdns.io/')
      expect(result).toEqual({ address: '8.8.8.8', family: 4 })
    })
  })
})
