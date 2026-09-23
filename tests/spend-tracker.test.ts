import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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

  it('a per-minute limit of 0 blocks every spend rather than meaning unlimited', () => {
    const tracker = new SpendTracker()
    expect(tracker.wouldExceed(1, 0)).toBe(true)
    expect(tracker.tryRecord(1, 0)).toBe(false)
    expect(tracker.refusal(1, 0)).toContain('MAX_SPEND_PER_MINUTE_SATS is 0')
    expect(tracker.recentSpend()).toBe(0)
  })

  it('a negative limit blocks every spend', () => {
    const tracker = new SpendTracker()
    expect(tracker.wouldExceed(1, -1)).toBe(true)
  })

  describe('daily limit', () => {
    let dir: string
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'l402-spend-')) })
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.useRealTimers() })

    it('refuses once 24-hour spend would pass it, whatever the per-minute limit', () => {
      const tracker = new SpendTracker({ maxPerDaySats: 100 })
      expect(tracker.tryRecord(60, 10_000)).toBe(true)
      expect(tracker.tryRecord(60, 10_000)).toBe(false)
      expect(tracker.refusal(60, 10_000)).toContain('MAX_SPEND_PER_DAY_SATS')
    })

    it('blocks all auto-pay at 0', () => {
      expect(new SpendTracker({ maxPerDaySats: 0 }).tryRecord(1, 10_000)).toBe(false)
    })

    it('survives a restart and frees headroom after 24 hours', () => {
      vi.useFakeTimers({ now: 1_000_000_000_000 })
      const statePath = join(dir, 'spend-ledger.json')
      const first = new SpendTracker({ maxPerDaySats: 100, statePath })
      expect(first.tryRecord(90, 10_000)).toBe(true)

      vi.setSystemTime(1_000_000_000_000 + 60 * 60_000)
      const restarted = new SpendTracker({ maxPerDaySats: 100, statePath })
      expect(restarted.dailySpend()).toBe(90)
      expect(restarted.tryRecord(20, 10_000)).toBe(false)

      vi.setSystemTime(1_000_000_000_000 + 24 * 60 * 60_000 + 1)
      expect(new SpendTracker({ maxPerDaySats: 100, statePath }).tryRecord(20, 10_000)).toBe(true)
    })

    it('refuses to start on an unreadable ledger rather than resetting the window', () => {
      const statePath = join(dir, 'spend-ledger.json')
      writeFileSync(statePath, 'not json')
      expect(() => new SpendTracker({ maxPerDaySats: 100, statePath })).toThrow(/spend ledger/)
    })
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
