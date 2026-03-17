import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { getOrCreateKey, encrypt, decrypt, isEncrypted } from './encryption.js'

export interface StoredToken {
  token: string
  mint: string
  amountSats: number
  addedAt: string
}

interface TokenStoreData {
  tokens: StoredToken[]
}

/** Encrypted persistent store for Cashu ecash tokens. */
export class CashuTokenStore {
  private data: TokenStoreData = { tokens: [] }
  private key: Buffer | null = null

  constructor(private readonly path: string) {
    // load() is now called from init()
  }

  /** Initialises encryption key and loads persisted tokens. */
  async init(): Promise<{ keySource: 'keychain' | 'file' }> {
    const result = await getOrCreateKey()
    this.key = result.key
    this.load()
    return { keySource: result.source }
  }

  list(): StoredToken[] {
    return [...this.data.tokens]
  }

  totalBalance(): number {
    return this.data.tokens.reduce((sum, t) => sum + t.amountSats, 0)
  }

  add(token: StoredToken): void {
    this.data.tokens.push(token)
    this.save()
  }

  /** Removes and returns the first token (FIFO). Used during Cashu melt payments. */
  consumeFirst(): StoredToken | undefined {
    const token = this.data.tokens.shift()
    if (token) this.save()
    return token
  }

  remove(tokenStr: string): void {
    this.data.tokens = this.data.tokens.filter(t => t.token !== tokenStr)
    this.save()
  }

  /** Returns all tokens from a specific mint (URL normalised — trailing slashes ignored). */
  listByMint(mintUrl: string): StoredToken[] {
    const normalised = mintUrl.replace(/\/+$/, '')
    return this.data.tokens.filter(t => t.mint.replace(/\/+$/, '') === normalised)
  }

  /** Removes specific tokens from the store (matched by token string). */
  removeTokens(tokens: StoredToken[]): void {
    const toRemove = new Set(tokens.map(t => t.token))
    const before = this.data.tokens.length
    this.data.tokens = this.data.tokens.filter(t => !toRemove.has(t.token))
    if (this.data.tokens.length !== before) this.save()
  }

  private load(): void {
    if (!existsSync(this.path)) return
    try {
      const raw: unknown = JSON.parse(readFileSync(this.path, 'utf-8'))
      if (isEncrypted(raw)) {
        const json = decrypt(raw, this.key!)
        const parsed = JSON.parse(json) as TokenStoreData
        this.data = Array.isArray(parsed.tokens) ? parsed : { tokens: [] }
      } else if (typeof raw === 'object' && raw !== null && Array.isArray((raw as TokenStoreData).tokens)) {
        // Legacy plaintext; migrate
        this.data = raw as TokenStoreData
        this.save() // Re-save as encrypted
      } else {
        this.data = { tokens: [] }
      }
    } catch { this.data = { tokens: [] } }
  }

  private save(): void {
    const dir = dirname(this.path)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try { chmodSync(dir, 0o700) } catch { /* Windows safety net */ }
    }
    const json = JSON.stringify(this.data, null, 2)
    const content = this.key
      ? JSON.stringify(encrypt(json, this.key), null, 2)
      : json

    const tmpPath = this.path + '.tmp'
    writeFileSync(tmpPath, content, { mode: 0o600 })
    renameSync(tmpPath, this.path)
    try { chmodSync(this.path, 0o600) } catch { /* Windows safety net */ }
  }
}
