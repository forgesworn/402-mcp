import { describe, it, expect, vi } from 'vitest'
import { createHumanWallet, pollForSettlement } from '../../src/wallet/human.js'

// Mock decodeBolt11 — the real one can't decode test invoice strings
vi.mock('../../src/l402/bolt11.js', () => ({
  decodeBolt11: () => ({ paymentHash: 'a'.repeat(64), costSats: 100, expiry: 3600 }),
}))

describe('pollForSettlement with exponential backoff', () => {
  it('returns success when settlement found on third poll', async () => {
    let callCount = 0
    const result = await pollForSettlement('abc123', {
      initialIntervalS: 0.01,
      maxIntervalS: 0.1,
      timeoutS: 5,
      checkSettlement: async () => {
        callCount++
        if (callCount >= 3) return { settled: true, preimage: 'preimage123' }
        return { settled: false }
      },
    })
    expect(result.paid).toBe(true)
    expect(result.preimage).toBe('preimage123')
    expect(callCount).toBe(3)
  })

  it('returns paid true but undefined preimage when server omits it', async () => {
    const result = await pollForSettlement('abc123', {
      initialIntervalS: 0.01,
      maxIntervalS: 0.1,
      timeoutS: 5,
      checkSettlement: async () => ({ settled: true, preimage: undefined }),
    })
    expect(result.paid).toBe(true)
    expect(result.preimage).toBeUndefined()
  })

  it('times out and returns paid false', async () => {
    const result = await pollForSettlement('abc123', {
      initialIntervalS: 0.05,
      maxIntervalS: 0.15,
      timeoutS: 0.2,
      checkSettlement: async () => ({ settled: false }),
    })
    expect(result.paid).toBe(false)
    expect(result.reason).toContain('timed out')
  })
})

describe('createHumanWallet', () => {
  it('uses serverOrigin from options for settlement polling', async () => {
    const wallet = createHumanWallet({
      initialIntervalS: 0.01,
      maxIntervalS: 0.1,
      timeoutS: 5,
      fetchFn: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ settled: true, preimage: 'a'.repeat(64) }),
      }) as unknown as typeof fetch,
    })

    const result = await wallet.payInvoice('lnbc100n1test', {
      serverOrigin: 'https://api.example.com',
    })

    expect(result.paid).toBe(true)
    expect(result.preimage).toBe('a'.repeat(64))
  })

  it('returns error when serverOrigin not provided', async () => {
    const wallet = createHumanWallet({
      initialIntervalS: 0.01,
      maxIntervalS: 0.1,
      timeoutS: 5,
      fetchFn: vi.fn() as unknown as typeof fetch,
    })

    const result = await wallet.payInvoice('lnbc100n1test')

    expect(result.paid).toBe(false)
    expect(result.reason).toContain('server origin')
  })
})
