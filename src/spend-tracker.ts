/**
 * Rolling-window spend tracker to prevent runaway auto-pay.
 * Tracks total sats spent within a 60-second sliding window.
 */
export class SpendTracker {
  private entries: Array<{ sats: number; at: number }> = []
  private windowMs = 60_000

  record(sats: number): void {
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
}
