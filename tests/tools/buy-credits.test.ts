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
        maxSpendPerMinuteSats: 10000,
        spendTracker: new SpendTracker(),
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
        maxSpendPerMinuteSats: 10000,
        spendTracker: new SpendTracker(),
      },
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error).toContain('Expected 402 but got 200')
    expect(result.isError).toBe(true)
  })

  it('purchases credits and stores credential', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
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
        maxSpendPerMinuteSats: 10000,
        spendTracker: new SpendTracker(),
      },
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.paid).toBe(true)
    expect(parsed.amountSats).toBe(5000)
    expect(parsed.creditsReceived).toBe(5500)
    expect(parsed.method).toBe('nwc')
    expect(storeCredential).toHaveBeenCalledWith('https://api.example.com', 'mac456', 'pre123', 'hash456')
    expect(payInvoice).toHaveBeenCalledWith('lnbc5000n1test', undefined)
  })

  it('returns error when payment fails', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
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
        decodeBolt11: vi.fn(),
        maxSpendPerMinuteSats: 10000,
        spendTracker: new SpendTracker(),
      },
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.paid).toBe(false)
    expect(parsed.reason).toContain('Payment failed')
    expect(result.isError).toBe(true)
  })
})
