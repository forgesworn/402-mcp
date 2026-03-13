import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SpendTracker } from '../src/spend-tracker.js'

describe('SpendTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts with zero recent spend', () => {
    const tracker = new SpendTracker()
    expect(tracker.recentSpend()).toBe(0)
  })

  it('tracks recorded spend', () => {
    const tracker = new SpendTracker()
    tracker.record(100)
    tracker.record(200)
    expect(tracker.recentSpend()).toBe(300)
  })

  it('expires entries older than 60 seconds', () => {
    const tracker = new SpendTracker()
    tracker.record(500)

    vi.advanceTimersByTime(61_000)

    expect(tracker.recentSpend()).toBe(0)
  })

  it('keeps entries within the 60-second window', () => {
    const tracker = new SpendTracker()
    tracker.record(500)

    vi.advanceTimersByTime(30_000)
    tracker.record(300)

    vi.advanceTimersByTime(31_000)

    // First entry expired, second still within window
    expect(tracker.recentSpend()).toBe(300)
  })

  it('wouldExceed returns true when limit would be exceeded', () => {
    const tracker = new SpendTracker()
    tracker.record(8000)
    expect(tracker.wouldExceed(3000, 10000)).toBe(true)
  })

  it('wouldExceed returns false when within limit', () => {
    const tracker = new SpendTracker()
    tracker.record(5000)
    expect(tracker.wouldExceed(3000, 10000)).toBe(false)
  })

  it('wouldExceed returns false when limit is 0 (unlimited)', () => {
    const tracker = new SpendTracker()
    tracker.record(999999)
    expect(tracker.wouldExceed(999999, 0)).toBe(false)
  })

  it('wouldExceed returns false for negative limit (unlimited)', () => {
    const tracker = new SpendTracker()
    tracker.record(999999)
    expect(tracker.wouldExceed(999999, -1)).toBe(false)
  })

  it('wouldExceed accounts for expired entries', () => {
    const tracker = new SpendTracker()
    tracker.record(9000)

    vi.advanceTimersByTime(61_000)

    // Old entry expired; should be within limit now
    expect(tracker.wouldExceed(5000, 10000)).toBe(false)
  })

  it('evicts stale entries when approaching MAX_ENTRIES cap', () => {
    const tracker = new SpendTracker()

    // Add entries at time 0
    for (let i = 0; i < 100; i++) {
      tracker.record(1)
    }
    expect(tracker.recentSpend()).toBe(100)

    // Advance past the 60s window
    vi.advanceTimersByTime(61_000)

    // These should be fresh entries; stale ones get cleaned on record()
    for (let i = 0; i < 50; i++) {
      tracker.record(1)
    }
    expect(tracker.recentSpend()).toBe(50)
  })

  it('record ignores negative values', () => {
    const tracker = new SpendTracker()
    tracker.record(100)
    tracker.record(-50)
    expect(tracker.recentSpend()).toBe(100)
  })

  it('record ignores zero values', () => {
    const tracker = new SpendTracker()
    tracker.record(100)
    tracker.record(0)
    expect(tracker.recentSpend()).toBe(100)
  })

  describe('tryRecord', () => {
    it('records and returns true when within limit', () => {
      const tracker = new SpendTracker()
      expect(tracker.tryRecord(500, 1000)).toBe(true)
      expect(tracker.recentSpend()).toBe(500)
    })

    it('rejects and returns false when would exceed limit', () => {
      const tracker = new SpendTracker()
      tracker.record(8000)
      expect(tracker.tryRecord(3000, 10000)).toBe(false)
      // Spend should not have increased
      expect(tracker.recentSpend()).toBe(8000)
    })

    it('returns true for non-positive sats', () => {
      const tracker = new SpendTracker()
      expect(tracker.tryRecord(0, 1000)).toBe(true)
      expect(tracker.tryRecord(-5, 1000)).toBe(true)
    })
  })

  it('wouldExceed returns true at exactly the limit boundary', () => {
    const tracker = new SpendTracker()
    tracker.record(5000)
    // 5000 + 5001 = 10001 > 10000
    expect(tracker.wouldExceed(5001, 10000)).toBe(true)
    // 5000 + 5000 = 10000, not > 10000
    expect(tracker.wouldExceed(5000, 10000)).toBe(false)
  })
})
