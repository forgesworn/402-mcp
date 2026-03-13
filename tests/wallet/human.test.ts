import { describe, it, expect } from 'vitest'
import { pollForSettlement } from '../../src/wallet/human.js'

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
