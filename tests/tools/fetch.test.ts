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
    transportFetch: vi.fn() as unknown as FetchDeps['transportFetch'],
    payInvoice: vi.fn().mockResolvedValue({ paid: false, method: 'none' }),
    maxAutoPaySats: 100,
    maxSpendPerMinuteSats: 10000,
    spendTracker: new SpendTracker(),
    parseL402: vi.fn().mockReturnValue(null),
    decodeBolt11: vi.fn().mockReturnValue({ costSats: null, paymentHash: null, expiry: 3600 }),
    detectServer: vi.fn().mockReturnValue({ type: 'generic' }),
    challengeCache: new ChallengeCache(),
    generateQr: vi.fn().mockResolvedValue({ png: 'data:image/png;base64,iVBORtestdata', text: '█▀▀▀█\n█   █\n█▄▄▄█' }),
    walletMethod: () => undefined,
    isX402: vi.fn().mockReturnValue(false),
    parseX402: vi.fn().mockReturnValue(null),
    formatX402: vi.fn().mockReturnValue({ json: {}, message: '' }),
    isIETFPayment: vi.fn().mockReturnValue(false),
    parseIETFPayment: vi.fn().mockReturnValue(null),
    buildIETFCredential: vi.fn().mockReturnValue(''),
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
    expect(parsed.message).toContain('Insufficient credits')
    // Should NOT auto-pay when creditsExhausted (non-human wallet)
    expect(deps.payInvoice).not.toHaveBeenCalled()
    // Should delete stale credential
    expect((deps.credentialStore as any).delete).toHaveBeenCalledWith('https://api.example.com')
  })

  it('returns QR when credits exhausted and wallet is human', async () => {
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
      decodeBolt11: vi.fn().mockReturnValue({ costSats: 10, paymentHash: 'b'.repeat(64), expiry: 3600 }),
      walletMethod: () => 'human',
      generateQr: vi.fn().mockResolvedValue({ png: 'data:image/png;base64,QRDATA', text: '█▀▀█' }),
    })

    const result = await handleFetch({ url: 'https://api.example.com/data', autoPay: true }, deps)

    // Should return combined text (QR + JSON) + QR image for human to pay
    expect(result.content).toHaveLength(2)
    expect(result.content[0].type).toBe('text')
    expect(result.content[1].type).toBe('image')

    // Text block starts with QR, followed by JSON
    expect(result.content[0].text).toContain('█▀▀█')
    const jsonPart = result.content[0].text.split('\n\n').slice(1).join('\n\n')
    const parsed = JSON.parse(jsonPart)
    expect(parsed.status).toBe(402)
    expect(parsed.costSats).toBe(10)
    expect(parsed.message).toContain('Payment required')

    // Should delete stale credential
    expect((deps.credentialStore as any).delete).toHaveBeenCalledWith('https://api.example.com')

    // payInvoice should NOT have been called — QR returned immediately
    expect(deps.payInvoice).not.toHaveBeenCalled()
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

  it('returns QR image + text immediately for human wallet without calling payInvoice', async () => {
    const deps = makeDeps({
      fetchFn: vi.fn().mockResolvedValueOnce(mockResponse(402, {
        'www-authenticate': 'L402 macaroon="mac1", invoice="lnbc210n1test"',
      }, '{}')) as unknown as typeof fetch,
      parseL402: vi.fn().mockReturnValue({ macaroon: 'mac1', invoice: 'lnbc210n1test' }),
      decodeBolt11: vi.fn().mockReturnValue({ costSats: 21, paymentHash: 'a'.repeat(64), expiry: 3600 }),
      payInvoice: vi.fn().mockResolvedValue({ paid: false, method: 'human' }),
      walletMethod: () => 'human',
      generateQr: vi.fn().mockResolvedValue({ png: 'data:image/png;base64,QRDATA', text: '█▀▀█' }),
    })

    const result = await handleFetch({ url: 'https://api.example.com/data', autoPay: true }, deps)

    // Should have combined text (QR + JSON) + PNG image content blocks
    expect(result.content).toHaveLength(2)
    expect(result.content[0].type).toBe('text')
    expect(result.content[1].type).toBe('image')

    // Text block starts with QR, followed by JSON
    expect(result.content[0].text).toContain('█▀▀█')
    const jsonPart = result.content[0].text.split('\n\n').slice(1).join('\n\n')
    const parsed = JSON.parse(jsonPart)
    expect(parsed.status).toBe(402)
    expect(parsed.costSats).toBe(21)
    expect(parsed.invoice).toBe('lnbc210n1test')
    expect(parsed.paymentHash).toBe('a'.repeat(64))
    expect(parsed.message).toContain('Payment required')
    expect(parsed.message).toContain('l402_pay')

    // Image should be raw base64 (no data URI prefix)
    const img = result.content[1] as { type: 'image'; data: string; mimeType: string }
    expect(img.data).toBe('QRDATA')
    expect(img.mimeType).toBe('image/png')

    // Challenge should be cached for l402_pay
    expect(deps.challengeCache.get('a'.repeat(64))).toBeDefined()

    // payInvoice should NOT have been called — human wallet returns immediately
    expect(deps.payInvoice).not.toHaveBeenCalled()

    // Spend should be unrecorded (human hasn't paid yet)
    expect(deps.spendTracker.recentSpend()).toBe(0)
  })

  it('returns text-only response when QR generation fails', async () => {
    const deps = makeDeps({
      fetchFn: vi.fn().mockResolvedValueOnce(mockResponse(402, {
        'www-authenticate': 'L402 macaroon="mac1", invoice="lnbc210n1test"',
      }, '{}')) as unknown as typeof fetch,
      parseL402: vi.fn().mockReturnValue({ macaroon: 'mac1', invoice: 'lnbc210n1test' }),
      decodeBolt11: vi.fn().mockReturnValue({ costSats: 21, paymentHash: 'a'.repeat(64), expiry: 3600 }),
      payInvoice: vi.fn().mockResolvedValue({ paid: false, method: 'human' }),
      walletMethod: () => 'human',
      generateQr: vi.fn().mockRejectedValue(new Error('QR too large')),
    })

    const result = await handleFetch({ url: 'https://api.example.com/data', autoPay: true }, deps)

    // Should still return text block without image
    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.status).toBe(402)
    expect(parsed.invoice).toBe('lnbc210n1test')

    // payInvoice should NOT have been called
    expect(deps.payInvoice).not.toHaveBeenCalled()
  })

  describe('pubkey-based credential keying', () => {
    it('uses pubkey as credential key when provided', async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockResponse(200))
      const credGet = vi.fn().mockReturnValue(undefined)
      const deps = makeDeps({
        fetchFn: fetchMock as unknown as typeof fetch,
        credentialStore: {
          get: credGet,
          set: vi.fn(),
          updateBalance: vi.fn(),
          updateLastUsed: vi.fn(),
        } as unknown as FetchDeps['credentialStore'],
      })

      await handleFetch({ url: 'https://api.example.com/data', pubkey: 'abc123pubkey' }, deps)

      expect(credGet).toHaveBeenCalledWith('abc123pubkey')
    })

    it('falls back to origin key when pubkey is absent', async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockResponse(200))
      const credGet = vi.fn().mockReturnValue(undefined)
      const deps = makeDeps({
        fetchFn: fetchMock as unknown as typeof fetch,
        credentialStore: {
          get: credGet,
          set: vi.fn(),
          updateBalance: vi.fn(),
          updateLastUsed: vi.fn(),
        } as unknown as FetchDeps['credentialStore'],
      })

      await handleFetch({ url: 'https://api.example.com/data' }, deps)

      expect(credGet).toHaveBeenCalledWith('https://api.example.com')
    })

    it('stores credential under pubkey after successful payment', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(mockResponse(402, {
          'www-authenticate': 'L402 macaroon="mac1", invoice="lnbc50n1test"',
        }, '{}'))
        .mockResolvedValueOnce(mockResponse(200, {}, 'paid content'))

      const credSet = vi.fn()
      const deps = makeDeps({
        fetchFn: fetchMock as unknown as typeof fetch,
        credentialStore: {
          get: vi.fn().mockReturnValue(undefined),
          set: credSet,
          updateBalance: vi.fn(),
          updateLastUsed: vi.fn(),
        } as unknown as FetchDeps['credentialStore'],
        parseL402: vi.fn().mockReturnValue({ macaroon: 'mac1', invoice: 'lnbc50n1test' }),
        decodeBolt11: vi.fn().mockReturnValue({ costSats: 50, paymentHash: 'hash1', expiry: 3600 }),
        payInvoice: vi.fn().mockResolvedValue({ paid: true, preimage: 'a'.repeat(64), method: 'nwc' }),
        maxAutoPaySats: 100,
      })

      await handleFetch({ url: 'https://api.example.com/data', autoPay: true, pubkey: 'abc123pubkey' }, deps)

      expect(credSet).toHaveBeenCalledWith('abc123pubkey', expect.objectContaining({
        macaroon: 'mac1',
        preimage: 'a'.repeat(64),
      }))
    })

    it('stores credential under origin when pubkey is absent', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(mockResponse(402, {
          'www-authenticate': 'L402 macaroon="mac1", invoice="lnbc50n1test"',
        }, '{}'))
        .mockResolvedValueOnce(mockResponse(200, {}, 'paid content'))

      const credSet = vi.fn()
      const deps = makeDeps({
        fetchFn: fetchMock as unknown as typeof fetch,
        credentialStore: {
          get: vi.fn().mockReturnValue(undefined),
          set: credSet,
          updateBalance: vi.fn(),
          updateLastUsed: vi.fn(),
        } as unknown as FetchDeps['credentialStore'],
        parseL402: vi.fn().mockReturnValue({ macaroon: 'mac1', invoice: 'lnbc50n1test' }),
        decodeBolt11: vi.fn().mockReturnValue({ costSats: 50, paymentHash: 'hash1', expiry: 3600 }),
        payInvoice: vi.fn().mockResolvedValue({ paid: true, preimage: 'a'.repeat(64), method: 'nwc' }),
        maxAutoPaySats: 100,
      })

      await handleFetch({ url: 'https://api.example.com/data', autoPay: true }, deps)

      expect(credSet).toHaveBeenCalledWith('https://api.example.com', expect.objectContaining({
        macaroon: 'mac1',
        preimage: 'a'.repeat(64),
      }))
    })
  })

  describe('multi-URL transport fallback', () => {
    it('uses transportFetch when urls array has multiple entries', async () => {
      const transportFetchMock = vi.fn().mockResolvedValue(mockResponse(200, {}, 'from transport'))
      const fetchMock = vi.fn()
      const deps = makeDeps({
        fetchFn: fetchMock as unknown as typeof fetch,
        transportFetch: transportFetchMock,
      })

      const result = await handleFetch({
        url: 'https://a.example.com/data',
        urls: ['https://a.example.com/data', 'https://b.example.com/data'],
      }, deps)

      expect(transportFetchMock).toHaveBeenCalledWith(
        ['https://a.example.com/data', 'https://b.example.com/data'],
        expect.objectContaining({ method: 'GET' }),
      )
      expect(fetchMock).not.toHaveBeenCalled()

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.status).toBe(200)
      expect(parsed.body).toBe('from transport')
    })

    it('uses fetchFn (not transportFetch) when only a single URL is provided', async () => {
      const transportFetchMock = vi.fn()
      const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, {}, 'direct'))
      const deps = makeDeps({
        fetchFn: fetchMock as unknown as typeof fetch,
        transportFetch: transportFetchMock,
      })

      await handleFetch({ url: 'https://api.example.com/data' }, deps)

      expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/data', expect.anything())
      expect(transportFetchMock).not.toHaveBeenCalled()
    })

    it('uses primary url as origin for credential key when urls are provided without pubkey', async () => {
      const credGet = vi.fn().mockReturnValue(undefined)
      const transportFetchMock = vi.fn().mockResolvedValue(mockResponse(200))
      const deps = makeDeps({
        transportFetch: transportFetchMock,
        credentialStore: {
          get: credGet,
          set: vi.fn(),
          updateBalance: vi.fn(),
          updateLastUsed: vi.fn(),
        } as unknown as FetchDeps['credentialStore'],
      })

      await handleFetch({
        url: 'https://a.example.com/data',
        urls: ['https://a.example.com/data', 'https://b.example.com/data'],
      }, deps)

      // Credential key should be origin of first (primary) URL
      expect(credGet).toHaveBeenCalledWith('https://a.example.com')
    })
  })

  describe('x402 challenge detection', () => {
    const x402Body = JSON.stringify({
      x402: {
        receiver: '0x1234567890abcdef1234567890abcdef12345678',
        network: 'base',
        asset: 'usdc',
        amount_usd: 1,
      },
    })

    it('returns x402 payment details when X-Payment-Required: x402 header is present', async () => {
      const formattedJson = {
        status: 402,
        protocol: 'x402',
        receiver: '0x1234567890abcdef1234567890abcdef12345678',
        network: 'base',
        asset: 'USDC',
        amountUsd: 1,
        chainId: 8453,
        paymentDeeplink: 'ethereum:0x1234567890abcdef1234567890abcdef12345678@8453',
        message: 'Payment required: $1 USDC on base.',
      }

      const deps = makeDeps({
        fetchFn: vi.fn().mockResolvedValue(mockResponse(402, {
          'x-payment-required': 'x402',
        }, x402Body)) as unknown as typeof fetch,
        isX402: vi.fn().mockReturnValue(true),
        parseX402: vi.fn().mockReturnValue({
          receiver: '0x1234567890abcdef1234567890abcdef12345678',
          network: 'base',
          asset: 'usdc',
          amountUsd: 1,
          chainId: 8453,
          amountSmallestUnit: 1000000n,
        }),
        formatX402: vi.fn().mockReturnValue({ json: formattedJson, message: formattedJson.message }),
      })

      const result = await handleFetch({ url: 'https://api.example.com/data' }, deps)
      const parsed = JSON.parse(result.content[0].text)

      expect(parsed.status).toBe(402)
      expect(parsed.protocol).toBe('x402')
      expect(parsed.receiver).toBe('0x1234567890abcdef1234567890abcdef12345678')
      expect(parsed.network).toBe('base')
      expect(parsed.asset).toBe('USDC')
      expect(parsed.amountUsd).toBe(1)
      expect(parsed.paymentDeeplink).toContain('ethereum:')
      expect(parsed.message).toContain('Payment required')

      // Should NOT attempt L402 payment
      expect(deps.payInvoice).not.toHaveBeenCalled()
    })

    it('falls through to L402 when x402 header present but body is unparseable', async () => {
      const deps = makeDeps({
        fetchFn: vi.fn().mockResolvedValue(mockResponse(402, {
          'x-payment-required': 'x402',
          'www-authenticate': 'L402 macaroon="mac1", invoice="lnbc10n1test"',
        }, '{}')) as unknown as typeof fetch,
        isX402: vi.fn().mockReturnValue(true),
        parseX402: vi.fn().mockReturnValue(null),
        parseL402: vi.fn().mockReturnValue({ macaroon: 'mac1', invoice: 'lnbc10n1test' }),
        decodeBolt11: vi.fn().mockReturnValue({ costSats: 10, paymentHash: 'hash1', expiry: 3600 }),
      })

      const result = await handleFetch({ url: 'https://api.example.com/data' }, deps)
      const parsed = JSON.parse(result.content[0].text)

      // Should fall through to L402 path
      expect(parsed.status).toBe(402)
      expect(parsed.costSats).toBe(10)
      expect(parsed.invoice).toBe('lnbc10n1test')
    })

    it('does not check x402 when isX402 returns false', async () => {
      const deps = makeDeps({
        fetchFn: vi.fn().mockResolvedValue(mockResponse(402, {
          'www-authenticate': 'L402 macaroon="mac1", invoice="lnbc10n1test"',
        }, '{}')) as unknown as typeof fetch,
        isX402: vi.fn().mockReturnValue(false),
        parseX402: vi.fn(),
        parseL402: vi.fn().mockReturnValue({ macaroon: 'mac1', invoice: 'lnbc10n1test' }),
        decodeBolt11: vi.fn().mockReturnValue({ costSats: 10, paymentHash: 'hash1', expiry: 3600 }),
      })

      const result = await handleFetch({ url: 'https://api.example.com/data' }, deps)
      const parsed = JSON.parse(result.content[0].text)

      expect(parsed.status).toBe(402)
      expect(parsed.costSats).toBe(10)
      // parseX402 should not have been called
      expect(deps.parseX402).not.toHaveBeenCalled()
    })
  })

  describe('x402 txHash retry', () => {
    it('sends X-Payment header when txHash is provided', async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, {}, 'access granted'))
      const txHash = '0x' + 'a'.repeat(64)

      const deps = makeDeps({
        fetchFn: fetchMock as unknown as typeof fetch,
      })

      const result = await handleFetch({ url: 'https://api.example.com/data', txHash }, deps)

      const callHeaders = fetchMock.mock.calls[0][1].headers
      expect(callHeaders['X-Payment']).toBe(txHash)

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.status).toBe(200)
      expect(parsed.body).toBe('access granted')
    })

    it('does not set X-Payment header when txHash is absent', async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, {}, 'OK'))
      const deps = makeDeps({
        fetchFn: fetchMock as unknown as typeof fetch,
      })

      await handleFetch({ url: 'https://api.example.com/data' }, deps)

      const callHeaders = fetchMock.mock.calls[0][1].headers
      expect(callHeaders['X-Payment']).toBeUndefined()
    })
  })
})
