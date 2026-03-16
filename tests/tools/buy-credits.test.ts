import { describe, it, expect, vi } from 'vitest'
import { handleBuyCredits } from '../../src/tools/buy-credits.js'
import { SpendTracker } from '../../src/spend-tracker.js'

describe('handleBuyCredits', () => {
  it('discovers tiers when amountSats is omitted', async () => {
    const tiers = [
      { amountSats: 1000, creditSats: 1000 },
      { amountSats: 5000, creditSats: 5500 },
      { amountSats: 10000, creditSats: 11100 },
    ]

    const mockFetch = vi.fn().mockResolvedValue({
      status: 402,
      headers: new Headers({
        'www-authenticate': 'L402 macaroon="mac123", invoice="lnbc100n1test"',
      }),
      json: async () => ({ credit_tiers: tiers }),
    })

    const result = await handleBuyCredits(
      { url: 'https://api.example.com/data' },
      {
        fetchFn: mockFetch as unknown as typeof fetch,
        payInvoice: vi.fn(),
        storeCredential: vi.fn(),
        decodeBolt11: vi.fn(),
        maxAutoPaySats: 10000,
        maxSpendPerMinuteSats: 10000,
        spendTracker: new SpendTracker(),
        generateQr: vi.fn().mockResolvedValue({ png: 'data:image/png;base64,test', text: '█▀▀█' }),
        walletMethod: () => undefined,
      },
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.tiers).toEqual(tiers)
    expect(result.isError).toBeUndefined()
  })

  it('returns error when discovery hits non-402', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers(),
      text: async () => 'OK',
    })

    const result = await handleBuyCredits(
      { url: 'https://free-api.com/data' },
      {
        fetchFn: mockFetch as unknown as typeof fetch,
        payInvoice: vi.fn(),
        storeCredential: vi.fn(),
        decodeBolt11: vi.fn(),
        maxAutoPaySats: 10000,
        maxSpendPerMinuteSats: 10000,
        spendTracker: new SpendTracker(),
        generateQr: vi.fn().mockResolvedValue({ png: 'data:image/png;base64,test', text: '█▀▀█' }),
        walletMethod: () => undefined,
      },
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error).toContain('Expected 402 but got 200')
    expect(result.isError).toBe(true)
  })

  it('purchases credits and stores credential', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        bolt11: 'lnbc5000n1test',
        macaroon: 'mac456',
        credit_sats: 5500,
      }),
    })

    const storeCredential = vi.fn()
    const payInvoice = vi.fn().mockResolvedValue({ paid: true, preimage: 'pre123', method: 'nwc' })
    const decodeBolt11 = vi.fn().mockReturnValue({ paymentHash: 'hash456', costSats: 5000, expiry: 3600 })

    const result = await handleBuyCredits(
      { url: 'https://api.example.com/data', amountSats: 5000 },
      {
        fetchFn: mockFetch as unknown as typeof fetch,
        payInvoice,
        storeCredential,
        decodeBolt11,
        maxAutoPaySats: 10000,
        maxSpendPerMinuteSats: 10000,
        spendTracker: new SpendTracker(),
        generateQr: vi.fn().mockResolvedValue({ png: 'data:image/png;base64,test', text: '█▀▀█' }),
        walletMethod: () => undefined,
      },
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.paid).toBe(true)
    expect(parsed.amountSats).toBe(5000)
    expect(parsed.creditsReceived).toBe(5500)
    expect(parsed.method).toBe('nwc')
    expect(storeCredential).toHaveBeenCalledWith('https://api.example.com', 'mac456', 'pre123', 'hash456')
    expect(payInvoice).toHaveBeenCalledWith('lnbc5000n1test', { method: undefined, serverOrigin: 'https://api.example.com' })
  })

  it('returns error when create-invoice returns non-ok status', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'internal secret details' }),
    })

    const result = await handleBuyCredits(
      { url: 'https://api.example.com/data', amountSats: 5000 },
      {
        fetchFn: mockFetch as unknown as typeof fetch,
        payInvoice: vi.fn(),
        storeCredential: vi.fn(),
        decodeBolt11: vi.fn(),
        maxAutoPaySats: 10000,
        maxSpendPerMinuteSats: 10000,
        spendTracker: new SpendTracker(),
        generateQr: vi.fn().mockResolvedValue({ png: 'data:image/png;base64,test', text: '█▀▀█' }),
        walletMethod: () => undefined,
      },
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error).toContain('500')
    expect(parsed.error).not.toContain('internal secret details')
    expect(result.isError).toBe(true)
  })

  it('returns error when server response JSON is an array', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ['not', 'an', 'object'],
    })

    const result = await handleBuyCredits(
      { url: 'https://api.example.com/data', amountSats: 5000 },
      {
        fetchFn: mockFetch as unknown as typeof fetch,
        payInvoice: vi.fn(),
        storeCredential: vi.fn(),
        decodeBolt11: vi.fn(),
        maxAutoPaySats: 10000,
        maxSpendPerMinuteSats: 10000,
        spendTracker: new SpendTracker(),
        generateQr: vi.fn().mockResolvedValue({ png: 'data:image/png;base64,test', text: '█▀▀█' }),
        walletMethod: () => undefined,
      },
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error).toBeDefined()
    expect(result.isError).toBe(true)
  })

  it('uses atomic tryRecord to prevent TOCTOU spend-limit bypass', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        bolt11: 'lnbc9000n1test',
        macaroon: 'mac789',
        credit_sats: 9000,
      }),
    })

    const payInvoice = vi.fn().mockResolvedValue({ paid: true, preimage: 'aabb', method: 'nwc' })
    const decodeBolt11 = vi.fn().mockReturnValue({ paymentHash: 'hash789', costSats: 9000, expiry: 3600 })
    const storeCredential = vi.fn()
    const spendTracker = new SpendTracker()

    // First purchase: 9000 sats against 10000 limit — should succeed
    const result1 = await handleBuyCredits(
      { url: 'https://api.example.com/data', amountSats: 9000 },
      {
        fetchFn: mockFetch as unknown as typeof fetch,
        payInvoice,
        storeCredential,
        decodeBolt11,
        maxAutoPaySats: 10000,
        maxSpendPerMinuteSats: 10000,
        spendTracker,
        generateQr: vi.fn().mockResolvedValue({ png: 'data:image/png;base64,test', text: '█▀▀█' }),
        walletMethod: () => undefined,
      },
    )
    const parsed1 = JSON.parse(result1.content[0].text)
    expect(parsed1.paid).toBe(true)

    // Second purchase: 9000 sats again — should be blocked by tryRecord
    const result2 = await handleBuyCredits(
      { url: 'https://api.example.com/data', amountSats: 9000 },
      {
        fetchFn: mockFetch as unknown as typeof fetch,
        payInvoice,
        storeCredential,
        decodeBolt11,
        maxAutoPaySats: 10000,
        maxSpendPerMinuteSats: 10000,
        spendTracker,
        generateQr: vi.fn().mockResolvedValue({ png: 'data:image/png;base64,test', text: '█▀▀█' }),
        walletMethod: () => undefined,
      },
    )
    const parsed2 = JSON.parse(result2.content[0].text)
    expect(parsed2.error).toContain('spend limit')
    expect(result2.isError).toBe(true)
    // payInvoice should only have been called once
    expect(payInvoice).toHaveBeenCalledTimes(1)
  })

  it('returns error when payment fails', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        bolt11: 'lnbc5000n1test',
        macaroon: 'mac456',
        credit_sats: 5500,
      }),
    })

    const payInvoice = vi.fn().mockResolvedValue({ paid: false, method: 'nwc' })

    const result = await handleBuyCredits(
      { url: 'https://api.example.com/data', amountSats: 5000 },
      {
        fetchFn: mockFetch as unknown as typeof fetch,
        payInvoice,
        storeCredential: vi.fn(),
        decodeBolt11: vi.fn().mockReturnValue({ costSats: 5000, paymentHash: 'abc123', expiry: 3600 }),
        maxAutoPaySats: 10000,
        maxSpendPerMinuteSats: 10000,
        spendTracker: new SpendTracker(),
        generateQr: vi.fn().mockResolvedValue({ png: 'data:image/png;base64,test', text: '█▀▀█' }),
        walletMethod: () => undefined,
      },
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.paid).toBe(false)
    expect(parsed.reason).toContain('Payment failed')
    expect(result.isError).toBe(true)
  })

  it('rejects invoice with amount different from requested amountSats', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        bolt11: 'lnbc99999n1test',
        macaroon: 'mac456',
        credit_sats: 100000,
      }),
    })

    const result = await handleBuyCredits(
      { url: 'https://api.example.com/data', amountSats: 1000 },
      {
        fetchFn: mockFetch as unknown as typeof fetch,
        payInvoice: vi.fn(),
        storeCredential: vi.fn(),
        decodeBolt11: vi.fn().mockReturnValue({ costSats: 99999, paymentHash: 'hash1', expiry: 3600 }),
        maxAutoPaySats: 100000,
        maxSpendPerMinuteSats: 100000,
        spendTracker: new SpendTracker(),
        generateQr: vi.fn().mockResolvedValue({ png: 'data:image/png;base64,test', text: '█▀▀█' }),
        walletMethod: () => undefined,
      },
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(result.isError).toBe(true)
    expect(parsed.error).toContain('does not match requested amount')
    // Payment should never have been attempted
    expect(mockFetch).toHaveBeenCalledTimes(1) // only the create-invoice call
  })

  it('rejects amountless invoices to prevent overbilling bypass', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        bolt11: 'lnbc1test',
        macaroon: 'mac456',
      }),
    })

    const result = await handleBuyCredits(
      { url: 'https://api.example.com/data', amountSats: 1000 },
      {
        fetchFn: mockFetch as unknown as typeof fetch,
        payInvoice: vi.fn(),
        storeCredential: vi.fn(),
        decodeBolt11: vi.fn().mockReturnValue({ costSats: null, paymentHash: null, expiry: 3600 }),
        maxAutoPaySats: 10000,
        maxSpendPerMinuteSats: 10000,
        spendTracker: new SpendTracker(),
        generateQr: vi.fn().mockResolvedValue({ png: 'data:image/png;base64,test', text: '█▀▀█' }),
        walletMethod: () => undefined,
      },
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(result.isError).toBe(true)
    expect(parsed.error).toContain('amountless invoice')
  })

  it('allows invoice when decoded amount matches requested amountSats', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        bolt11: 'lnbc5000n1test',
        macaroon: 'mac456',
        credit_sats: 5500,
      }),
    })

    const payInvoice = vi.fn().mockResolvedValue({ paid: true, preimage: 'a'.repeat(64), method: 'nwc' })

    const result = await handleBuyCredits(
      { url: 'https://api.example.com/data', amountSats: 5000 },
      {
        fetchFn: mockFetch as unknown as typeof fetch,
        payInvoice,
        storeCredential: vi.fn().mockReturnValue(true),
        decodeBolt11: vi.fn().mockReturnValue({ costSats: 5000, paymentHash: 'hash1', expiry: 3600 }),
        maxAutoPaySats: 10000,
        maxSpendPerMinuteSats: 10000,
        spendTracker: new SpendTracker(),
        generateQr: vi.fn().mockResolvedValue({ png: 'data:image/png;base64,test', text: '█▀▀█' }),
        walletMethod: () => undefined,
      },
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.paid).toBe(true)
    expect(payInvoice).toHaveBeenCalled()
  })

  it('rejects amount exceeding maxAutoPaySats', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        bolt11: 'lnbc5000n1test',
        macaroon: 'mac456',
        credit_sats: 5500,
      }),
    })

    const payInvoice = vi.fn()

    const result = await handleBuyCredits(
      { url: 'https://api.example.com/data', amountSats: 5000 },
      {
        fetchFn: mockFetch as unknown as typeof fetch,
        payInvoice,
        storeCredential: vi.fn(),
        decodeBolt11: vi.fn().mockReturnValue({ costSats: 5000, paymentHash: 'hash1', expiry: 3600 }),
        maxAutoPaySats: 1000,
        maxSpendPerMinuteSats: 10000,
        spendTracker: new SpendTracker(),
        generateQr: vi.fn().mockResolvedValue({ png: 'data:image/png;base64,test', text: '█▀▀█' }),
        walletMethod: () => undefined,
      },
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(result.isError).toBe(true)
    expect(parsed.error).toContain('per-request limit')
    // Payment should never have been attempted
    expect(payInvoice).not.toHaveBeenCalled()
  })

  it('returns QR image on human wallet timeout', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        bolt11: 'lnbc5000n1test',
        macaroon: 'mac456',
        credit_sats: 5500,
      }),
    })

    const result = await handleBuyCredits(
      { url: 'https://api.example.com/data', amountSats: 5000, method: 'human' },
      {
        fetchFn: mockFetch as unknown as typeof fetch,
        payInvoice: vi.fn().mockResolvedValue({ paid: false, method: 'human', reason: 'timed out' }),
        storeCredential: vi.fn(),
        decodeBolt11: vi.fn().mockReturnValue({ costSats: 5000, paymentHash: 'a'.repeat(64), expiry: 3600 }),
        maxAutoPaySats: 10000,
        maxSpendPerMinuteSats: 10000,
        spendTracker: new SpendTracker(),
        generateQr: vi.fn().mockResolvedValue({ png: 'data:image/png;base64,QRDATA', text: '█▀▀█' }),
        walletMethod: () => 'human',
      },
    )

    expect(result.content).toHaveLength(2)
    expect(result.content[0].type).toBe('text')
    expect(result.content[1].type).toBe('image')

    // Text block starts with QR, followed by JSON
    expect(result.content[0].text).toContain('█▀▀█')
    const jsonPart = result.content[0].text.split('\n\n').slice(1).join('\n\n')
    const parsed = JSON.parse(jsonPart)
    expect(parsed.paid).toBe(false)
    expect(parsed.invoice).toBe('lnbc5000n1test')

    const img = result.content[1] as { type: 'image'; data: string; mimeType: string }
    expect(img.data).toBe('QRDATA')
  })
})
