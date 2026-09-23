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
    generateQr: vi.fn().mockResolvedValue({ png: 'data:image/png;base64,test', text: '█▀▀█' }),
    walletMethod: () => undefined,
    isX402: vi.fn().mockReturnValue(false),
    parseX402: vi.fn().mockReturnValue(null),
    formatX402: vi.fn().mockReturnValue({ json: {}, message: '' }),
    isIETFPayment: vi.fn().mockReturnValue(false),
    parseIETFPayment: vi.fn().mockReturnValue(null),
    buildIETFCredential: vi.fn().mockReturnValue(''),
    pendingPayments: { add: vi.fn(), unresolvedFor: vi.fn().mockReturnValue([]) },
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
    expect(parsed.paymentState).toBe('unknown')
    expect(deps.spendTracker.recentSpend()).toBe(50)
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
    expect(parsed.paymentState).toBe('unknown')
    expect(deps.spendTracker.recentSpend()).toBe(50)
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

  it('does not retry or release budget when an L402 payment outcome is unknown', async () => {
    const tracker = new SpendTracker()
    const fetchMock = vi.fn().mockResolvedValueOnce(mockResponse(402, {
      'www-authenticate': 'L402 macaroon="bWFjMQ==", invoice="lnbc50n1test"',
    }, '{}'))
    const deps = makeDeps({
      fetchFn: fetchMock as unknown as typeof fetch,
      parseL402: vi.fn().mockReturnValue({ macaroon: 'bWFjMQ==', invoice: 'lnbc50n1test' }),
      decodeBolt11: vi.fn().mockReturnValue({ costSats: 50, paymentHash: 'hash1', expiry: 3600 }),
      payInvoice: vi.fn().mockResolvedValue({
        paid: false,
        method: 'nwc',
        outcome: 'unknown',
        reason: 'Reconcile before retrying.',
      }),
      spendTracker: tracker,
    })

    const result = await handleFetch({ url: 'https://api.example.com/data', autoPay: true }, deps)
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed).toMatchObject({ paymentState: 'unknown', paymentHash: 'hash1' })
    expect(parsed.message).toContain('Reconcile')
    expect(result.isError).toBe(true)
    expect(tracker.recentSpend()).toBe(50)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  describe('IETF Payment challenge that disagrees with its invoice', () => {
    const challenge = {
      id: 'id1', realm: 'api.example.com', method: 'lightning', intent: 'charge',
      request: 'request', invoice: 'lnbc50m1test', paymentHash: 'hash1', amountSats: 1,
    }

    it.each([
      ['understates the amount', { ...challenge }, { costSats: 5_000_000, paymentHash: 'hash1' }],
      ['names another payment hash', { ...challenge, amountSats: 50 }, { costSats: 50, paymentHash: 'hash2' }],
      ['has an amountless invoice', { ...challenge }, { costSats: null, paymentHash: 'hash1' }],
    ])('refuses to pay when the challenge %s', async (_label, parsedChallenge, invoice) => {
      const tracker = new SpendTracker()
      const fetchMock = vi.fn().mockResolvedValueOnce(mockResponse(402, { 'www-authenticate': 'Payment id="id1"' }, '{}'))
      const deps = makeDeps({
        fetchFn: fetchMock as unknown as typeof fetch,
        isIETFPayment: vi.fn().mockReturnValue(true),
        parseIETFPayment: vi.fn().mockReturnValue(parsedChallenge),
        decodeBolt11: vi.fn().mockReturnValue({ ...invoice, expiry: 3600 }),
        payInvoice: vi.fn().mockResolvedValue({ paid: true, preimage: 'a'.repeat(64), method: 'nwc' }),
        maxAutoPaySats: 1000,
        spendTracker: tracker,
      })

      const result = await handleFetch({ url: 'https://api.example.com/data', autoPay: true }, deps)
      expect(result.isError).toBe(true)
      expect(JSON.parse(result.content[0].text).error).toMatch(/does not match its invoice/)
      expect(deps.payInvoice).not.toHaveBeenCalled()
      expect(tracker.recentSpend()).toBe(0)
      expect(deps.parseL402).not.toHaveBeenCalled()
    })
  })

  it('does not fall through to a second rail when an IETF payment outcome is unknown', async () => {
    const tracker = new SpendTracker()
    const fetchMock = vi.fn().mockResolvedValueOnce(mockResponse(402, {
      'www-authenticate': 'Payment id="id1"',
    }, '{}'))
    const deps = makeDeps({
      fetchFn: fetchMock as unknown as typeof fetch,
      isIETFPayment: vi.fn().mockReturnValue(true),
      parseIETFPayment: vi.fn().mockReturnValue({
        id: 'id1',
        realm: 'api.example.com',
        method: 'lightning',
        intent: 'charge',
        request: 'request',
        invoice: 'lnbc50n1test',
        paymentHash: 'hash1',
        amountSats: 50,
      }),
      decodeBolt11: vi.fn().mockReturnValue({ costSats: 50, paymentHash: 'hash1', expiry: 3600 }),
      payInvoice: vi.fn().mockResolvedValue({
        paid: false,
        method: 'nwc',
        outcome: 'unknown',
        reason: 'Reconcile before retrying.',
      }),
      spendTracker: tracker,
    })

    const result = await handleFetch({ url: 'https://api.example.com/data', autoPay: true }, deps)
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed).toMatchObject({ protocol: 'ietf-payment', paymentState: 'unknown', paymentHash: 'hash1' })
    expect(result.isError).toBe(true)
    expect(tracker.recentSpend()).toBe(50)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(deps.parseL402).not.toHaveBeenCalled()
  })

  describe('a payment attempt never ends in a fresh challenge or a second rail', () => {
    const ietfChallenge = {
      id: 'id1', realm: 'api.example.com', method: 'lightning', intent: 'charge',
      request: 'request', invoice: 'lnbc50n1ietf', paymentHash: 'hash1', amountSats: 50,
    }

    function l402Deps(payResult: Record<string, unknown>, tracker: SpendTracker) {
      return makeDeps({
        fetchFn: vi.fn().mockResolvedValue(mockResponse(402, {
          'www-authenticate': 'L402 macaroon="bWFjMQ==", invoice="lnbc50n1test"',
        }, '{}')) as unknown as typeof fetch,
        parseL402: vi.fn().mockReturnValue({ macaroon: 'bWFjMQ==', invoice: 'lnbc50n1test' }),
        decodeBolt11: vi.fn().mockReturnValue({ costSats: 50, paymentHash: 'hash1', expiry: 3600 }),
        payInvoice: vi.fn().mockResolvedValue(payResult),
        spendTracker: tracker,
      })
    }

    it('treats an L402 payment reported paid without a preimage as unknown', async () => {
      const tracker = new SpendTracker()
      const deps = l402Deps({ paid: true, method: 'cashu' }, tracker)
      const result = await handleFetch({ url: 'https://api.example.com/data', autoPay: true }, deps)
      const parsed = JSON.parse(result.content[0].text)
      expect(result.isError).toBe(true)
      expect(parsed.paymentState).toBe('unknown')
      expect(parsed.message).not.toMatch(/^Payment of/)
      expect(tracker.recentSpend()).toBe(50)
      expect(deps.payInvoice).toHaveBeenCalledTimes(1)
    })

    it('reports a definite L402 failure as an error, not a challenge to pay again', async () => {
      const tracker = new SpendTracker()
      const deps = l402Deps({ paid: false, method: 'nwc', reason: 'no route' }, tracker)
      const result = await handleFetch({ url: 'https://api.example.com/data', autoPay: true }, deps)
      const parsed = JSON.parse(result.content[0].text)
      expect(result.isError).toBe(true)
      expect(parsed.paymentState).toBe('failed')
      expect(tracker.recentSpend()).toBe(0)
    })

    it.each([
      ['reported paid without a preimage', { paid: true, method: 'cashu' }, 'unknown'],
      ['definitely failed', { paid: false, method: 'nwc', reason: 'no route' }, 'failed'],
    ])('does not pay the L402 invoice after an IETF payment %s', async (_label, payResult, state) => {
      const deps = makeDeps({
        fetchFn: vi.fn().mockResolvedValue(mockResponse(402, {
          'www-authenticate': 'Payment id="id1", L402 macaroon="bWFjMQ==", invoice="lnbc50n1test"',
        }, '{}')) as unknown as typeof fetch,
        isIETFPayment: vi.fn().mockReturnValue(true),
        parseIETFPayment: vi.fn().mockReturnValue({ ...ietfChallenge }),
        parseL402: vi.fn().mockReturnValue({ macaroon: 'bWFjMQ==', invoice: 'lnbc50n1test' }),
        decodeBolt11: vi.fn().mockReturnValue({ costSats: 50, paymentHash: 'hash1', expiry: 3600 }),
        payInvoice: vi.fn().mockResolvedValue(payResult),
      })
      const result = await handleFetch({ url: 'https://api.example.com/data', autoPay: true }, deps)
      expect(result.isError).toBe(true)
      expect(JSON.parse(result.content[0].text).paymentState).toBe(state)
      expect(deps.payInvoice).toHaveBeenCalledTimes(1)
      expect(deps.parseL402).not.toHaveBeenCalled()
    })
  })

  describe('unknown outcomes pause auto-pay to the service', () => {
    const HASH = 'ab'.repeat(32)

    it('records an unknown L402 payment against every candidate origin', async () => {
      const add = vi.fn()
      const deps = makeDeps({
        fetchFn: vi.fn() as unknown as typeof fetch,
        transportFetch: vi.fn().mockResolvedValue(mockResponse(402, {
          'www-authenticate': 'L402 macaroon="bWFjMQ==", invoice="lnbc50n1test"',
        }, '{}')) as unknown as FetchDeps['transportFetch'],
        parseL402: vi.fn().mockReturnValue({ macaroon: 'bWFjMQ==', invoice: 'lnbc50n1test' }),
        decodeBolt11: vi.fn().mockReturnValue({ costSats: 50, paymentHash: HASH, expiry: 3600 }),
        payInvoice: vi.fn().mockResolvedValue({ paid: false, method: 'nwc', outcome: 'unknown' }),
        pendingPayments: { add, unresolvedFor: vi.fn().mockReturnValue([]) },
      })
      const result = await handleFetch({
        url: 'https://api.example.com/data',
        urls: ['https://api.example.com/data', 'http://abc.onion/data'],
        pubkey: 'pk1',
        autoPay: true,
      }, deps)
      expect(JSON.parse(result.content[0].text).message).toContain('l402-reconcile')
      expect(add).toHaveBeenCalledWith(expect.objectContaining({
        paymentHash: HASH,
        origins: ['https://api.example.com', 'http://abc.onion'],
        pubkey: 'pk1',
        protocol: 'l402',
        macaroon: 'bWFjMQ==',
      }))
    })

    it('refuses to auto-pay while an earlier payment to the service is unresolved', async () => {
      const unresolvedFor = vi.fn().mockReturnValue([{ paymentHash: HASH }])
      const deps = makeDeps({
        fetchFn: vi.fn().mockResolvedValue(mockResponse(402, {
          'www-authenticate': 'L402 macaroon="bWFjMQ==", invoice="lnbc50n1test"',
        }, '{}')) as unknown as typeof fetch,
        parseL402: vi.fn().mockReturnValue({ macaroon: 'bWFjMQ==', invoice: 'lnbc50n1test' }),
        decodeBolt11: vi.fn().mockReturnValue({ costSats: 50, paymentHash: 'cd'.repeat(32), expiry: 3600 }),
        payInvoice: vi.fn().mockResolvedValue({ paid: true, preimage: 'a'.repeat(64), method: 'nwc' }),
        pendingPayments: { add: vi.fn(), unresolvedFor },
      })
      const result = await handleFetch({ url: 'https://api.example.com/data', pubkey: 'pk1', autoPay: true }, deps)
      const parsed = JSON.parse(result.content[0].text)
      expect(result.isError).toBe(true)
      expect(parsed).toMatchObject({ paymentState: 'blocked', unresolvedPayments: [HASH] })
      expect(parsed.message).toContain('l402-reconcile')
      expect(unresolvedFor).toHaveBeenCalledWith(['https://api.example.com'], 'pk1')
      expect(deps.payInvoice).not.toHaveBeenCalled()
    })
  })

  describe('stored credentials go only to the origins they were bought from', () => {
    const X = 'pubkey-of-service-x'
    const goodCred = { origins: ['https://good.example'], macaroon: 'bWFjMQ==', preimage: 'a'.repeat(64) }

    function storeWith(entries: Record<string, unknown>) {
      return {
        get: vi.fn((k: string) => entries[k]),
        set: vi.fn(),
        delete: vi.fn(),
        updateBalance: vi.fn(),
        updateLastUsed: vi.fn(),
      } as unknown as FetchDeps['credentialStore']
    }

    it('does not send a service credential to another origin that names its pubkey', async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, {}, 'ok'))
      const store = storeWith({ [X]: goodCred })
      await handleFetch({ url: 'https://evil.example/steal', pubkey: X }, makeDeps({ fetchFn: fetchMock as unknown as typeof fetch, credentialStore: store }))
      expect(fetchMock.mock.calls[0][1].headers['Authorization']).toBeUndefined()
      expect(store.updateLastUsed).not.toHaveBeenCalled()
    })

    it('neither deletes nor overwrites the real credential when the other origin charges', async () => {
      const store = storeWith({ [X]: goodCred })
      const deps = makeDeps({
        credentialStore: store,
        fetchFn: vi.fn()
          .mockResolvedValueOnce(mockResponse(402, { 'www-authenticate': 'L402 macaroon="bWFjMg==", invoice="lnbc50n1test"' }, '{}'))
          .mockResolvedValueOnce(mockResponse(200)) as unknown as typeof fetch,
        parseL402: vi.fn().mockReturnValue({ macaroon: 'bWFjMg==', invoice: 'lnbc50n1test' }),
        decodeBolt11: vi.fn().mockReturnValue({ costSats: 50, paymentHash: 'hash1', expiry: 3600 }),
        payInvoice: vi.fn().mockResolvedValue({ paid: true, preimage: 'b'.repeat(64), method: 'nwc' }),
      })
      await handleFetch({ url: 'https://evil.example/steal', pubkey: X, autoPay: true }, deps)
      expect(store.delete).not.toHaveBeenCalled()
      expect(store.set).toHaveBeenCalledWith('https://evil.example', expect.objectContaining({ origins: ['https://evil.example'] }))
      expect(store.set).not.toHaveBeenCalledWith(X, expect.anything())
    })

    it('sends a credential across the transports it was bought for', async () => {
      const fetchMock = vi.fn()
      const transportFetch = vi.fn().mockResolvedValue(mockResponse(200))
      const store = storeWith({ [X]: { ...goodCred, origins: ['https://good.example', 'http://good.onion'] } })
      await handleFetch({
        url: 'https://good.example/a',
        urls: ['https://good.example/a', 'http://good.onion/a'],
        pubkey: X,
      }, makeDeps({ fetchFn: fetchMock as unknown as typeof fetch, transportFetch: transportFetch as unknown as FetchDeps['transportFetch'], credentialStore: store }))
      expect(transportFetch.mock.calls[0][1].headers['Authorization']).toBe(`L402 bWFjMQ==:${'a'.repeat(64)}`)
    })

    it('does not send a pubkey-keyed credential that has no recorded origins', async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockResponse(200))
      const store = storeWith({ [X]: { macaroon: 'bWFjMQ==', preimage: 'a'.repeat(64) } })
      await handleFetch({ url: 'https://good.example/a', pubkey: X }, makeDeps({ fetchFn: fetchMock as unknown as typeof fetch, credentialStore: store }))
      expect(fetchMock.mock.calls[0][1].headers['Authorization']).toBeUndefined()
    })

    it('binds a newly bought credential to the origins it was bought from', async () => {
      const store = storeWith({})
      const deps = makeDeps({
        credentialStore: store,
        fetchFn: vi.fn()
          .mockResolvedValueOnce(mockResponse(402, { 'www-authenticate': 'L402 macaroon="bWFjMg==", invoice="lnbc50n1test"' }, '{}'))
          .mockResolvedValueOnce(mockResponse(200)) as unknown as typeof fetch,
        parseL402: vi.fn().mockReturnValue({ macaroon: 'bWFjMg==', invoice: 'lnbc50n1test' }),
        decodeBolt11: vi.fn().mockReturnValue({ costSats: 50, paymentHash: 'hash1', expiry: 3600 }),
        payInvoice: vi.fn().mockResolvedValue({ paid: true, preimage: 'b'.repeat(64), method: 'nwc' }),
      })
      await handleFetch({ url: 'https://good.example/a', pubkey: X, autoPay: true }, deps)
      expect(store.set).toHaveBeenCalledWith(X, expect.objectContaining({ origins: ['https://good.example'] }))
    })
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
