/**
 * Rolling-window spend tracker to prevent runaway auto-pay.
 * Tracks total sats spent within a 60-second sliding window.
 */
export class SpendTracker {
  private entries: Array<{ sats: number; at: number }> = []
  private windowMs = 60_000
  /** Hard cap on entries to prevent unbounded memory growth. */
  private static readonly MAX_ENTRIES = 10_000

  record(sats: number): void {
    if (sats <= 0) return // reject negative or zero values
    // Evict stale entries before adding to prevent unbounded growth
    if (this.entries.length >= SpendTracker.MAX_ENTRIES) {
      const cutoff = Date.now() - this.windowMs
      this.entries = this.entries.filter(e => e.at >= cutoff)
    }
    this.entries.push({ sats, at: Date.now() })
  }

  recentSpend(): number {
    const cutoff = Date.now() - this.windowMs
    this.entries = this.entries.filter(e => e.at >= cutoff)
    return this.entries.reduce((sum, e) => sum + e.sats, 0)
  }

  wouldExceed(sats: number, limit: number): boolean {
    if (limit <= 0) return false // 0 = unlimited
    return this.recentSpend() + sats > limit
  }

  /**
   * Atomic check-and-record: returns true and records the spend if it
   * would NOT exceed the limit, false otherwise. Closes the TOCTOU gap
   * between wouldExceed() and record() for concurrent callers.
   */
  tryRecord(sats: number, limit: number): boolean {
    if (sats <= 0) return true
    if (limit > 0 && this.recentSpend() + sats > limit) return false
    this.record(sats)
    return true
  }
}
