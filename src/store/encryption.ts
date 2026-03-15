import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, openSync, closeSync, mkdirSync, chmodSync, constants as fsConstants } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const SERVICE = '402-mcp'
const ACCOUNT = 'encryption-key'
const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const HEX_RE = /^[0-9a-f]+$/
const IV_HEX_LEN = 24   // 12 bytes = 24 hex chars
const TAG_HEX_LEN = 32  // 16 bytes = 32 hex chars
const FALLBACK_KEY_PATH = join(homedir(), '.402-mcp', 'encryption.key')

export interface EncryptedPayload {
  iv: string
  tag: string
  ciphertext: string
}

export interface KeyResult {
  key: Buffer
  source: 'keychain' | 'file'
}

/** Encrypts plaintext using AES-256-GCM with a random IV. */
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

/** Decrypts an AES-256-GCM encrypted payload. */
export function decrypt(payload: EncryptedPayload, key: Buffer): string {
  const iv = Buffer.from(payload.iv, 'hex')
  const tag = Buffer.from(payload.tag, 'hex')
  const ciphertext = Buffer.from(payload.ciphertext, 'hex')
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return decrypted.toString('utf8')
}

/** Type guard that checks whether data matches the encrypted payload shape. */
export function isEncrypted(data: unknown): data is EncryptedPayload {
  if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data)) return false
  const obj = data as Record<string, unknown>
  if (typeof obj.iv !== 'string' || typeof obj.tag !== 'string' || typeof obj.ciphertext !== 'string') return false
  if (obj.iv.length !== IV_HEX_LEN || obj.tag.length !== TAG_HEX_LEN || obj.ciphertext.length === 0) return false
  return HEX_RE.test(obj.iv) && HEX_RE.test(obj.tag) && HEX_RE.test(obj.ciphertext)
}

function loadOrCreateFallbackKey(): Buffer {
  // Try to create atomically first (O_CREAT | O_EXCL fails if file exists)
  mkdirSync(dirname(FALLBACK_KEY_PATH), { recursive: true, mode: 0o700 })
  try {
    const newKey = randomBytes(32)
    const fd = openSync(FALLBACK_KEY_PATH, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
    try {
      writeFileSync(fd, newKey.toString('hex'))
    } finally {
      closeSync(fd)
    }
    try { chmodSync(FALLBACK_KEY_PATH, 0o600) } catch { /* Windows safety net */ }
    return newKey
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }

  // File already exists — read and validate
  const hex = readFileSync(FALLBACK_KEY_PATH, 'utf8').trim()
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`Encryption key file is corrupted (expected 64 hex chars). Remove ${FALLBACK_KEY_PATH} to regenerate (existing credentials will be lost).`)
  }
  const key = Buffer.from(hex, 'hex')
  return key
}

export async function getOrCreateKey(): Promise<KeyResult> {
  try {
    const keytar = await import('keytar')
    const existing = await keytar.default.getPassword(SERVICE, ACCOUNT)
    if (existing) return { key: Buffer.from(existing, 'hex'), source: 'keychain' }
    const newKey = randomBytes(32)
    await keytar.default.setPassword(SERVICE, ACCOUNT, newKey.toString('hex'))
    return { key: newKey, source: 'keychain' }
  } catch {
    console.error('Warning: OS keychain unavailable; encryption key stored in file with restricted permissions')
    return { key: loadOrCreateFallbackKey(), source: 'file' }
  }
}
