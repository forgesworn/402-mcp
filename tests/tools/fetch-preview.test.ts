import { describe, it, expect, vi } from 'vitest'
import { handleFetchPreview, type FetchPreviewDeps } from '../../src/tools/fetch-preview.js'
import { ChallengeCache } from '../../src/l402/challenge-cache.js'

const HASH = '0'.repeat(62) + '7b'

function createDeps(overrides: Partial<FetchPreviewDeps> = {}): FetchPreviewDeps {
  return {
    fetchFn: vi.fn() as unknown as FetchPreviewDeps['fetchFn'],
    challengeCache: new ChallengeCache(),
    decodeBolt11: () => ({ paymentHash: HASH, costSats: 10, expiry: 3600 }),
    parseL402: () => ({ macaroon: 'mac123', invoice: 'lnbc100n1test' }),
    isX402: () => false,
    parseX402: () => null,
    isXCashu: () => false,
    parseXCashu: () => null,
    isIETFPayment: () => false,
    parseIETFPayment: () => null,
    walletMethod: () => 'nwc',
    ...overrides,
  }
}

describe('handleFetchPreview', () => {
  it('returns free status for non-402 responses', async () => {
    const deps = createDeps({
      fetchFn: vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
      }) as unknown as FetchPreviewDeps['fetchFn'],
    })

    const result = await handleFetchPreview(
      { url: 'https://free-api.com/data' },
      deps,
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.status).toBe('free')
    expect(parsed.endpoint).toBe('https://free-api.com/data')
    expect(parsed.message).toBe('No payment required.')
  })

  it('returns L402 preview for 402 with L402 challenge', async () => {
    const deps = createDeps({
      fetchFn: vi.fn().mockResolvedValue({
        status: 402,
        headers: new Headers({
          'www-authenticate': 'L402 macaroon="mac123", invoice="lnbc100n1test"',
        }),
        json: async () => ({}),
      }) as unknown as FetchPreviewDeps['fetchFn'],
    })

    const result = await handleFetchPreview(
      { url: 'https://api.example.com/data' },
      deps,
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.status).toBe('preview')
    expect(parsed.protocol).toBe('l402')
    expect(parsed.costSats).toBe(10)
    expect(parsed.paymentHash).toBe(HASH)
    expect(parsed.paymentMethod).toBe('nwc')
    expect(parsed.widgetHint).toBe('payment-confirmation')
    expect(parsed.endpoint).toBe('https://api.example.com/data')
  })

  it('caches L402 challenge for later fetch confirmation', async () => {
    const cache = new ChallengeCache()
    const deps = createDeps({
      challengeCache: cache,
      fetchFn: vi.fn().mockResolvedValue({
        status: 402,
        headers: new Headers({
          'www-authenticate': 'L402 macaroon="mac123", invoice="lnbc100n1test"',
        }),
        json: async () => ({}),
      }) as unknown as FetchPreviewDeps['fetchFn'],
    })

    await handleFetchPreview({ url: 'https://api.example.com/data' }, deps)

    expect(cache.get(HASH)).toBeDefined()
    expect(cache.get(HASH)?.macaroon).toBe('mac123')
    expect(cache.get(HASH)?.costSats).toBe(10)
  })

  it('returns IETF Payment preview when challenge detected', async () => {
    const deps = createDeps({
      fetchFn: vi.fn().mockResolvedValue({
        status: 402,
        headers: new Headers({
          'www-authenticate': 'Payment id="abc", realm="api.example.com", method="lightning", intent="charge", request="eyJ0ZXN0IjoxfQ"',
        }),
        json: async () => ({}),
      }) as unknown as FetchPreviewDeps['fetchFn'],
      isIETFPayment: () => true,
      parseIETFPayment: () => ({
        id: 'abc',
        realm: 'api.example.com',
        method: 'lightning',
        intent: 'charge',
        request: 'eyJ0ZXN0IjoxfQ',
        invoice: 'lnbc100n1test',
        paymentHash: HASH,
        amountSats: 25,
      }),
    })

    const result = await handleFetchPreview(
      { url: 'https://api.example.com/data' },
      deps,
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.status).toBe('preview')
    expect(parsed.protocol).toBe('ietf-payment')
    expect(parsed.costSats).toBe(25)
    expect(parsed.paymentHash).toBe(HASH)
    expect(parsed.realm).toBe('api.example.com')
  })

  it('returns xcashu preview when challenge detected', async () => {
    const deps = createDeps({
      fetchFn: vi.fn().mockResolvedValue({
        status: 402,
        headers: new Headers({
          'x-cashu': 'creqAeyJhIjo1MCwidSI6InNhdCIsIm0iOlsiaHR0cHM6Ly9taW50LmV4YW1wbGUuY29tIl19',
          'www-authenticate': '',
        }),
        json: async () => ({}),
      }) as unknown as FetchPreviewDeps['fetchFn'],
      parseL402: () => null,
      isXCashu: () => true,
      parseXCashu: () => ({ amount: 50, unit: 'sat' as const, mints: ['https://mint.example.com'] }),
    })

    const result = await handleFetchPreview(
      { url: 'https://api.example.com/data' },
      deps,
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.status).toBe('preview')
    expect(parsed.protocol).toBe('xcashu')
    expect(parsed.costSats).toBe(50)
  })

  it('returns x402 preview when challenge detected', async () => {
    const deps = createDeps({
      fetchFn: vi.fn().mockResolvedValue({
        status: 402,
        headers: new Headers({
          'x-payment-required': 'x402',
          'www-authenticate': '',
        }),
        json: async () => ({
          x402: { receiver: '0x' + 'a'.repeat(40), network: 'base', asset: 'usdc', amount_usd: 0.50 },
        }),
      }) as unknown as FetchPreviewDeps['fetchFn'],
      parseL402: () => null,
      isX402: () => true,
      parseX402: () => ({
        receiver: '0x' + 'a'.repeat(40),
        network: 'base',
        asset: 'usdc',
        amountUsd: 0.50,
        chainId: 8453,
        amountSmallestUnit: 500000n,
      }),
    })

    const result = await handleFetchPreview(
      { url: 'https://api.example.com/data' },
      deps,
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.status).toBe('preview')
    expect(parsed.protocol).toBe('x402')
    expect(parsed.costUsd).toBe(0.50)
    expect(parsed.network).toBe('base')
    expect(parsed.asset).toBe('usdc')
  })

  it('returns error for unrecognised 402 challenge', async () => {
    const deps = createDeps({
      fetchFn: vi.fn().mockResolvedValue({
        status: 402,
        headers: new Headers(),
        json: async () => ({}),
      }) as unknown as FetchPreviewDeps['fetchFn'],
      parseL402: () => null,
    })

    const result = await handleFetchPreview(
      { url: 'https://api.example.com/data' },
      deps,
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.status).toBe('error')
    expect(parsed.statusCode).toBe(402)
  })

  it('handles fetch errors gracefully', async () => {
    const deps = createDeps({
      fetchFn: vi.fn().mockRejectedValue(new Error('Connection refused')) as unknown as FetchPreviewDeps['fetchFn'],
    })

    const result = await handleFetchPreview(
      { url: 'https://api.example.com/data' },
      deps,
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error).toBeDefined()
    expect(result.isError).toBe(true)
  })

  it('strips hop-by-hop headers from requests', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers(),
    })

    const deps = createDeps({
      fetchFn: mockFetch as unknown as FetchPreviewDeps['fetchFn'],
    })

    await handleFetchPreview(
      {
        url: 'https://api.example.com/data',
        headers: { 'Host': 'evil.com', 'X-Custom': 'ok', 'Transfer-Encoding': 'chunked' },
      },
      deps,
    )

    const passedHeaders = mockFetch.mock.calls[0][1].headers
    expect(passedHeaders['X-Custom']).toBe('ok')
    expect(passedHeaders['Host']).toBeUndefined()
    expect(passedHeaders['Transfer-Encoding']).toBeUndefined()
  })

  it('handles batch URLs', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        status: 402,
        headers: new Headers({
          'www-authenticate': 'L402 macaroon="mac123", invoice="lnbc100n1test"',
        }),
        json: async () => ({}),
      })

    const deps = createDeps({
      fetchFn: mockFetch as unknown as FetchPreviewDeps['fetchFn'],
    })

    const result = await handleFetchPreview(
      {
        url: 'https://api.example.com/data',
        urls: ['https://free.example.com', 'https://paid.example.com'],
      },
      deps,
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(2)
    expect(parsed[0].status).toBe('free')
    expect(parsed[1].status).toBe('preview')
  })

  it('returns none as payment method when no wallet configured', async () => {
    const deps = createDeps({
      fetchFn: vi.fn().mockResolvedValue({
        status: 402,
        headers: new Headers({
          'www-authenticate': 'L402 macaroon="mac123", invoice="lnbc100n1test"',
        }),
        json: async () => ({}),
      }) as unknown as FetchPreviewDeps['fetchFn'],
      walletMethod: () => undefined,
    })

    const result = await handleFetchPreview(
      { url: 'https://api.example.com/data' },
      deps,
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.paymentMethod).toBe('none')
  })

  it('does not have spendTracker or payInvoice in deps interface', () => {
    // Type-level safety: this test documents the architectural guarantee
    // that the preview handler cannot spend money
    const deps = createDeps()
    expect(deps).not.toHaveProperty('spendTracker')
    expect(deps).not.toHaveProperty('payInvoice')
    expect(deps).not.toHaveProperty('credentialStore')
  })

  it('defaults method to GET', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers(),
    })

    const deps = createDeps({
      fetchFn: mockFetch as unknown as FetchPreviewDeps['fetchFn'],
    })

    await handleFetchPreview({ url: 'https://api.example.com/data' }, deps)

    expect(mockFetch.mock.calls[0][1].method).toBe('GET')
  })
})
