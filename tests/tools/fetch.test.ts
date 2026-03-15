import { describe, it, expect, vi } from 'vitest'
import { handleFetch, type FetchDeps } from '../../src/tools/fetch.js'
import { SpendTracker } from '../../src/spend-tracker.js'

function makeDeps(overrides: Partial<FetchDeps> = {}): FetchDeps {
  return {
    credentialStore: {
      get: vi.fn().mockReturnValue(undefined),
      set: vi.fn(),
      delete: vi.fn(),
      updateBalance: vi.fn(),
      updateLastUsed: vi.fn(),
    } as unknown as FetchDeps['credentialStore'],
    fetchFn: vi.fn() as unknown as typeof fetch,
    payInvoice: vi.fn().mockResolvedValue({ paid: false, method: 'none' }),
    maxAutoPaySats: 100,
    maxSpendPerMinuteSats: 10000,
    spendTracker: new SpendTracker(),
    parseL402: vi.fn().mockReturnValue(null),
    decodeBolt11: vi.fn().mockReturnValue({ costSats: null, paymentHash: null, expiry: 3600 }),
    detectServer: vi.fn().mockReturnValue({ type: 'generic' }),
    ...overrides,
  }
}

function mockResponse(status: number, headers: Record<string, string> = {}, body = 'OK') {
  return {
    status,
    headers: new Headers(headers),
    text: async () => body,
    json: async () => {
      try { return JSON.parse(body) } catch { return {} }
    },
  }
}

describe('handleFetch', () => {
  it('returns response directly when status is not 402', async () => {
    const deps = makeDeps({
      fetchFn: vi.fn().mockResolvedValue(mockResponse(200, {}, 'hello world')) as unknown as typeof fetch,
    })

    const result = await handleFetch({ url: 'https://api.example.com/data' }, deps)
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed.status).toBe(200)
    expect(parsed.body).toBe('hello world')
    expect(parsed.satsPaid).toBe(0)
  })

  it('uses stored credentials in Authorization header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200))
    const deps = makeDeps({
      fetchFn: fetchMock as unknown as typeof fetch,
      credentialStore: {
        get: vi.fn().mockReturnValue({ macaroon: 'mac1', preimage: 'pre1' }),
        set: vi.fn(),
        updateBalance: vi.fn(),
        updateLastUsed: vi.fn(),
      } as unknown as FetchDeps['credentialStore'],
    })

    await handleFetch({ url: 'https://api.example.com/data' }, deps)

    const callHeaders = fetchMock.mock.calls[0][1].headers
    expect(callHeaders['Authorization']).toBe('L402 mac1:pre1')
    expect(deps.credentialStore.updateLastUsed).toHaveBeenCalledWith('https://api.example.com')
  })

  it('updates credit balance from x-credit-balance header', async () => {
    const deps = makeDeps({
      fetchFn: vi.fn().mockResolvedValue(
        mockResponse(200, { 'x-credit-balance': '42' }, 'OK'),
      ) as unknown as typeof fetch,
    })

    const result = await handleFetch({ url: 'https://api.example.com/data' }, deps)
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed.creditsRemaining).toBe(42)
    expect(deps.credentialStore.updateBalance).toHaveBeenCalledWith('https://api.example.com', 42)
  })

  it('auto-pays and retries when within budget', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse(402, {
        'www-authenticate': 'L402 macaroon="mac1", invoice="lnbc50n1test"',
      }, '{}'))
      .mockResolvedValueOnce(mockResponse(200, { 'x-credit-balance': '950' }, 'paid content'))

    const deps = makeDeps({
      fetchFn: fetchMock as unknown as typeof fetch,
      parseL402: vi.fn().mockReturnValue({ macaroon: 'mac1', invoice: 'lnbc50n1test' }),
      decodeBolt11: vi.fn().mockReturnValue({ costSats: 50, paymentHash: 'hash1', expiry: 3600 }),
      detectServer: vi.fn().mockReturnValue({ type: 'generic' }),
      payInvoice: vi.fn().mockResolvedValue({ paid: true, preimage: 'a'.repeat(64), method: 'nwc' }),
      maxAutoPaySats: 100,
    })

    const result = await handleFetch({ url: 'https://api.example.com/data', autoPay: true }, deps)
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed.status).toBe(200)
    expect(parsed.body).toBe('paid content')
    expect(parsed.satsPaid).toBe(50)
    expect(parsed.creditsRemaining).toBe(950)
    expect(deps.credentialStore.set).toHaveBeenCalledWith('https://api.example.com', expect.objectContaining({
      macaroon: 'mac1',
      preimage: 'a'.repeat(64),
    }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns 402 challenge when cost exceeds maxAutoPaySats', async () => {
    const deps = makeDeps({
      fetchFn: vi.fn().mockResolvedValue(mockResponse(402, {
        'www-authenticate': 'L402 macaroon="mac1", invoice="lnbc500n1test"',
      }, '{}')) as unknown as typeof fetch,
      parseL402: vi.fn().mockReturnValue({ macaroon: 'mac1', invoice: 'lnbc500n1test' }),
      decodeBolt11: vi.fn().mockReturnValue({ costSats: 500, paymentHash: 'hash1', expiry: 3600 }),
      maxAutoPaySats: 100,
    })

    const result = await handleFetch({ url: 'https://api.example.com/data', autoPay: true }, deps)
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed.status).toBe(402)
    expect(parsed.costSats).toBe(500)
    expect(parsed.invoice).toBe('lnbc500n1test')
    expect(parsed.creditsExhausted).toBe(false)
    expect(parsed.message).toContain('Exceeds MAX_AUTO_PAY_SATS')
  })

  it('returns 402 with creditsExhausted when stored credentials get 402', async () => {
    const deps = makeDeps({
      fetchFn: vi.fn().mockResolvedValue(mockResponse(402, {
        'www-authenticate': 'L402 macaroon="mac2", invoice="lnbc10n1new"',
      }, '{}')) as unknown as typeof fetch,
      credentialStore: {
        get: vi.fn().mockReturnValue({ macaroon: 'old-mac', preimage: 'old-pre' }),
        set: vi.fn(),
        delete: vi.fn(),
        updateBalance: vi.fn(),
        updateLastUsed: vi.fn(),
      } as unknown as FetchDeps['credentialStore'],
      parseL402: vi.fn().mockReturnValue({ macaroon: 'mac2', invoice: 'lnbc10n1new' }),
      decodeBolt11: vi.fn().mockReturnValue({ costSats: 10, paymentHash: 'hash2', expiry: 3600 }),
    })

    const result = await handleFetch({ url: 'https://api.example.com/data' }, deps)
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed.status).toBe(402)
    expect(parsed.creditsExhausted).toBe(true)
    expect(parsed.message).toContain('no remaining credits')
    // Should NOT auto-pay when creditsExhausted
    expect(deps.payInvoice).not.toHaveBeenCalled()
    // Should delete stale credential
    expect((deps.credentialStore as any).delete).toHaveBeenCalledWith('https://api.example.com')
  })

  it('respects autoPay: false', async () => {
    const deps = makeDeps({
      fetchFn: vi.fn().mockResolvedValue(mockResponse(402, {
        'www-authenticate': 'L402 macaroon="mac1", invoice="lnbc10n1test"',
      }, '{}')) as unknown as typeof fetch,
      parseL402: vi.fn().mockReturnValue({ macaroon: 'mac1', invoice: 'lnbc10n1test' }),
      decodeBolt11: vi.fn().mockReturnValue({ costSats: 10, paymentHash: 'hash1', expiry: 3600 }),
      maxAutoPaySats: 100,
    })

    const result = await handleFetch({ url: 'https://api.example.com/data', autoPay: false }, deps)
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed.status).toBe(402)
    expect(parsed.costSats).toBe(10)
    expect(parsed.message).toContain('autoPay disabled')
    expect(deps.payInvoice).not.toHaveBeenCalled()
  })

  it('defaults autoPay to false and returns 402 without paying', async () => {
    const deps = makeDeps({
      fetchFn: vi.fn().mockResolvedValue(mockResponse(402, {
        'www-authenticate': 'L402 macaroon="mac1", invoice="lnbc10n1test"',
      }, '{}')) as unknown as typeof fetch,
      parseL402: vi.fn().mockReturnValue({ macaroon: 'mac1', invoice: 'lnbc10n1test' }),
      decodeBolt11: vi.fn().mockReturnValue({ costSats: 10, paymentHash: 'hash1', expiry: 3600 }),
      maxAutoPaySats: 100,
    })

    // No autoPay argument — should default to false
    const result = await handleFetch({ url: 'https://api.example.com/data' }, deps)
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed.status).toBe(402)
    expect(deps.payInvoice).not.toHaveBeenCalled()
    expect(parsed.message).toContain('autoPay disabled')
  })

  it('ignores non-numeric x-credit-balance header', async () => {
    const deps = makeDeps({
      fetchFn: vi.fn().mockResolvedValue(
        mockResponse(200, { 'x-credit-balance': 'foo' }, 'OK'),
      ) as unknown as typeof fetch,
    })

    const result = await handleFetch({ url: 'https://api.example.com/data' }, deps)
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed.creditsRemaining).toBeNull()
    expect(deps.credentialStore.updateBalance).not.toHaveBeenCalled()
  })

  it('ignores NaN x-credit-balance header', async () => {
    const deps = makeDeps({
      fetchFn: vi.fn().mockResolvedValue(
        mockResponse(200, { 'x-credit-balance': 'NaN' }, 'OK'),
      ) as unknown as typeof fetch,
    })

    const result = await handleFetch({ url: 'https://api.example.com/data' }, deps)
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed.creditsRemaining).toBeNull()
    expect(deps.credentialStore.updateBalance).not.toHaveBeenCalled()
  })

  it('ignores Infinity x-credit-balance header', async () => {
    const deps = makeDeps({
      fetchFn: vi.fn().mockResolvedValue(
        mockResponse(200, { 'x-credit-balance': 'Infinity' }, 'OK'),
      ) as unknown as typeof fetch,
    })

    const result = await handleFetch({ url: 'https://api.example.com/data' }, deps)
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed.creditsRemaining).toBeNull()
    expect(deps.credentialStore.updateBalance).not.toHaveBeenCalled()
  })

  it('rejects negative x-credit-balance header', async () => {
    const deps = makeDeps({
      fetchFn: vi.fn().mockResolvedValue(
        mockResponse(200, { 'x-credit-balance': '-999' }, 'OK'),
      ) as unknown as typeof fetch,
    })

    const result = await handleFetch({ url: 'https://api.example.com/data' }, deps)
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed.creditsRemaining).toBeNull()
    expect(deps.credentialStore.updateBalance).not.toHaveBeenCalled()
  })

  it('returns error on network failure', async () => {
    const deps = makeDeps({
      fetchFn: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch,
    })

    const result = await handleFetch({ url: 'https://api.example.com/data' }, deps)
    const parsed = JSON.parse(result.content[0].text)

    expect(result.isError).toBe(true)
    expect(parsed.error).toMatch(/Request failed|Network error/)
  })
})
