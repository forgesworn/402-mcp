import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SsrfError } from '../../src/fetch/errors.js'

// Mock dns.promises.lookup to control resolved IPs
// Now returns an array (dns.lookup with { all: true })
const mockLookup = vi.fn()
vi.mock('node:dns', () => ({
  promises: { lookup: (...args: unknown[]) => mockLookup(...args) },
}))

const { validateUrl } = await import('../../src/fetch/ssrf-guard.js')

beforeEach(() => {
  mockLookup.mockReset()
})

/** Helper: mock a single DNS result (wrapped in array for { all: true } API) */
function mockResolve(address: string, family: number) {
  mockLookup.mockResolvedValue([{ address, family }])
}

describe('validateUrl', () => {
  describe('scheme validation', () => {
    it('allows http URLs and returns resolved address', async () => {
      mockResolve('93.184.216.34', 4)
      const result = await validateUrl('http://example.com')
      expect(result).toEqual({ address: '93.184.216.34', family: 4 })
    })

    it('allows https URLs and returns resolved address', async () => {
      mockResolve('93.184.216.34', 4)
      const result = await validateUrl('https://example.com')
      expect(result).toEqual({ address: '93.184.216.34', family: 4 })
    })

    it('rejects file:// scheme', async () => {
      await expect(validateUrl('file:///etc/passwd')).rejects.toThrow(SsrfError)
      await expect(validateUrl('file:///etc/passwd')).rejects.toThrow('non-HTTP scheme')
    })

    it('rejects ftp:// scheme', async () => {
      await expect(validateUrl('ftp://example.com')).rejects.toThrow(SsrfError)
    })

    it('throws SsrfError on unparseable URLs', async () => {
      await expect(validateUrl('not-a-url')).rejects.toThrow(SsrfError)
      await expect(validateUrl('not-a-url')).rejects.toThrow('invalid URL')
    })
  })

  describe('private IP blocking', () => {
    it('blocks 10.x.x.x', async () => {
      mockResolve('10.0.0.1', 4)
      await expect(validateUrl('http://internal.example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://internal.example.com')).rejects.toThrow('private IP')
    })

    it('blocks 172.16.x.x', async () => {
      mockResolve('172.16.0.1', 4)
      await expect(validateUrl('http://internal.example.com')).rejects.toThrow(SsrfError)
    })

    it('blocks 192.168.x.x', async () => {
      mockResolve('192.168.1.1', 4)
      await expect(validateUrl('http://internal.example.com')).rejects.toThrow(SsrfError)
    })

    it('blocks 127.0.0.1 (loopback)', async () => {
      mockResolve('127.0.0.1', 4)
      await expect(validateUrl('http://localhost')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://localhost')).rejects.toThrow('loopback')
    })

    it('blocks ::1 (IPv6 loopback)', async () => {
      mockResolve('::1', 6)
      await expect(validateUrl('http://localhost')).rejects.toThrow(SsrfError)
    })

    it('blocks 169.254.169.254 (cloud metadata)', async () => {
      mockResolve('169.254.169.254', 4)
      await expect(validateUrl('http://metadata.google.internal')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://metadata.google.internal')).rejects.toThrow('link-local')
    })

    it('blocks fe80:: (IPv6 link-local)', async () => {
      mockResolve('fe80::1', 6)
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
    })

    it('blocks fc00::/fd00:: (IPv6 ULA)', async () => {
      mockResolve('fd12:3456:789a::1', 6)
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('private IP (ULA)')
    })

    it('blocks :: (IPv6 unspecified)', async () => {
      mockResolve('::', 6)
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('unspecified')
    })

    it('blocks 100.64.0.0/10 (CGNAT)', async () => {
      mockResolve('100.100.100.100', 4)
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('CGNAT')
    })
  })

  describe('public IPs allowed', () => {
    it('allows public IPv4 and returns resolved address', async () => {
      mockResolve('93.184.216.34', 4)
      const result = await validateUrl('http://example.com')
      expect(result).toEqual({ address: '93.184.216.34', family: 4 })
    })

    it('allows public IPv6 and returns resolved address', async () => {
      mockResolve('2606:2800:220:1:248:1893:25c8:1946', 6)
      const result = await validateUrl('http://example.com')
      expect(result).toEqual({ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 })
    })
  })

  describe('IPv4-mapped IPv6 addresses', () => {
    it('blocks dotted-quad form (::ffff:127.0.0.1)', async () => {
      mockResolve('::ffff:127.0.0.1', 6)
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('loopback')
    })

    it('blocks hex form (::ffff:7f00:1)', async () => {
      mockResolve('::ffff:7f00:1', 6)
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('loopback')
    })

    it('blocks hex form for 10.x (::ffff:a00:1)', async () => {
      mockResolve('::ffff:a00:1', 6)
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('private IP')
    })

    it('blocks hex form for 192.168.x (::ffff:c0a8:1)', async () => {
      mockResolve('::ffff:c0a8:1', 6)
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('private IP')
    })
  })

  describe('NAT64 prefix (64:ff9b::/96)', () => {
    it('blocks NAT64-encoded loopback (64:ff9b::7f00:1)', async () => {
      mockResolve('64:ff9b::7f00:1', 6)
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('loopback')
    })

    it('blocks NAT64 dotted-quad form (64:ff9b::10.0.0.1)', async () => {
      mockResolve('64:ff9b::10.0.0.1', 6)
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('private IP')
    })

    it('blocks NAT64-encoded 192.168.x (64:ff9b::c0a8:1)', async () => {
      mockResolve('64:ff9b::c0a8:1', 6)
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('private IP')
    })
  })

  describe('additional reserved ranges', () => {
    it('blocks 240.0.0.0/4 (Class E reserved)', async () => {
      mockResolve('240.0.0.1', 4)
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('reserved')
    })

    it('blocks 255.255.255.255 (broadcast)', async () => {
      mockResolve('255.255.255.255', 4)
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      // Class E check fires first since 255 >= 240
      await expect(validateUrl('http://example.com')).rejects.toThrow('reserved')
    })

    it('blocks 192.0.2.0/24 (TEST-NET-1)', async () => {
      mockResolve('192.0.2.1', 4)
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
    })

    it('blocks 198.51.100.0/24 (TEST-NET-2)', async () => {
      mockResolve('198.51.100.1', 4)
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
    })

    it('blocks 203.0.113.0/24 (TEST-NET-3)', async () => {
      mockResolve('203.0.113.1', 4)
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
    })

    it('blocks 198.18.0.0/15 (benchmarking)', async () => {
      mockResolve('198.18.0.1', 4)
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('benchmarking')
    })

    it('blocks fe90:: (link-local within fe80::/10 range)', async () => {
      mockResolve('fe90::1', 6)
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('link-local')
    })

    it('blocks febf:: (link-local within fe80::/10 range)', async () => {
      mockResolve('febf::1', 6)
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('link-local')
    })

    it('blocks fec0:: (deprecated site-local)', async () => {
      mockResolve('fec0::1', 6)
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('deprecated site-local')
    })
  })

  describe('multi-homed DNS bypass prevention', () => {
    it('blocks if any resolved address is private', async () => {
      mockLookup.mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ])
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('private IP')
    })

    it('allows when all resolved addresses are public', async () => {
      mockLookup.mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
        { address: '93.184.216.35', family: 4 },
      ])
      const result = await validateUrl('http://example.com')
      expect(result).toEqual({ address: '93.184.216.34', family: 4 })
    })

    it('rejects when DNS returns empty results', async () => {
      mockLookup.mockResolvedValue([])
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('no addresses')
    })
  })

  describe('IPv6 zone/scope ID stripping', () => {
    it('strips zone ID from IPv6 hostname before DNS lookup', async () => {
      mockResolve('fe80::1', 6)
      // URL with percent-encoded zone ID (fe80::1%25eth0)
      await expect(validateUrl('http://[fe80::1%25eth0]/')).rejects.toThrow(SsrfError)
    })

    it('blocks link-local IPv6 with zone ID that would bypass without stripping', async () => {
      // fe80::1 is link-local — must be blocked even if zone ID is present
      mockResolve('fe80::1', 6)
      await expect(validateUrl('http://[fe80::1]/')).rejects.toThrow(SsrfError)
    })
  })

  describe('bypass', () => {
    it('returns undefined when allowPrivate is true (no DNS resolution)', async () => {
      const result = await validateUrl('http://localhost', true)
      expect(result).toBeUndefined()
      expect(mockLookup).not.toHaveBeenCalled()
    })
  })
})
