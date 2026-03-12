import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const SERVICE = 'l402-mcp'
const ACCOUNT = 'encryption-key'
const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const HEX_RE = /^[0-9a-f]+$/
const IV_HEX_LEN = 24   // 12 bytes = 24 hex chars
const TAG_HEX_LEN = 32  // 16 bytes = 32 hex chars
const FALLBACK_KEY_PATH = join(homedir(), '.l402-mcp', 'encryption.key')

export interface EncryptedPayload {
  iv: string
  tag: string
  ciphertext: string
}

export function encrypt(plaintext: string, key: Buffer): EncryptedPayload {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ciphertext: encrypted.toString('hex'),
  }
}

export function decrypt(payload: EncryptedPayload, key: Buffer): string {
  const iv = Buffer.from(payload.iv, 'hex')
  const tag = Buffer.from(payload.tag, 'hex')
  const ciphertext = Buffer.from(payload.ciphertext, 'hex')
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return decrypted.toString('utf8')
}

export function isEncrypted(data: unknown): data is EncryptedPayload {
  if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data)) return false
  const obj = data as Record<string, unknown>
  if (typeof obj.iv !== 'string' || typeof obj.tag !== 'string' || typeof obj.ciphertext !== 'string') return false
  if (obj.iv.length !== IV_HEX_LEN || obj.tag.length !== TAG_HEX_LEN || obj.ciphertext.length === 0) return false
  return HEX_RE.test(obj.iv) && HEX_RE.test(obj.tag) && HEX_RE.test(obj.ciphertext)
}

function loadOrCreateFallbackKey(): Buffer {
  if (existsSync(FALLBACK_KEY_PATH)) {
    return Buffer.from(readFileSync(FALLBACK_KEY_PATH, 'utf8').trim(), 'hex')
  }
  const newKey = randomBytes(32)
  mkdirSync(dirname(FALLBACK_KEY_PATH), { recursive: true })
  writeFileSync(FALLBACK_KEY_PATH, newKey.toString('hex'), { mode: 0o600 })
  try { chmodSync(FALLBACK_KEY_PATH, 0o600) } catch { /* Windows safety net */ }
  return newKey
}

export async function getOrCreateKey(): Promise<Buffer> {
  try {
    const keytar = await import('keytar')
    const existing = await keytar.default.getPassword(SERVICE, ACCOUNT)
    if (existing) return Buffer.from(existing, 'hex')
    const newKey = randomBytes(32)
    await keytar.default.setPassword(SERVICE, ACCOUNT, newKey.toString('hex'))
    return newKey
  } catch {
    console.error('Warning: OS keychain unavailable; encryption key stored in file with restricted permissions')
    return loadOrCreateFallbackKey()
  }
}
