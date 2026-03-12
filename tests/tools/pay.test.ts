import { describe, it, expect, vi } from 'vitest'
import { handlePay } from '../../src/tools/pay.js'
import { ChallengeCache } from '../../src/l402/challenge-cache.js'

const baseDeps = {
  fetchFn: vi.fn() as unknown as typeof fetch,
}

describe('handlePay', () => {
  it('pays an invoice and stores credential', async () => {
    const mockWallet = {
      method: 'nwc' as const,
      available: true,
      payInvoice: vi.fn().mockResolvedValue({ paid: true, preimage: 'abc', method: 'nwc' }),
    }
    const storeCredential = vi.fn()

    const result = await handlePay(
      { invoice: 'lnbc...', macaroon: 'mac123', paymentHash: 'hash123' },
      {
        ...baseDeps,
        cache: new ChallengeCache(),
        resolveWallet: () => mockWallet,
        storeCredential,
        maxAutoPaySats: 1000,
      },
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.paid).toBe(true)
    expect(parsed.preimage).toBe('abc')
    expect(storeCredential).toHaveBeenCalled()
  })

  it('uses cached challenge when paymentHash matches', async () => {
    const cache = new ChallengeCache()
    cache.set({
      invoice: 'cached-invoice',
      macaroon: 'cached-mac',
      paymentHash: 'hash123',
      costSats: 10,
      expiresAt: Date.now() + 3600_000,
    })

    const mockWallet = {
      method: 'nwc' as const,
      available: true,
      payInvoice: vi.fn().mockResolvedValue({ paid: true, preimage: 'abc', method: 'nwc' }),
    }

    await handlePay(
      { paymentHash: 'hash123' },
      {
        ...baseDeps,
        cache,
        resolveWallet: () => mockWallet,
        storeCredential: vi.fn(),
        maxAutoPaySats: 1000,
      },
    )

    expect(mockWallet.payInvoice).toHaveBeenCalledWith('cached-invoice')
  })

  it('returns error when no wallet available', async () => {
    const result = await handlePay(
      { invoice: 'lnbc...', macaroon: 'mac123', paymentHash: 'hash123' },
      {
        ...baseDeps,
        cache: new ChallengeCache(),
        resolveWallet: () => undefined,
        storeCredential: vi.fn(),
        maxAutoPaySats: 1000,
      },
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.paid).toBe(false)
    expect(parsed.reason).toContain('No wallet')
  })

  it('sets server origin on human wallet before paying', async () => {
    const cache = new ChallengeCache()
    cache.set({
      invoice: 'lnbc100n1test',
      macaroon: 'mac123',
      paymentHash: 'hash123',
      costSats: 10,
      expiresAt: Date.now() + 3600_000,
      url: 'https://api.example.com/data',
    })

    const setServerOrigin = vi.fn()
    const humanWallet = {
      method: 'human' as const,
      available: true,
      setServerOrigin,
      payInvoice: vi.fn().mockResolvedValue({
        paid: true,
        method: 'human',
        preimage: 'human-preimage',
      }),
    }

    const storeCredential = vi.fn()

    const result = await handlePay(
      { paymentHash: 'hash123', method: 'human' },
      {
        cache,
        resolveWallet: () => humanWallet,
        storeCredential,
        maxAutoPaySats: 1000,
        fetchFn: vi.fn() as unknown as typeof fetch,
      },
    )

    expect(setServerOrigin).toHaveBeenCalledWith('https://api.example.com')
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.paid).toBe(true)
    expect(parsed.preimage).toBe('human-preimage')
    expect(storeCredential).toHaveBeenCalled()
  })
})
