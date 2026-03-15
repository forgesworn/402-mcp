import { describe, it, expect, vi } from 'vitest'
import { handleFetch, type FetchDeps } from '../../src/tools/fetch.js'
import { SpendTracker } from '../../src/spend-tracker.js'
import { ChallengeCache } from '../../src/l402/challenge-cache.js'

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
    challengeCache: new ChallengeCache(),
    generateQr: vi.fn().mockResolvedValue('data:image/png;base64,test'),
    walletMethod: () => undefined,
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

describe('handleFetch security', () => {
  it('rejects non-hex preimage from wallet', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse(402, {
        'www-authenticate': 'L402 macaroon="bWFjMQ==", invoice="lnbc50n1test"',
      }, '{}'))

    const deps = makeDeps({
      fetchFn: fetchMock as unknown as typeof fetch,
      parseL402: vi.fn().mockReturnValue({ macaroon: 'bWFjMQ==', invoice: 'lnbc50n1test' }),
      decodeBolt11: vi.fn().mockReturnValue({ costSats: 50, paymentHash: 'hash1', expiry: 3600 }),
      payInvoice: vi.fn().mockResolvedValue({ paid: true, preimage: 'not-hex!@#$', method: 'nwc' }),
    })

    const result = await handleFetch({ url: 'https://api.example.com/data', autoPay: true }, deps)
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error).toContain('invalid characters')
    expect(deps.credentialStore.set).not.toHaveBeenCalled()
  })

  it('rejects macaroon with CRLF characters', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse(402, {
        'www-authenticate': 'L402 macaroon="mac1", invoice="lnbc50n1test"',
      }, '{}'))

    const deps = makeDeps({
      fetchFn: fetchMock as unknown as typeof fetch,
      parseL402: vi.fn().mockReturnValue({ macaroon: 'mac\r\nEvil: header', invoice: 'lnbc50n1test' }),
      decodeBolt11: vi.fn().mockReturnValue({ costSats: 50, paymentHash: 'hash1', expiry: 3600 }),
      payInvoice: vi.fn().mockResolvedValue({ paid: true, preimage: 'abcdef1234567890', method: 'nwc' }),
    })

    const result = await handleFetch({ url: 'https://api.example.com/data', autoPay: true }, deps)
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error).toContain('invalid characters')
  })

  it('rolls back spend limit when payment fails', async () => {
    const tracker = new SpendTracker()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse(402, {
        'www-authenticate': 'L402 macaroon="bWFjMQ==", invoice="lnbc50n1test"',
      }, '{}'))

    const deps = makeDeps({
      fetchFn: fetchMock as unknown as typeof fetch,
      parseL402: vi.fn().mockReturnValue({ macaroon: 'bWFjMQ==', invoice: 'lnbc50n1test' }),
      decodeBolt11: vi.fn().mockReturnValue({ costSats: 50, paymentHash: 'hash1', expiry: 3600 }),
      payInvoice: vi.fn().mockResolvedValue({ paid: false, method: 'nwc' }),
      spendTracker: tracker,
    })

    await handleFetch({ url: 'https://api.example.com/data', autoPay: true }, deps)

    // Spend should have been rolled back — budget should be available
    expect(tracker.recentSpend()).toBe(0)
  })

  it('strips dangerous hop-by-hop headers from user input', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200))
    const deps = makeDeps({
      fetchFn: fetchMock as unknown as typeof fetch,
    })

    await handleFetch({
      url: 'https://api.example.com/data',
      headers: {
        'Host': 'evil.example.com',
        'Transfer-Encoding': 'chunked',
        'X-Custom': 'allowed',
      },
    }, deps)

    const callHeaders = fetchMock.mock.calls[0][1].headers
    expect(callHeaders['Host']).toBeUndefined()
    expect(callHeaders['Transfer-Encoding']).toBeUndefined()
    expect(callHeaders['X-Custom']).toBe('allowed')
  })

  it('preserves user Authorization when no L402 credentials exist', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200))
    const deps = makeDeps({
      fetchFn: fetchMock as unknown as typeof fetch,
    })

    await handleFetch({
      url: 'https://api.example.com/data',
      headers: { 'Authorization': 'Bearer my-api-key' },
    }, deps)

    const callHeaders = fetchMock.mock.calls[0][1].headers
    expect(callHeaders['Authorization']).toBe('Bearer my-api-key')
  })

  it('does not call tryRecord when autoPay is false', async () => {
    const tracker = new SpendTracker()
    const tryRecordSpy = vi.spyOn(tracker, 'tryRecord')

    const deps = makeDeps({
      fetchFn: vi.fn().mockResolvedValue(mockResponse(402, {
        'www-authenticate': 'L402 macaroon="mac1", invoice="lnbc10n1test"',
      }, '{}')) as unknown as typeof fetch,
      parseL402: vi.fn().mockReturnValue({ macaroon: 'mac1', invoice: 'lnbc10n1test' }),
      decodeBolt11: vi.fn().mockReturnValue({ costSats: 10, paymentHash: 'hash1', expiry: 3600 }),
      spendTracker: tracker,
    })

    await handleFetch({ url: 'https://api.example.com/data', autoPay: false }, deps)

    // tryRecord should NOT be called when autoPay is false — otherwise it inflates
    // the spend tracker and blocks legitimate future payments.
    expect(tryRecordSpy).not.toHaveBeenCalled()
  })

  it('does not call tryRecord when cost exceeds maxAutoPaySats', async () => {
    const tracker = new SpendTracker()
    const tryRecordSpy = vi.spyOn(tracker, 'tryRecord')

    const deps = makeDeps({
      fetchFn: vi.fn().mockResolvedValue(mockResponse(402, {
        'www-authenticate': 'L402 macaroon="mac1", invoice="lnbc500n1test"',
      }, '{}')) as unknown as typeof fetch,
      parseL402: vi.fn().mockReturnValue({ macaroon: 'mac1', invoice: 'lnbc500n1test' }),
      decodeBolt11: vi.fn().mockReturnValue({ costSats: 500, paymentHash: 'hash1', expiry: 3600 }),
      maxAutoPaySats: 100,
      spendTracker: tracker,
    })

    await handleFetch({ url: 'https://api.example.com/data', autoPay: true }, deps)

    // tryRecord should NOT be called when cost exceeds maxAutoPaySats
    expect(tryRecordSpy).not.toHaveBeenCalled()
  })

  it('rejects preimage with wrong length (not 64 hex chars)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse(402, {
        'www-authenticate': 'L402 macaroon="bWFjMQ==", invoice="lnbc50n1test"',
      }, '{}'))

    const deps = makeDeps({
      fetchFn: fetchMock as unknown as typeof fetch,
      parseL402: vi.fn().mockReturnValue({ macaroon: 'bWFjMQ==', invoice: 'lnbc50n1test' }),
      decodeBolt11: vi.fn().mockReturnValue({ costSats: 50, paymentHash: 'hash1', expiry: 3600 }),
      // Valid hex but only 16 chars instead of 64
      payInvoice: vi.fn().mockResolvedValue({ paid: true, preimage: 'abcdef1234567890', method: 'nwc' }),
    })

    const result = await handleFetch({ url: 'https://api.example.com/data', autoPay: true }, deps)
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error).toContain('invalid characters')
    expect(deps.credentialStore.set).not.toHaveBeenCalled()
  })

  it('overwrites user Authorization when L402 credentials exist', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200))
    const deps = makeDeps({
      fetchFn: fetchMock as unknown as typeof fetch,
      credentialStore: {
        get: vi.fn().mockReturnValue({ macaroon: 'bWFjMQ==', preimage: 'abcdef' }),
        set: vi.fn(),
        updateBalance: vi.fn(),
        updateLastUsed: vi.fn(),
      } as unknown as FetchDeps['credentialStore'],
    })

    await handleFetch({
      url: 'https://api.example.com/data',
      headers: { 'Authorization': 'Bearer my-api-key' },
    }, deps)

    const callHeaders = fetchMock.mock.calls[0][1].headers
    expect(callHeaders['Authorization']).toBe('L402 bWFjMQ==:abcdef')
  })
})
