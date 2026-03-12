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

  describe('bypass', () => {
    it('returns undefined when allowPrivate is true (no DNS resolution)', async () => {
      const result = await validateUrl('http://localhost', true)
      expect(result).toBeUndefined()
      expect(mockLookup).not.toHaveBeenCalled()
    })
  })
})
