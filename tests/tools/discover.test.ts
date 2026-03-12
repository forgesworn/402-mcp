import { describe, it, expect, vi } from 'vitest'
import { handleDiscover } from '../../src/tools/discover.js'
import { ChallengeCache } from '../../src/l402/challenge-cache.js'

const HASH = '0'.repeat(62) + '7b' // hexHash(123)

describe('handleDiscover', () => {
  it('parses a 402 response and returns challenge details', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 402,
      headers: new Headers({
        'www-authenticate': 'L402 macaroon="mac123", invoice="lnbc100n1test"',
        'x-powered-by': 'toll-booth',
      }),
      json: async () => ({ amount_sats: 10, payment_hash: HASH, payment_url: '/pay' }),
    })

    const cache = new ChallengeCache()

    const result = await handleDiscover(
      { url: 'https://api.example.com/data', method: 'GET' },
      { fetchFn: mockFetch as unknown as typeof fetch, cache, decodeBolt11: () => ({ costSats: 10, paymentHash: HASH, expiry: 3600 }) },
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.costSats).toBe(10)
    expect(parsed.macaroon).toBe('mac123')
    expect(parsed.server).toBe('toll-booth')
  })

  it('returns error for non-402 response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers(),
      text: async () => 'OK',
    })

    const cache = new ChallengeCache()

    const result = await handleDiscover(
      { url: 'https://free-api.com/data', method: 'GET' },
      { fetchFn: mockFetch as unknown as typeof fetch, cache, decodeBolt11: () => ({ costSats: null, paymentHash: null, expiry: 3600 }) },
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error).toBeDefined()
  })

  it('caches the challenge', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 402,
      headers: new Headers({
        'www-authenticate': 'L402 macaroon="mac123", invoice="lnbc100n1test"',
      }),
      json: async () => ({}),
    })

    const cache = new ChallengeCache()

    await handleDiscover(
      { url: 'https://api.example.com/data', method: 'GET' },
      { fetchFn: mockFetch as unknown as typeof fetch, cache, decodeBolt11: () => ({ costSats: 10, paymentHash: HASH, expiry: 3600 }) },
    )

    expect(cache.get(HASH)).toBeDefined()
    expect(cache.get(HASH)?.macaroon).toBe('mac123')
  })
})
