import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
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
  private data: Record<string, StoredCredential> = {}
  private key: Buffer | null = null

  constructor(private readonly path: string) {
    // load() is now called from init()
  }

  async init(): Promise<void> {
    this.key = await getOrCreateKey()
    this.load()
  }

  get(origin: string): StoredCredential | undefined {
    return this.data[origin]
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
    if (cred) {
      cred.creditBalance = balance
      cred.lastUsed = new Date().toISOString()
      this.save()
    }
  }

  updateLastUsed(origin: string): void {
    const cred = this.data[origin]
    if (cred) {
      cred.lastUsed = new Date().toISOString()
      this.save()
    }
  }

  list(): CredentialEntry[] {
    return Object.entries(this.data).map(([origin, cred]) => ({
      origin,
      ...cred,
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
    if (this.key) {
      const payload = encrypt(json, this.key)
      writeFileSync(this.path, JSON.stringify(payload, null, 2))
    } else {
      writeFileSync(this.path, json)
    }
    try { chmodSync(this.path, 0o600) } catch { /* Windows */ }
  }
}
