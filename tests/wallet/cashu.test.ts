import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createCashuWallet } from '../../src/wallet/cashu.js'
import type { CashuTokenStore, StoredToken } from '../../src/store/cashu-tokens.js'

function mockTokenStore(tokens: StoredToken[] = []): CashuTokenStore {
  const data = [...tokens]
  return {
    list: () => [...data],
    totalBalance: () => data.reduce((sum, t) => sum + t.amountSats, 0),
    add: vi.fn((t: StoredToken) => data.push(t)),
    consumeFirst: vi.fn(() => data.shift()),
    remove: vi.fn((tokenStr: string) => {
      const idx = data.findIndex(t => t.token === tokenStr)
      if (idx >= 0) data.splice(idx, 1)
    }),
    path: '/tmp/test',
  } as unknown as CashuTokenStore
}

// Shared mock state; reset before each test
const mockWalletInstance = {
  createMeltQuote: vi.fn(),
  send: vi.fn(),
  meltProofs: vi.fn(),
}

vi.mock('@cashu/cashu-ts', () => {
  // Must use a function (not arrow) so it can be called with `new`
  function MockWallet() { return mockWalletInstance }
  return {
    Wallet: MockWallet,
    getDecodedToken: vi.fn(() => ({
      mint: 'https://mint.example.com',
      unit: 'sat',
      proofs: [{ amount: 500, id: 'abc', secret: 's1', C: 'c1' }],
    })),
    getEncodedTokenV4: vi.fn(function getEncodedTokenV4(token: { mint: string; proofs: Array<{ amount: number }> }) {
      return `cashuBchange_${token.proofs.reduce((s: number, p: { amount: number }) => s + p.amount, 0)}`
    }),
  }
})

describe('createCashuWallet', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reports unavailable when token store is empty', () => {
    const wallet = createCashuWallet(mockTokenStore([]))
    expect(wallet.available).toBe(false)
  })

  it('reports available when tokens exist', () => {
    const wallet = createCashuWallet(mockTokenStore([
      { token: 'cashuAtest', mint: 'https://mint.example.com', amountSats: 100, addedAt: new Date().toISOString() },
    ]))
    expect(wallet.available).toBe(true)
  })

  it('returns error when no tokens available', async () => {
    const store = mockTokenStore([])
    const wallet = createCashuWallet(store)
    const result = await wallet.payInvoice('lnbc100n1test')
    expect(result.paid).toBe(false)
    expect(result.reason).toContain('No Cashu tokens')
  })

  it('restores keep proofs and melt change proofs to the token store', async () => {
    const store = mockTokenStore([
      { token: 'cashuAoriginal', mint: 'https://mint.example.com', amountSats: 500, addedAt: new Date().toISOString() },
    ])

    mockWalletInstance.createMeltQuote.mockResolvedValue({
      amount: 100,
      fee_reserve: 10,
    })
    mockWalletInstance.send.mockResolvedValue({
      send: [{ amount: 128, id: 'abc', secret: 's2', C: 'c2' }],
      keep: [{ amount: 256, id: 'abc', secret: 's3', C: 'c3' }],
    })
    mockWalletInstance.meltProofs.mockResolvedValue({
      quote: { state: 'PAID', payment_preimage: 'deadbeef' },
      change: [{ amount: 18, id: 'abc', secret: 's4', C: 'c4' }],
    })

    const wallet = createCashuWallet(store)
    const result = await wallet.payInvoice('lnbc100n1test')

    expect(result.paid).toBe(true)
    expect(result.preimage).toBe('deadbeef')

    // Verify change proofs were re-added: keep (256) + change (18) = 274
    expect(store.add).toHaveBeenCalledTimes(1)
    expect(store.add).toHaveBeenCalledWith(
      expect.objectContaining({
        mint: 'https://mint.example.com',
        amountSats: 274,
        token: 'cashuBchange_274',
      }),
    )
  })

  it('does not add to store when there are no change or keep proofs', async () => {
    const store = mockTokenStore([
      { token: 'cashuAexact', mint: 'https://mint.example.com', amountSats: 100, addedAt: new Date().toISOString() },
    ])

    mockWalletInstance.createMeltQuote.mockResolvedValue({
      amount: 100,
      fee_reserve: 0,
    })
    mockWalletInstance.send.mockResolvedValue({
      send: [{ amount: 100, id: 'abc', secret: 's1', C: 'c1' }],
      keep: [],
    })
    mockWalletInstance.meltProofs.mockResolvedValue({
      quote: { state: 'PAID', payment_preimage: 'aabbccdd' },
      change: [],
    })

    const wallet = createCashuWallet(store)
    const result = await wallet.payInvoice('lnbc100n1test')

    expect(result.paid).toBe(true)
    // add() should not be called since there are no leftover proofs
    expect(store.add).not.toHaveBeenCalled()
  })

  it('still returns success if change proof encoding fails', async () => {
    const store = mockTokenStore([
      { token: 'cashuAbad', mint: 'https://mint.example.com', amountSats: 500, addedAt: new Date().toISOString() },
    ])

    mockWalletInstance.createMeltQuote.mockResolvedValue({
      amount: 100,
      fee_reserve: 10,
    })
    mockWalletInstance.send.mockResolvedValue({
      send: [{ amount: 128, id: 'abc', secret: 's2', C: 'c2' }],
      keep: [{ amount: 256, id: 'abc', secret: 's3', C: 'c3' }],
    })
    mockWalletInstance.meltProofs.mockResolvedValue({
      quote: { state: 'PAID', payment_preimage: 'cafebabe' },
      change: [{ amount: 18, id: 'abc', secret: 's4', C: 'c4' }],
    })

    // Make the encode function throw
    const { getEncodedTokenV4 } = await import('@cashu/cashu-ts')
    vi.mocked(getEncodedTokenV4).mockImplementationOnce(() => { throw new Error('encode failed') })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const wallet = createCashuWallet(store)
    const result = await wallet.payInvoice('lnbc100n1test')

    // Payment still succeeds
    expect(result.paid).toBe(true)
    expect(result.preimage).toBe('cafebabe')

    // Warning was logged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to restore change proofs'),
      expect.any(Error),
    )

    warnSpy.mockRestore()
  })

  it('serialises concurrent payment attempts', async () => {
    const store = mockTokenStore([
      { token: 'cashuA1', mint: 'https://mint.example.com', amountSats: 500, addedAt: new Date().toISOString() },
      { token: 'cashuA2', mint: 'https://mint.example.com', amountSats: 500, addedAt: new Date().toISOString() },
    ])

    mockWalletInstance.createMeltQuote.mockResolvedValue({ amount: 100, fee_reserve: 10 })
    mockWalletInstance.send.mockResolvedValue({
      send: [{ amount: 128, id: 'abc', secret: 's2', C: 'c2' }],
      keep: [],
    })
    mockWalletInstance.meltProofs.mockResolvedValue({
      quote: { state: 'PAID', payment_preimage: 'deadbeef' },
      change: [],
    })

    const wallet = createCashuWallet(store)

    // Fire two payments concurrently — they should serialise, not race
    const [r1, r2] = await Promise.all([
      wallet.payInvoice('lnbc100n1first'),
      wallet.payInvoice('lnbc100n1second'),
    ])

    expect(r1.paid).toBe(true)
    expect(r2.paid).toBe(true)

    // consumeFirst should have been called twice (one per payment, serialised)
    expect(store.consumeFirst).toHaveBeenCalledTimes(2)
  })

  it('does not leak error details on exception', async () => {
    const store = mockTokenStore([
      { token: 'cashuAerr', mint: 'https://mint.example.com', amountSats: 500, addedAt: new Date().toISOString() },
    ])

    mockWalletInstance.createMeltQuote.mockRejectedValue(new Error('Connection to internal-mint.local:3338 refused'))

    const wallet = createCashuWallet(store)
    const result = await wallet.payInvoice('lnbc100n1test')

    expect(result.paid).toBe(false)
    // Error message should be generic, not leak internal details
    expect(result.reason).toBe('Cashu payment failed')
    expect(result.reason).not.toContain('internal-mint')
    expect(result.reason).not.toContain('3338')
    // Token should be re-added since it may not have been spent
    expect(store.add).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'cashuAerr' }),
    )
  })

  it('re-adds swapped proofs (not dead original) when melt fails after send', async () => {
    const store = mockTokenStore([
      { token: 'cashuAfail', mint: 'https://mint.example.com', amountSats: 500, addedAt: new Date().toISOString() },
    ])

    mockWalletInstance.createMeltQuote.mockResolvedValue({
      amount: 100,
      fee_reserve: 10,
    })
    mockWalletInstance.send.mockResolvedValue({
      send: [{ amount: 128, id: 'abc', secret: 's2', C: 'c2' }],
      keep: [],
    })
    mockWalletInstance.meltProofs.mockResolvedValue({
      quote: { state: 'UNPAID' },
      change: [],
    })

    const wallet = createCashuWallet(store)
    const result = await wallet.payInvoice('lnbc100n1test')

    expect(result.paid).toBe(false)
    expect(result.reason).toContain('melt failed')
    // After send() the original token is dead on the mint. The swapped
    // send proofs (128 sats) should be re-added, NOT the original token.
    expect(store.add).toHaveBeenCalledTimes(1)
    expect(store.add).toHaveBeenCalledWith(
      expect.objectContaining({
        mint: 'https://mint.example.com',
        amountSats: 128,
      }),
    )
  })

  it('re-adds original token when error occurs before send', async () => {
    const store = mockTokenStore([
      { token: 'cashuApre', mint: 'https://mint.example.com', amountSats: 500, addedAt: new Date().toISOString() },
    ])

    // Error during createMeltQuote (before send)
    mockWalletInstance.createMeltQuote.mockRejectedValue(new Error('mint unreachable'))

    const wallet = createCashuWallet(store)
    const result = await wallet.payInvoice('lnbc100n1test')

    expect(result.paid).toBe(false)
    expect(result.reason).toBe('Cashu payment failed')
    // Original token should be re-added since send() never ran
    expect(store.add).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'cashuApre' }),
    )
  })

  it('restores swapped proofs when error occurs after send', async () => {
    const store = mockTokenStore([
      { token: 'cashuApost', mint: 'https://mint.example.com', amountSats: 500, addedAt: new Date().toISOString() },
    ])

    mockWalletInstance.createMeltQuote.mockResolvedValue({
      amount: 100,
      fee_reserve: 10,
    })
    mockWalletInstance.send.mockResolvedValue({
      send: [{ amount: 128, id: 'abc', secret: 's2', C: 'c2' }],
      keep: [{ amount: 256, id: 'abc', secret: 's3', C: 'c3' }],
    })
    // meltProofs throws after send() has already swapped the original proofs
    mockWalletInstance.meltProofs.mockRejectedValue(new Error('network timeout'))

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wallet = createCashuWallet(store)
    const result = await wallet.payInvoice('lnbc100n1test')

    expect(result.paid).toBe(false)
    expect(result.reason).toBe('Cashu payment failed')
    // Should restore swapped proofs (keep 256 + send 128 = 384), NOT original
    expect(store.add).toHaveBeenCalledTimes(1)
    expect(store.add).toHaveBeenCalledWith(
      expect.objectContaining({
        mint: 'https://mint.example.com',
        amountSats: 384,
      }),
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('send() succeeded'),
    )
    warnSpy.mockRestore()
  })
})
