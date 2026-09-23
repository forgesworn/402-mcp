import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * 60_000

export interface SpendTrackerOptions {
  /**
   * Cap on auto-pay spend in any rolling 24 hours. 0 blocks all auto-pay;
   * undefined leaves the daily window unenforced.
   */
  maxPerDaySats?: number
  /** Where the 24-hour window is kept, so a restart does not reset it. */
  statePath?: string
}

/**
 * Rolling-window spend tracker to prevent runaway auto-pay. Enforces the
 * per-minute limit its callers pass in and, when configured, a daily limit
 * whose window is persisted across restarts.
 *
 * A limit of 0 blocks every spend. It never means "unlimited".
 */
export class SpendTracker {
  private entries: Array<{ sats: number; at: number }> = []
  /** Hard cap on entries to prevent unbounded memory growth. */
  private static readonly MAX_ENTRIES = 10_000
  private readonly maxPerDaySats: number | undefined
  private readonly statePath: string | undefined

  constructor(options: SpendTrackerOptions = {}) {
    this.maxPerDaySats = options.maxPerDaySats
    this.statePath = options.statePath
    this.load()
  }

  record(sats: number): void {
    if (sats <= 0) return // reject negative or zero values
    const now = Date.now()
    this.prune(now)
    if (this.entries.length >= SpendTracker.MAX_ENTRIES) this.entries.shift()
    this.entries.push({ sats, at: now })
    this.save()
  }

  /** Sats spent in the last 60 seconds. */
  recentSpend(): number {
    return this.spentWithin(MINUTE_MS)
  }

  /** Sats spent in the last 24 hours. */
  dailySpend(): number {
    return this.spentWithin(DAY_MS)
  }

  wouldExceed(sats: number, limit: number): boolean {
    return this.refusal(sats, limit) !== null
  }

  /**
   * Why a spend of `sats` would be refused under `perMinuteLimit` and the
   * daily limit, or null if it would be allowed.
   */
  refusal(sats: number, perMinuteLimit: number): string | null {
    if (sats <= 0) return null
    if (perMinuteLimit <= 0) return 'Auto-pay is disabled: MAX_SPEND_PER_MINUTE_SATS is 0.'
    if (this.recentSpend() + sats > perMinuteLimit) {
      return `Per-minute spend limit reached (MAX_SPEND_PER_MINUTE_SATS ${perMinuteLimit}).`
    }
    if (this.maxPerDaySats !== undefined) {
      if (this.maxPerDaySats <= 0) return 'Auto-pay is disabled: MAX_SPEND_PER_DAY_SATS is 0.'
      if (this.dailySpend() + sats > this.maxPerDaySats) {
        return `Daily spend limit reached (MAX_SPEND_PER_DAY_SATS ${this.maxPerDaySats} in any 24 hours).`
      }
    }
    return null
  }

  /**
   * Atomic check-and-record: returns true and records the spend if it
   * would NOT exceed either limit, false otherwise. Closes the TOCTOU gap
   * between wouldExceed() and record() for concurrent callers.
   */
  tryRecord(sats: number, limit: number): boolean {
    if (sats <= 0) return true
    if (this.refusal(sats, limit) !== null) return false
    this.record(sats)
    return true
  }

  /**
   * Roll back a previously recorded spend (e.g. when payment fails after
   * tryRecord succeeded). Removes the most recent matching entry so that
   * failed payments do not consume spend-limit headroom.
   */
  unrecord(sats: number): void {
    if (sats <= 0) return
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].sats === sats) {
        this.entries.splice(i, 1)
        this.save()
        return
      }
    }
  }

  private spentWithin(windowMs: number): number {
    const now = Date.now()
    this.prune(now)
    const cutoff = now - windowMs
    return this.entries.reduce((sum, e) => (e.at >= cutoff ? sum + e.sats : sum), 0)
  }

  /** Entries only matter for as long as the widest window that is enforced. */
  private prune(now: number): void {
    const keepMs = this.maxPerDaySats !== undefined ? DAY_MS : MINUTE_MS
    const cutoff = now - keepMs
    if (this.entries.length > 0 && this.entries[0].at < cutoff) {
      this.entries = this.entries.filter(e => e.at >= cutoff)
    }
  }

  private load(): void {
    if (!this.statePath || !existsSync(this.statePath)) return
    try {
      const raw: unknown = JSON.parse(readFileSync(this.statePath, 'utf-8'))
      const list = (raw as { entries?: unknown }).entries
      if (!Array.isArray(list)) throw new Error('bad shape')
      this.entries = list
        .filter((e): e is { sats: number; at: number } =>
          typeof e === 'object' && e !== null &&
          Number.isSafeInteger((e as { sats: unknown }).sats) && (e as { sats: number }).sats > 0 &&
          Number.isFinite((e as { at: unknown }).at))
        .slice(-SpendTracker.MAX_ENTRIES)
      this.prune(Date.now())
    } catch {
      // Losing the window would quietly reset the daily cap. Refuse instead.
      throw new Error(`Cannot read the spend ledger at ${this.statePath}. It records auto-pay spend for MAX_SPEND_PER_DAY_SATS; fix or move it aside to start again.`)
    }
  }

  private save(): void {
    if (!this.statePath) return
    const dir = dirname(this.statePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try { chmodSync(dir, 0o700) } catch { /* Windows safety net */ }
    }
    const tmpPath = this.statePath + '.tmp'
    writeFileSync(tmpPath, JSON.stringify({ entries: this.entries }), { mode: 0o600 })
    renameSync(tmpPath, this.statePath)
  }
}
