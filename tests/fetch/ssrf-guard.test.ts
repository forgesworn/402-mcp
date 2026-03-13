import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SsrfError } from '../../src/fetch/errors.js'

// Mock dns.promises.lookup to control resolved IPs
const mockLookup = vi.fn()
vi.mock('node:dns', () => ({
  promises: { lookup: (...args: unknown[]) => mockLookup(...args) },
}))

const { validateUrl } = await import('../../src/fetch/ssrf-guard.js')

beforeEach(() => {
  mockLookup.mockReset()
})

describe('validateUrl', () => {
  describe('scheme validation', () => {
    it('allows http URLs and returns resolved address', async () => {
      mockLookup.mockResolvedValue({ address: '93.184.216.34', family: 4 })
      const result = await validateUrl('http://example.com')
      expect(result).toEqual({ address: '93.184.216.34', family: 4 })
    })

    it('allows https URLs and returns resolved address', async () => {
      mockLookup.mockResolvedValue({ address: '93.184.216.34', family: 4 })
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
      mockLookup.mockResolvedValue({ address: '10.0.0.1', family: 4 })
      await expect(validateUrl('http://internal.example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://internal.example.com')).rejects.toThrow('private IP')
    })

    it('blocks 172.16.x.x', async () => {
      mockLookup.mockResolvedValue({ address: '172.16.0.1', family: 4 })
      await expect(validateUrl('http://internal.example.com')).rejects.toThrow(SsrfError)
    })

    it('blocks 192.168.x.x', async () => {
      mockLookup.mockResolvedValue({ address: '192.168.1.1', family: 4 })
      await expect(validateUrl('http://internal.example.com')).rejects.toThrow(SsrfError)
    })

    it('blocks 127.0.0.1 (loopback)', async () => {
      mockLookup.mockResolvedValue({ address: '127.0.0.1', family: 4 })
      await expect(validateUrl('http://localhost')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://localhost')).rejects.toThrow('loopback')
    })

    it('blocks ::1 (IPv6 loopback)', async () => {
      mockLookup.mockResolvedValue({ address: '::1', family: 6 })
      await expect(validateUrl('http://localhost')).rejects.toThrow(SsrfError)
    })

    it('blocks 169.254.169.254 (cloud metadata)', async () => {
      mockLookup.mockResolvedValue({ address: '169.254.169.254', family: 4 })
      await expect(validateUrl('http://metadata.google.internal')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://metadata.google.internal')).rejects.toThrow('link-local')
    })

    it('blocks fe80:: (IPv6 link-local)', async () => {
      mockLookup.mockResolvedValue({ address: 'fe80::1', family: 6 })
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
    })

    it('blocks fc00::/fd00:: (IPv6 ULA)', async () => {
      mockLookup.mockResolvedValue({ address: 'fd12:3456:789a::1', family: 6 })
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('private IP (ULA)')
    })

    it('blocks :: (IPv6 unspecified)', async () => {
      mockLookup.mockResolvedValue({ address: '::', family: 6 })
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('unspecified')
    })

    it('blocks 100.64.0.0/10 (CGNAT)', async () => {
      mockLookup.mockResolvedValue({ address: '100.100.100.100', family: 4 })
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('CGNAT')
    })
  })

  describe('public IPs allowed', () => {
    it('allows public IPv4 and returns resolved address', async () => {
      mockLookup.mockResolvedValue({ address: '93.184.216.34', family: 4 })
      const result = await validateUrl('http://example.com')
      expect(result).toEqual({ address: '93.184.216.34', family: 4 })
    })

    it('allows public IPv6 and returns resolved address', async () => {
      mockLookup.mockResolvedValue({ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 })
      const result = await validateUrl('http://example.com')
      expect(result).toEqual({ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 })
    })
  })

  describe('IPv4-mapped IPv6 addresses', () => {
    it('blocks dotted-quad form (::ffff:127.0.0.1)', async () => {
      mockLookup.mockResolvedValue({ address: '::ffff:127.0.0.1', family: 6 })
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('loopback')
    })

    it('blocks hex form (::ffff:7f00:1)', async () => {
      mockLookup.mockResolvedValue({ address: '::ffff:7f00:1', family: 6 })
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('loopback')
    })

    it('blocks hex form for 10.x (::ffff:a00:1)', async () => {
      mockLookup.mockResolvedValue({ address: '::ffff:a00:1', family: 6 })
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('private IP')
    })

    it('blocks hex form for 192.168.x (::ffff:c0a8:1)', async () => {
      mockLookup.mockResolvedValue({ address: '::ffff:c0a8:1', family: 6 })
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('private IP')
    })
  })

  describe('NAT64 prefix (64:ff9b::/96)', () => {
    it('blocks NAT64-encoded loopback (64:ff9b::7f00:1)', async () => {
      mockLookup.mockResolvedValue({ address: '64:ff9b::7f00:1', family: 6 })
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('loopback')
    })

    it('blocks NAT64 dotted-quad form (64:ff9b::10.0.0.1)', async () => {
      mockLookup.mockResolvedValue({ address: '64:ff9b::10.0.0.1', family: 6 })
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('private IP')
    })

    it('blocks NAT64-encoded 192.168.x (64:ff9b::c0a8:1)', async () => {
      mockLookup.mockResolvedValue({ address: '64:ff9b::c0a8:1', family: 6 })
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('private IP')
    })
  })

  describe('additional reserved ranges', () => {
    it('blocks 240.0.0.0/4 (Class E reserved)', async () => {
      mockLookup.mockResolvedValue({ address: '240.0.0.1', family: 4 })
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('reserved')
    })

    it('blocks 255.255.255.255 (broadcast)', async () => {
      mockLookup.mockResolvedValue({ address: '255.255.255.255', family: 4 })
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      // Class E check fires first since 255 >= 240
      await expect(validateUrl('http://example.com')).rejects.toThrow('reserved')
    })

    it('blocks 192.0.2.0/24 (TEST-NET-1)', async () => {
      mockLookup.mockResolvedValue({ address: '192.0.2.1', family: 4 })
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
    })

    it('blocks 198.51.100.0/24 (TEST-NET-2)', async () => {
      mockLookup.mockResolvedValue({ address: '198.51.100.1', family: 4 })
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
    })

    it('blocks 203.0.113.0/24 (TEST-NET-3)', async () => {
      mockLookup.mockResolvedValue({ address: '203.0.113.1', family: 4 })
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
    })

    it('blocks 198.18.0.0/15 (benchmarking)', async () => {
      mockLookup.mockResolvedValue({ address: '198.18.0.1', family: 4 })
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('benchmarking')
    })

    it('blocks fe90:: (link-local within fe80::/10 range)', async () => {
      mockLookup.mockResolvedValue({ address: 'fe90::1', family: 6 })
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('link-local')
    })

    it('blocks febf:: (link-local within fe80::/10 range)', async () => {
      mockLookup.mockResolvedValue({ address: 'febf::1', family: 6 })
      await expect(validateUrl('http://example.com')).rejects.toThrow(SsrfError)
      await expect(validateUrl('http://example.com')).rejects.toThrow('link-local')
    })

    it('allows fec0:: (outside fe80::/10 range)', async () => {
      mockLookup.mockResolvedValue({ address: 'fec0::1', family: 6 })
      // fec0::/10 is deprecated site-local but not in our block list
      const result = await validateUrl('http://example.com')
      expect(result).toBeDefined()
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
