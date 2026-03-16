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

// ── Wire-format DNS response builder ────────────────────────────────

const DNS_TYPE_A = 1
const DNS_TYPE_AAAA = 28

interface WireRecord {
  type: number
  /** Raw rdata bytes */
  rdata: Uint8Array
}

/** Build an IPv4 address as 4 raw bytes. */
function ipv4Bytes(ip: string): Uint8Array {
  const parts = ip.split('.').map(Number)
  return new Uint8Array(parts)
}

/** Build an IPv6 address as 16 raw bytes. */
function ipv6Bytes(ip: string): Uint8Array {
  // Expand :: shorthand
  const halves = ip.split('::')
  let groups: string[]
  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(':') : []
    const right = halves[1] ? halves[1].split(':') : []
    const fill = Array(8 - left.length - right.length).fill('0')
    groups = [...left, ...fill, ...right]
  } else {
    groups = ip.split(':')
  }
  const buf = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    const val = parseInt(groups[i] || '0', 16)
    buf[i * 2] = (val >> 8) & 0xff
    buf[i * 2 + 1] = val & 0xff
  }
  return buf
}

/**
 * Build a minimal DNS wire-format response.
 *
 * @param rcode - DNS RCODE (0=NOERROR, 2=SERVFAIL, 3=NXDOMAIN)
 * @param records - answer records to include
 * @param qname - hostname used in question section (default: 'test')
 */
function buildWireResponse(rcode: number, records: WireRecord[], qname = 'test'): Uint8Array {
  // Question section
  const labels: number[] = []
  for (const part of qname.split('.')) {
    labels.push(part.length)
    for (let i = 0; i < part.length; i++) labels.push(part.charCodeAt(i))
  }
  labels.push(0) // root

  // Calculate total answer section size
  let answerSize = 0
  for (const rec of records) {
    answerSize += 2 + 2 + 2 + 4 + 2 + rec.rdata.length // name(ptr) + type + class + ttl + rdlen + rdata
  }

  const headerSize = 12
  const questionSize = labels.length + 4 // labels + QTYPE + QCLASS
  const totalSize = headerSize + questionSize + answerSize
  const buf = new Uint8Array(totalSize)
  const view = new DataView(buf.buffer)

  // Header
  view.setUint16(0, 0)                                  // ID
  view.setUint16(2, 0x8000 | (rcode & 0xf) | 0x0180)   // QR=1, RD=1, RA=1, RCODE
  view.setUint16(4, 1)                                  // QDCOUNT
  view.setUint16(6, records.length)                      // ANCOUNT
  view.setUint16(8, 0)                                  // NSCOUNT
  view.setUint16(10, 0)                                 // ARCOUNT

  // Question section
  let offset = headerSize
  for (const b of labels) buf[offset++] = b
  view.setUint16(offset, DNS_TYPE_A) // QTYPE (doesn't matter for answers)
  offset += 2
  view.setUint16(offset, 1) // QCLASS = IN
  offset += 2

  // Answer section
  for (const rec of records) {
    // Name pointer to question name at offset 12
    view.setUint16(offset, 0xc00c)
    offset += 2
    view.setUint16(offset, rec.type)
    offset += 2
    view.setUint16(offset, 1) // CLASS = IN
    offset += 2
    view.setUint32(offset, 300) // TTL
    offset += 4
    view.setUint16(offset, rec.rdata.length) // RDLENGTH
    offset += 2
    buf.set(rec.rdata, offset)
    offset += rec.rdata.length
  }

  return buf
}

/** Build a Response containing a DNS wire-format body. */
function wireResponse(rcode: number, records: WireRecord[], qname?: string): Response {
  const data = buildWireResponse(rcode, records, qname)
  return new Response(data, {
    status: 200,
    headers: { 'Content-Type': 'application/dns-message' },
  })
}

/** Build a Response with NOERROR but no answer records (empty). */
function emptyWireResponse(qname?: string): Response {
  return wireResponse(0, [], qname)
}

describe('resolveHns', () => {
  describe('A record resolution', () => {
    it('resolves hostname via A record and returns IPv4 address', async () => {
      mockFetch.mockResolvedValueOnce(
        wireResponse(0, [{ type: DNS_TYPE_A, rdata: ipv4Bytes('93.184.216.34') }]),
      )
      const result = await resolveHns('example.hns', 'https://query.hdns.io/')
      expect(result).toEqual({ address: '93.184.216.34', family: 4 })
    })

    it('queries with wire-format DoH (dns= parameter, application/dns-message)', async () => {
      mockFetch.mockResolvedValueOnce(
        wireResponse(0, [{ type: DNS_TYPE_A, rdata: ipv4Bytes('1.2.3.4') }]),
      )
      await resolveHns('mysite.hns', 'https://query.hdns.io/')
      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, init] = mockFetch.mock.calls[0]
      // URL should contain dns= parameter with base64url-encoded wire query
      expect(url).toMatch(/^https:\/\/query\.hdns\.io\/dns-query\?dns=/)
      expect(init.headers.Accept).toBe('application/dns-message')
      expect(init.redirect).toBe('error')
    })

    it('uses provided gateway URL', async () => {
      mockFetch.mockResolvedValueOnce(
        wireResponse(0, [{ type: DNS_TYPE_A, rdata: ipv4Bytes('5.6.7.8') }]),
      )
      await resolveHns('test.hns', 'https://custom-gateway.example.com/')
      const [url] = mockFetch.mock.calls[0]
      expect(url).toMatch(/^https:\/\/custom-gateway\.example\.com\/dns-query\?dns=/)
    })
  })

  describe('AAAA record fallback', () => {
    it('falls back to AAAA record when A record returns no results', async () => {
      mockFetch.mockResolvedValueOnce(emptyWireResponse())
      mockFetch.mockResolvedValueOnce(
        wireResponse(0, [{ type: DNS_TYPE_AAAA, rdata: ipv6Bytes('2606:2800:220:1:248:1893:25c8:1946') }]),
      )
      const result = await resolveHns('example.hns', 'https://query.hdns.io/')
      expect(result).toEqual({ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 })
    })

    it('makes two fetch calls: A then AAAA', async () => {
      mockFetch.mockResolvedValueOnce(emptyWireResponse())
      mockFetch.mockResolvedValueOnce(
        wireResponse(0, [{ type: DNS_TYPE_AAAA, rdata: ipv6Bytes('::1') }]),
      )
      await resolveHns('mysite.hns', 'https://query.hdns.io/').catch(() => {})
      expect(mockFetch).toHaveBeenCalledTimes(2)
      // Both should use dns= parameter
      expect(mockFetch.mock.calls[0][0]).toMatch(/\?dns=/)
      expect(mockFetch.mock.calls[1][0]).toMatch(/\?dns=/)
    })

    it('filters A-record entries from AAAA response (type 28 only)', async () => {
      mockFetch.mockResolvedValueOnce(emptyWireResponse())
      // AAAA response includes both A and AAAA records
      mockFetch.mockResolvedValueOnce(
        wireResponse(0, [
          { type: DNS_TYPE_A, rdata: ipv4Bytes('1.2.3.4') },
          { type: DNS_TYPE_AAAA, rdata: ipv6Bytes('2001:db8::1') },
        ]),
      )
      const result = await resolveHns('example.hns', 'https://query.hdns.io/')
      expect(result).toEqual({ address: '2001:db8:0:0:0:0:0:1', family: 6 })
    })
  })

  describe('error handling', () => {
    it('throws when both A and AAAA return no records', async () => {
      mockFetch.mockImplementation(() => Promise.resolve(emptyWireResponse()))
      await expect(resolveHns('nxdomain.hns', 'https://query.hdns.io/')).rejects.toThrow(
        'No DNS records found',
      )
    })

    it('throws on NXDOMAIN response', async () => {
      mockFetch.mockResolvedValueOnce(wireResponse(3, []))
      await expect(resolveHns('example.hns', 'https://query.hdns.io/')).rejects.toThrow(
        'NXDOMAIN',
      )
    })

    it('throws on SERVFAIL response', async () => {
      mockFetch.mockResolvedValueOnce(wireResponse(2, []))
      await expect(resolveHns('example.hns', 'https://query.hdns.io/')).rejects.toThrow(
        'SERVFAIL',
      )
    })

    it('throws on non-200 response for A record', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      await expect(resolveHns('example.hns', 'https://query.hdns.io/')).rejects.toThrow(
        'DNS query failed',
      )
    })

    it('throws on non-200 response for AAAA record', async () => {
      mockFetch.mockResolvedValueOnce(emptyWireResponse())
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
      await expect(resolveHns('example.hns', 'https://query.hdns.io/', 1)).rejects.toThrow()
    }, 3000)

    it('throws on truncated response (too short)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(new Uint8Array(4) as unknown as BodyInit, { status: 200 }),
      )
      await expect(resolveHns('example.hns', 'https://query.hdns.io/')).rejects.toThrow(
        'DNS response too short',
      )
    })
  })

  describe('A record type filtering', () => {
    it('ignores non-A record entries in A record response (type 1 only)', async () => {
      mockFetch.mockResolvedValueOnce(
        wireResponse(0, [
          { type: DNS_TYPE_AAAA, rdata: ipv6Bytes('::1') },
          { type: DNS_TYPE_A, rdata: ipv4Bytes('8.8.8.8') },
        ]),
      )
      const result = await resolveHns('example.hns', 'https://query.hdns.io/')
      expect(result).toEqual({ address: '8.8.8.8', family: 4 })
    })
  })

  describe('gateway redirect protection', () => {
    it('passes redirect: error to fetch', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'))
      await expect(resolveHns('example.hns', 'https://evil-gateway.com/')).rejects.toThrow()
      expect(mockFetch.mock.calls[0][1].redirect).toBe('error')
    })
  })
})
