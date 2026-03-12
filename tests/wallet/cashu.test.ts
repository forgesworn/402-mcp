import { describe, it, expect, vi } from 'vitest'
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

describe('createCashuWallet', () => {
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
})
