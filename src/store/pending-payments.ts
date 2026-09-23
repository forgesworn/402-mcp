import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { getOrCreateKey, encrypt, decrypt, isEncrypted } from './encryption.js'

/**
 * A payment whose outcome is unknown: the wallet may have paid, and nothing
 * has yet proved or disproved it. While one is outstanding for a service,
 * auto-pay to that service is refused so the same thing is not bought twice.
 */
export interface PendingPayment {
  paymentHash: string
  /** Origins this payment was made for. Auto-pay to any of them is blocked. */
  origins: string[]
  /** Service pubkey from l402-search, when the request carried one. */
  pubkey?: string
  invoice: string
  costSats: number | null
  protocol: 'l402' | 'ietf-payment'
  /** Wallet method that attempted the payment. */
  method: string
  /** L402 macaroon, so a settled payment can still become a credential. */
  macaroon?: string
  createdAt: string
}

const PAYMENT_HASH_RE = /^[0-9a-f]{64}$/
/** Bound on stored entries; an agent cannot grow the file without limit. */
const MAX_ENTRIES = 500

/** Encrypted persistent record of unknown-outcome payments, keyed by payment hash. */
export class PendingPaymentStore {
  private data: Record<string, PendingPayment> = {}
  private key: Buffer | null = null

  constructor(private readonly path: string) {}

  async init(): Promise<void> {
    this.key = (await getOrCreateKey()).key
    this.load()
  }

  add(entry: PendingPayment): void {
    if (!PAYMENT_HASH_RE.test(entry.paymentHash)) return
    if (!(entry.paymentHash in this.data) && Object.keys(this.data).length >= MAX_ENTRIES) {
      // Refusing to record would let a re-pay through, so the oldest entry
      // goes instead. With this many unresolved payments every origin in the
      // list is blocked anyway.
      const oldest = Object.values(this.data).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
      if (oldest) delete this.data[oldest.paymentHash]
    }
    this.data[entry.paymentHash] = entry
    this.save()
  }

  get(paymentHash: string): PendingPayment | undefined {
    return this.data[paymentHash.toLowerCase()]
  }

  remove(paymentHash: string): boolean {
    const hash = paymentHash.toLowerCase()
    if (!(hash in this.data)) return false
    delete this.data[hash]
    this.save()
    return true
  }

  list(): PendingPayment[] {
    return Object.values(this.data)
  }

  /** Unresolved payments made to any of these origins, or to this service pubkey. */
  unresolvedFor(origins: string[], pubkey?: string): PendingPayment[] {
    const wanted = new Set(origins)
    return this.list().filter(p =>
      p.origins.some(o => wanted.has(o)) || (pubkey !== undefined && p.pubkey === pubkey),
    )
  }

  private load(): void {
    if (!existsSync(this.path)) return
    try {
      const raw: unknown = JSON.parse(readFileSync(this.path, 'utf-8'))
      const parsed: unknown = isEncrypted(raw) ? JSON.parse(decrypt(raw, this.key!)) : raw
      this.data = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, PendingPayment>
        : {}
    } catch {
      // An unreadable ledger must not silently unblock auto-pay. Keep the
      // file for inspection and refuse to start rather than overwrite it.
      throw new Error(`Cannot read the unresolved-payment ledger at ${this.path}. Move it aside only once every payment in it has been checked in your wallet.`)
    }
  }

  private save(): void {
    const dir = dirname(this.path)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try { chmodSync(dir, 0o700) } catch { /* Windows safety net */ }
    }
    const json = JSON.stringify(this.data, null, 2)
    const content = this.key ? JSON.stringify(encrypt(json, this.key), null, 2) : json
    const tmpPath = this.path + '.tmp'
    writeFileSync(tmpPath, content, { mode: 0o600 })
    renameSync(tmpPath, this.path)
    try { chmodSync(this.path, 0o600) } catch { /* Windows safety net */ }
  }
}
