import { describe, it, expect, vi } from 'vitest'
import { handlePay } from '../../src/tools/pay.js'
import { ChallengeCache } from '../../src/l402/challenge-cache.js'

function hexHash(n: number): string {
  return n.toString(16).padStart(64, '0')
}

const HASH_1 = hexHash(1)
const HASH_2 = hexHash(2)
const HASH_3 = hexHash(3)
const HASH_4 = hexHash(4)

const baseDeps = {
  fetchFn: vi.fn() as unknown as typeof fetch,
}

describe('handlePay', () => {
  it('pays an invoice and stores credential when origin is known', async () => {
    const cache = new ChallengeCache()
    cache.set({
      invoice: 'lnbc...',
      macaroon: 'mac123',
      paymentHash: HASH_1,
      costSats: 10,
      expiresAt: Date.now() + 3600_000,
      url: 'https://api.example.com/resource',
    })

    const mockWallet = {
      method: 'nwc' as const,
      available: true,
      payInvoice: vi.fn().mockResolvedValue({ paid: true, preimage: 'abc', method: 'nwc' }),
    }
    const storeCredential = vi.fn()

    const result = await handlePay(
      { invoice: 'lnbc...', macaroon: 'mac123', paymentHash: HASH_1 },
      {
        ...baseDeps,
        cache,
        resolveWallet: () => mockWallet,
        storeCredential,
        maxAutoPaySats: 1000,
      },
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.paid).toBe(true)
    expect(parsed.preimage).toBeUndefined()
    expect(parsed.credentialsStored).toBe(true)
    expect(storeCredential).toHaveBeenCalled()
  })

  it('uses cached challenge when paymentHash matches', async () => {
    const cache = new ChallengeCache()
    cache.set({
      invoice: 'cached-invoice',
      macaroon: 'cached-mac',
      paymentHash: HASH_2,
      costSats: 10,
      expiresAt: Date.now() + 3600_000,
    })

    const mockWallet = {
      method: 'nwc' as const,
      available: true,
      payInvoice: vi.fn().mockResolvedValue({ paid: true, preimage: 'abc', method: 'nwc' }),
    }

    await handlePay(
      { paymentHash: HASH_2 },
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
      { invoice: 'lnbc...', macaroon: 'mac123', paymentHash: HASH_1 },
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

  it('skips credential storage when origin is empty', async () => {
    const cache = new ChallengeCache()
    // Cache entry with no url - origin will be empty
    cache.set({
      invoice: 'lnbc100n1test',
      macaroon: 'mac123',
      paymentHash: HASH_3,
      costSats: 10,
      expiresAt: Date.now() + 3600_000,
      // no url field
    })

    const mockWallet = {
      method: 'nwc' as const,
      available: true,
      payInvoice: vi.fn().mockResolvedValue({ paid: true, preimage: 'abc', method: 'nwc' }),
    }
    const storeCredential = vi.fn()

    const result = await handlePay(
      { paymentHash: HASH_3 },
      {
        ...baseDeps,
        cache,
        resolveWallet: () => mockWallet,
        storeCredential,
        maxAutoPaySats: 1000,
      },
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.paid).toBe(true)
    expect(parsed.preimage).toBeUndefined()
    expect(parsed.credentialsStored).toBe(false)
    expect(storeCredential).not.toHaveBeenCalled()
  })

  it('stores credentials when origin is valid', async () => {
    const cache = new ChallengeCache()
    cache.set({
      invoice: 'lnbc100n1test',
      macaroon: 'mac123',
      paymentHash: HASH_4,
      costSats: 10,
      expiresAt: Date.now() + 3600_000,
      url: 'https://api.example.com/data',
    })

    const mockWallet = {
      method: 'nwc' as const,
      available: true,
      payInvoice: vi.fn().mockResolvedValue({ paid: true, preimage: 'abc', method: 'nwc' }),
    }
    const storeCredential = vi.fn()

    const result = await handlePay(
      { paymentHash: HASH_4 },
      {
        ...baseDeps,
        cache,
        resolveWallet: () => mockWallet,
        storeCredential,
        maxAutoPaySats: 1000,
      },
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.paid).toBe(true)
    expect(parsed.credentialsStored).toBe(true)
    expect(storeCredential).toHaveBeenCalledWith(
      'https://api.example.com',
      'mac123',
      'abc',
      HASH_4,
      null,
    )
  })

  it('sets server origin on human wallet before paying', async () => {
    const cache = new ChallengeCache()
    cache.set({
      invoice: 'lnbc100n1test',
      macaroon: 'mac123',
      paymentHash: HASH_1,
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
      { paymentHash: HASH_1, method: 'human' },
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
    expect(parsed.preimage).toBeUndefined()
    expect(storeCredential).toHaveBeenCalled()
  })
})
