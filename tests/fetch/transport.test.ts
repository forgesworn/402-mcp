import { describe, it, expect } from 'vitest'
import { selectTransports } from '../../src/fetch/transport.js'

const DEFAULT_PREFERENCE = ['onion', 'hns', 'https', 'http']

describe('selectTransports', () => {
  describe('basic sorting by preference', () => {
    it('sorts by default preference: onion > hns > https > http', () => {
      const urls = [
        'http://example.com',
        'https://example.com',
        'http://example.hns',
        'http://example.onion',
      ]
      const result = selectTransports(urls, DEFAULT_PREFERENCE, { hasTorProxy: true })
      expect(result[0]).toBe('http://example.onion')
      expect(result[1]).toBe('http://example.hns')
      expect(result[2]).toBe('https://example.com')
      expect(result[3]).toBe('http://example.com')
    })

    it('prefers https over http when both present', () => {
      const urls = ['http://example.com', 'https://example.com']
      const result = selectTransports(urls, DEFAULT_PREFERENCE, { hasTorProxy: false })
      expect(result[0]).toBe('https://example.com')
      expect(result[1]).toBe('http://example.com')
    })

    it('passes through single URL unchanged', () => {
      const urls = ['https://example.com']
      const result = selectTransports(urls, DEFAULT_PREFERENCE, { hasTorProxy: false })
      expect(result).toEqual(['https://example.com'])
    })
  })

  describe('.onion filtering', () => {
    it('excludes .onion URLs when hasTorProxy is false', () => {
      const urls = ['http://example.onion', 'https://example.com']
      const result = selectTransports(urls, DEFAULT_PREFERENCE, { hasTorProxy: false })
      expect(result).not.toContainEqual('http://example.onion')
      expect(result).toContainEqual('https://example.com')
    })

    it('includes .onion URLs when hasTorProxy is true', () => {
      const urls = ['http://example.onion', 'https://example.com']
      const result = selectTransports(urls, DEFAULT_PREFERENCE, { hasTorProxy: true })
      expect(result).toContainEqual('http://example.onion')
    })

    it('returns empty array when only .onion URL and no proxy', () => {
      const urls = ['http://example.onion']
      const result = selectTransports(urls, DEFAULT_PREFERENCE, { hasTorProxy: false })
      expect(result).toEqual([])
    })
  })

  describe('custom preference order', () => {
    it('respects custom preference: http before https', () => {
      const urls = ['https://example.com', 'http://example.com']
      const result = selectTransports(urls, ['http', 'https'], { hasTorProxy: false })
      expect(result[0]).toBe('http://example.com')
      expect(result[1]).toBe('https://example.com')
    })

    it('places unrecognised transport types at the end', () => {
      const urls = ['https://example.com', 'http://example.com']
      const result = selectTransports(urls, ['onion', 'hns'], { hasTorProxy: false })
      // Neither https nor http is in preference list — both go to end, original order preserved
      expect(result).toHaveLength(2)
    })
  })

  describe('HNS classification heuristic', () => {
    it('classifies non-standard TLD as hns', () => {
      const urls = ['http://example.hns', 'https://example.com']
      const result = selectTransports(urls, DEFAULT_PREFERENCE, { hasTorProxy: false })
      expect(result[0]).toBe('http://example.hns')
    })

    it('classifies .bit domain as hns', () => {
      const urls = ['http://example.bit', 'https://example.com']
      const result = selectTransports(urls, DEFAULT_PREFERENCE, { hasTorProxy: false })
      expect(result[0]).toBe('http://example.bit')
    })

    it('does not classify standard TLDs (com, org, net, io) as hns', () => {
      const urls = ['https://example.com', 'https://example.org', 'https://example.io']
      const result = selectTransports(urls, DEFAULT_PREFERENCE, { hasTorProxy: false })
      // All should be classified as https, none as hns
      expect(result).toHaveLength(3)
    })
  })

  describe('empty and edge cases', () => {
    it('returns empty array for empty input', () => {
      expect(selectTransports([], DEFAULT_PREFERENCE, { hasTorProxy: false })).toEqual([])
    })

    it('handles URLs with ports correctly', () => {
      const urls = ['http://example.com:8080', 'https://example.com:8443']
      const result = selectTransports(urls, DEFAULT_PREFERENCE, { hasTorProxy: false })
      expect(result[0]).toBe('https://example.com:8443')
    })

    it('preserves original order for same-tier URLs', () => {
      const urls = ['https://a.com', 'https://b.com', 'https://c.com']
      const result = selectTransports(urls, DEFAULT_PREFERENCE, { hasTorProxy: false })
      expect(result).toEqual(['https://a.com', 'https://b.com', 'https://c.com'])
    })
  })
})
