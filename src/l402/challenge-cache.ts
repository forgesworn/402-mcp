export interface CachedChallenge {
  invoice: string
  macaroon: string
  paymentHash: string
  costSats: number | null
  expiresAt: number
  url?: string
}

const MAX_CACHE_SIZE = 1000
const PAYMENT_HASH_RE = /^[0-9a-f]{64}$/
/** Maximum length for cached string fields to prevent memory exhaustion. */
const MAX_STRING_LEN = 10_000

/** TTL cache for L402 challenges, keyed by payment hash. Evicts expired entries automatically. */
export class ChallengeCache {
  private cache = new Map<string, CachedChallenge>()

  set(challenge: CachedChallenge): void {
    // Reject invalid payment hashes to prevent collisions or abuse
    if (!PAYMENT_HASH_RE.test(challenge.paymentHash)) return

    // Reject oversized strings to prevent memory exhaustion
    if (challenge.invoice.length > MAX_STRING_LEN || challenge.macaroon.length > MAX_STRING_LEN) return

    if (this.cache.size >= MAX_CACHE_SIZE) {
      this.evictExpired()
    }

    if (this.cache.size >= MAX_CACHE_SIZE) {
      // Evict oldest entry (first key in insertion order)
      const oldestKey = this.cache.keys().next().value
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey)
      }
    }

    this.cache.set(challenge.paymentHash, challenge)
  }

  get(paymentHash: string): CachedChallenge | undefined {
    const entry = this.cache.get(paymentHash)
    if (!entry) return undefined

    if (Date.now() >= entry.expiresAt) {
      this.cache.delete(paymentHash)
      return undefined
    }

    return entry
  }

  delete(paymentHash: string): void {
    this.cache.delete(paymentHash)
  }

  get size(): number {
    return this.cache.size
  }

  private evictExpired(): void {
    const now = Date.now()
    for (const [key, entry] of this.cache) {
      if (now >= entry.expiresAt) {
        this.cache.delete(key)
      }
    }
  }
}
