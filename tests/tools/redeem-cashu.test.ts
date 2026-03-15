import { describe, it, expect, vi } from 'vitest'
import { handleRedeemCashu, type RedeemCashuDeps } from '../../src/tools/redeem-cashu.js'
import { SpendTracker } from '../../src/spend-tracker.js'

function makeBaseDeps(overrides: Partial<RedeemCashuDeps> = {}): RedeemCashuDeps {
  return {
    fetchFn: vi.fn() as unknown as typeof fetch,
    storeCredential: vi.fn().mockReturnValue(true),
    removeToken: vi.fn(),
    decodeToken: vi.fn().mockReturnValue({ proofs: [{ amount: 100 }] }),
    maxAutoPaySats: 1000,
    maxSpendPerMinuteSats: 10000,
    spendTracker: new SpendTracker(),
    ...overrides,
  }
}

describe('handleRedeemCashu', () => {
  it('redeems a token and stores credential', async () => {
    const mockFetch = vi.fn()
      // First call: create-invoice
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          payment_hash: 'hash789',
          macaroon: 'mac789',
          payment_url: '/invoice-status/hash789?token=status123',
        }),
      })
      // Second call: cashu-redeem
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token_suffix: 'suffix456',
          credited: 1000,
        }),
      })

    const storeCredential = vi.fn().mockReturnValue(true)
    const removeToken = vi.fn()

    const deps = makeBaseDeps({
      fetchFn: mockFetch as unknown as typeof fetch,
      storeCredential,
      removeToken,
    })

    const result = await handleRedeemCashu(
      { url: 'https://api.example.com/data', token: 'cashuAeyJ...' },
      deps,
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.redeemed).toBe(true)
    expect(parsed.creditsReceived).toBe(1000)
    expect(parsed.credentialsStored).toBe(true)
    expect(storeCredential).toHaveBeenCalledWith('https://api.example.com', 'mac789', 'suffix456', 'hash789')
    expect(removeToken).toHaveBeenCalledWith('cashuAeyJ...')

    // Verify fetch calls
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.example.com/create-invoice')
    expect(mockFetch.mock.calls[1][0]).toBe('https://api.example.com/cashu-redeem')
  })

  it('returns error when create-invoice response JSON is an array', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ['not', 'an', 'object'],
    })

    const result = await handleRedeemCashu(
      { url: 'https://api.example.com/data', token: 'cashuAeyJ...' },
      makeBaseDeps({ fetchFn: mockFetch as unknown as typeof fetch }),
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error).toBeDefined()
    expect(result.isError).toBe(true)
  })

  it('returns error when create-invoice fails', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: 'Rate limited' }),
    })

    const result = await handleRedeemCashu(
      { url: 'https://api.example.com/data', token: 'cashuAeyJ...' },
      makeBaseDeps({ fetchFn: mockFetch as unknown as typeof fetch }),
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error).toContain('Failed to create invoice')
    expect(parsed.error).toContain('429')
    // Must NOT leak upstream error body
    expect(parsed.error).not.toContain('Rate limited')
    expect(result.isError).toBe(true)
  })

  it('returns error when cashu-redeem fails', async () => {
    const mockFetch = vi.fn()
      // First call: create-invoice succeeds
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          payment_hash: 'hash789',
          macaroon: 'mac789',
          payment_url: '/invoice-status/hash789?token=status123',
        }),
      })
      // Second call: cashu-redeem fails
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: 'Token already spent' }),
      })

    const storeCredential = vi.fn().mockReturnValue(true)
    const removeToken = vi.fn()

    const result = await handleRedeemCashu(
      { url: 'https://api.example.com/data', token: 'cashuAeyJ...' },
      makeBaseDeps({ fetchFn: mockFetch as unknown as typeof fetch, storeCredential, removeToken }),
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error).toContain('Cashu redemption failed')
    expect(parsed.error).toContain('400')
    // Must NOT leak upstream error body
    expect(parsed.error).not.toContain('Token already spent')
    expect(result.isError).toBe(true)
    expect(storeCredential).not.toHaveBeenCalled()
    expect(removeToken).not.toHaveBeenCalled()
  })

  it('rejects empty token_suffix from server', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          payment_hash: 'hash789',
          macaroon: 'mac789',
          payment_url: '/invoice-status/hash789?token=status123',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token_suffix: '',
          credited: 1000,
        }),
      })

    const storeCredential = vi.fn().mockReturnValue(true)

    const result = await handleRedeemCashu(
      { url: 'https://api.example.com/data', token: 'cashuAeyJ...' },
      makeBaseDeps({ fetchFn: mockFetch as unknown as typeof fetch, storeCredential }),
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error).toBeDefined()
    expect(result.isError).toBe(true)
    // Must NOT store credential with empty preimage
    expect(storeCredential).not.toHaveBeenCalled()
  })

  it('rejects token exceeding maxAutoPaySats', async () => {
    const deps = makeBaseDeps({
      decodeToken: vi.fn().mockReturnValue({ proofs: [{ amount: 5000 }] }),
      maxAutoPaySats: 1000,
    })

    const result = await handleRedeemCashu(
      { url: 'https://api.example.com/data', token: 'cashuAeyJ...' },
      deps,
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error).toContain('exceeds MAX_AUTO_PAY_SATS')
    expect(result.isError).toBe(true)
    expect(deps.fetchFn).not.toHaveBeenCalled()
  })

  it('rejects when per-minute spend limit is reached', async () => {
    const spendTracker = new SpendTracker()
    // Fill up the spend tracker
    spendTracker.tryRecord(9500, 10000)

    const deps = makeBaseDeps({
      decodeToken: vi.fn().mockReturnValue({ proofs: [{ amount: 600 }] }),
      maxAutoPaySats: 1000,
      maxSpendPerMinuteSats: 10000,
      spendTracker,
    })

    const result = await handleRedeemCashu(
      { url: 'https://api.example.com/data', token: 'cashuAeyJ...' },
      deps,
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error).toContain('spend limit')
    expect(result.isError).toBe(true)
    expect(deps.fetchFn).not.toHaveBeenCalled()
  })

  it('rolls back spend tracker on failed redemption', async () => {
    const spendTracker = new SpendTracker()
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          payment_hash: 'hash789',
          macaroon: 'mac789',
          payment_url: '/invoice-status/hash789?token=status123',
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
      })

    const deps = makeBaseDeps({
      fetchFn: mockFetch as unknown as typeof fetch,
      decodeToken: vi.fn().mockReturnValue({ proofs: [{ amount: 500 }] }),
      spendTracker,
    })

    await handleRedeemCashu(
      { url: 'https://api.example.com/data', token: 'cashuAeyJ...' },
      deps,
    )

    // Spend should be rolled back after failure
    expect(spendTracker.recentSpend()).toBe(0)
  })

  it('rejects token with zero value', async () => {
    const deps = makeBaseDeps({
      decodeToken: vi.fn().mockReturnValue({ proofs: [{ amount: 0 }] }),
    })

    const result = await handleRedeemCashu(
      { url: 'https://api.example.com/data', token: 'cashuAeyJ...' },
      deps,
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error).toContain('no value')
    expect(result.isError).toBe(true)
  })

  it('rejects malformed token that fails decoding', async () => {
    const deps = makeBaseDeps({
      decodeToken: vi.fn().mockImplementation(() => { throw new Error('Invalid token') }),
    })

    const result = await handleRedeemCashu(
      { url: 'https://api.example.com/data', token: 'garbage' },
      deps,
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error).toContain('decode')
    expect(result.isError).toBe(true)
  })
})
