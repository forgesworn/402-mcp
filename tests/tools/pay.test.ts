import { describe, it, expect, vi } from 'vitest'
import { handlePay } from '../../src/tools/pay.js'
import { ChallengeCache } from '../../src/l402/challenge-cache.js'
import { SpendTracker } from '../../src/spend-tracker.js'

function hexHash(n: number): string {
  return n.toString(16).padStart(64, '0')
}

const HASH_1 = hexHash(1)
const HASH_2 = hexHash(2)
const HASH_3 = hexHash(3)
const HASH_4 = hexHash(4)

const baseDeps = {
  fetchFn: vi.fn() as unknown as typeof fetch,
  maxSpendPerMinuteSats: 10_000,
  spendTracker: new SpendTracker(),
  decodeBolt11: () => ({ costSats: 10, paymentHash: null, expiry: 3600 }),
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
    const storeCredential = vi.fn().mockReturnValue(true)

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
        storeCredential: vi.fn().mockReturnValue(true),
        maxAutoPaySats: 1000,
      },
    )

    expect(mockWallet.payInvoice).toHaveBeenCalledWith('cached-invoice', { serverOrigin: undefined })
  })

  it('returns error when no wallet available', async () => {
    const result = await handlePay(
      { invoice: 'lnbc...', macaroon: 'mac123', paymentHash: HASH_1 },
      {
        ...baseDeps,
        cache: new ChallengeCache(),
        resolveWallet: () => undefined,
        storeCredential: vi.fn().mockReturnValue(true),
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
    const storeCredential = vi.fn().mockReturnValue(true)

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
    const storeCredential = vi.fn().mockReturnValue(true)

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

  it('passes serverOrigin to human wallet via options', async () => {
    const cache = new ChallengeCache()
    cache.set({
      invoice: 'lnbc100n1test',
      macaroon: 'mac123',
      paymentHash: HASH_1,
      costSats: 10,
      expiresAt: Date.now() + 3600_000,
      url: 'https://api.example.com/data',
    })

    const humanWallet = {
      method: 'human' as const,
      available: true,
      payInvoice: vi.fn().mockResolvedValue({
        paid: true,
        method: 'human',
        preimage: 'human-preimage',
      }),
    }

    const storeCredential = vi.fn().mockReturnValue(true)

    await handlePay(
      { paymentHash: HASH_1, method: 'human' },
      {
        ...baseDeps,
        cache,
        resolveWallet: () => humanWallet,
        storeCredential,
        maxAutoPaySats: 1000,
      },
    )

    expect(humanWallet.payInvoice).toHaveBeenCalledWith(
      'lnbc100n1test',
      { serverOrigin: 'https://api.example.com' },
    )
  })

  it('rejects invoice exceeding maxAutoPaySats', async () => {
    const mockWallet = {
      method: 'nwc' as const,
      available: true,
      payInvoice: vi.fn(),
    }

    const result = await handlePay(
      { invoice: 'lnbc...', macaroon: 'mac123' },
      {
        ...baseDeps,
        cache: new ChallengeCache(),
        resolveWallet: () => mockWallet,
        storeCredential: vi.fn().mockReturnValue(true),
        maxAutoPaySats: 5,
        decodeBolt11: () => ({ costSats: 100, paymentHash: null, expiry: 3600 }),
      },
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.paid).toBe(false)
    expect(parsed.reason).toContain('exceeds auto-pay limit')
    expect(mockWallet.payInvoice).not.toHaveBeenCalled()
  })

  it('rejects when per-minute spend limit is reached', async () => {
    const spendTracker = new SpendTracker()
    // Fill the spend tracker to near-limit
    spendTracker.tryRecord(9990, 10_000)

    const mockWallet = {
      method: 'nwc' as const,
      available: true,
      payInvoice: vi.fn(),
    }

    const result = await handlePay(
      { invoice: 'lnbc...', macaroon: 'mac123' },
      {
        ...baseDeps,
        cache: new ChallengeCache(),
        resolveWallet: () => mockWallet,
        storeCredential: vi.fn().mockReturnValue(true),
        maxAutoPaySats: 1000,
        spendTracker,
        decodeBolt11: () => ({ costSats: 20, paymentHash: null, expiry: 3600 }),
      },
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.paid).toBe(false)
    expect(parsed.reason).toContain('spend limit')
    expect(mockWallet.payInvoice).not.toHaveBeenCalled()
  })

  it('rolls back spend on payment failure', async () => {
    const spendTracker = new SpendTracker()

    const mockWallet = {
      method: 'nwc' as const,
      available: true,
      payInvoice: vi.fn().mockResolvedValue({ paid: false, method: 'nwc' }),
    }

    await handlePay(
      { invoice: 'lnbc...', macaroon: 'mac123' },
      {
        ...baseDeps,
        cache: new ChallengeCache(),
        resolveWallet: () => mockWallet,
        storeCredential: vi.fn().mockReturnValue(true),
        maxAutoPaySats: 1000,
        spendTracker,
        decodeBolt11: () => ({ costSats: 50, paymentHash: null, expiry: 3600 }),
      },
    )

    // After rollback, spend should be 0
    expect(spendTracker.recentSpend()).toBe(0)
  })

  it('returns safe error when wallet throws and rolls back spend', async () => {
    const spendTracker = new SpendTracker()
    const mockWallet = {
      method: 'nwc' as const,
      available: true,
      payInvoice: vi.fn().mockRejectedValue(new Error('NWC connection failed: secret=abc123')),
    }

    const result = await handlePay(
      { invoice: 'lnbc...', macaroon: 'mac123' },
      {
        ...baseDeps,
        cache: new ChallengeCache(),
        resolveWallet: () => mockWallet,
        storeCredential: vi.fn().mockReturnValue(true),
        maxAutoPaySats: 1000,
        spendTracker,
      },
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error).toBeDefined()
    expect(result.isError).toBe(true)
    // Should not leak the raw error with potential secrets
    expect(parsed.error).not.toContain('secret=abc123')
    // Spend should be rolled back on exception
    expect(spendTracker.recentSpend()).toBe(0)
  })

  it('rejects amountless invoices', async () => {
    const mockWallet = {
      method: 'nwc' as const,
      available: true,
      payInvoice: vi.fn(),
    }

    const result = await handlePay(
      { invoice: 'lnbc1...amountless', macaroon: 'mac123' },
      {
        ...baseDeps,
        cache: new ChallengeCache(),
        resolveWallet: () => mockWallet,
        storeCredential: vi.fn().mockReturnValue(true),
        maxAutoPaySats: 1000,
        decodeBolt11: () => ({ costSats: null, paymentHash: null, expiry: 3600 }),
      },
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.paid).toBe(false)
    expect(parsed.reason).toContain('no encoded amount')
    expect(mockWallet.payInvoice).not.toHaveBeenCalled()
  })
})
