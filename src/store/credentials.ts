import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { getOrCreateKey, encrypt, decrypt, isEncrypted, type EncryptedPayload } from './encryption.js'

export interface StoredCredential {
  macaroon: string
  preimage: string
  paymentHash: string
  creditBalance: number | null
  storedAt: string
  lastUsed: string
  server: 'toll-booth' | null
}

export interface CredentialEntry extends StoredCredential {
  origin: string
}

export class CredentialStore {
  /** Credentials older than 7 days are automatically purged on access. */
  static readonly MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

  private data: Record<string, StoredCredential> = {}
  private key: Buffer | null = null

  constructor(private readonly path: string) {
    // load() is now called from init()
  }

  async init(): Promise<void> {
    this.key = await getOrCreateKey()
    this.load()
  }

  private isExpired(cred: StoredCredential): boolean {
    return Date.now() - new Date(cred.storedAt).getTime() > CredentialStore.MAX_AGE_MS
  }

  private purgeExpired(): void {
    let changed = false
    for (const [origin, cred] of Object.entries(this.data)) {
      if (this.isExpired(cred)) {
        delete this.data[origin]
        changed = true
      }
    }
    if (changed) this.save()
  }

  get(origin: string): StoredCredential | undefined {
    const cred = this.data[origin]
    if (!cred) return undefined
    if (this.isExpired(cred)) {
      this.delete(origin)
      return undefined
    }
    return cred
  }

  set(origin: string, credential: StoredCredential): void {
    this.data[origin] = credential
    this.save()
  }

  delete(origin: string): void {
    delete this.data[origin]
    this.save()
  }

  updateBalance(origin: string, balance: number): void {
    const cred = this.data[origin]
    if (!cred || this.isExpired(cred)) {
      if (cred) this.delete(origin)
      return
    }
    cred.creditBalance = balance
    cred.lastUsed = new Date().toISOString()
    this.save()
  }

  updateLastUsed(origin: string): void {
    const cred = this.data[origin]
    if (!cred || this.isExpired(cred)) {
      if (cred) this.delete(origin)
      return
    }
    cred.lastUsed = new Date().toISOString()
    this.save()
  }

  list(): CredentialEntry[] {
    this.purgeExpired()
    return Object.entries(this.data).map(([origin, cred]) => ({
      origin,
      ...cred,
    }))
  }

  /** List credentials without exposing secret material (macaroon, preimage). */
  listSafe(): Array<Omit<CredentialEntry, 'macaroon' | 'preimage'>> {
    this.purgeExpired()
    return Object.entries(this.data).map(([origin, cred]) => ({
      origin,
      paymentHash: cred.paymentHash,
      creditBalance: cred.creditBalance,
      storedAt: cred.storedAt,
      lastUsed: cred.lastUsed,
      server: cred.server,
    }))
  }

  count(): number {
    return Object.keys(this.data).length
  }

  private load(): void {
    if (!existsSync(this.path)) return
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf-8'))
      if (isEncrypted(raw)) {
        const json = decrypt(raw as EncryptedPayload, this.key!)
        this.data = JSON.parse(json)
      } else {
        // Legacy plaintext; migrate
        this.data = raw
        this.save() // Re-save as encrypted
      }
    } catch { this.data = {} }
  }

  private save(): void {
    const dir = dirname(this.path)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    const json = JSON.stringify(this.data, null, 2)
    const content = this.key
      ? JSON.stringify(encrypt(json, this.key), null, 2)
      : json

    // Atomic write: write to temp file with restricted permissions, then rename.
    // renameSync is atomic on POSIX, preventing data loss on crash.
    const tmpPath = this.path + '.tmp'
    writeFileSync(tmpPath, content, { mode: 0o600 })
    renameSync(tmpPath, this.path)
    try { chmodSync(this.path, 0o600) } catch { /* Windows safety net */ }
  }
}
