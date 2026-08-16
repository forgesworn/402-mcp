import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, openSync, closeSync, mkdirSync, chmodSync, statSync, constants as fsConstants } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { homedir, platform } from 'node:os'

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

/** The existing file key, or null. Never creates one — used only for migration. */
function readFallbackKeyIfPresent(): Buffer | null {
  try {
    const hex = readFileSync(FALLBACK_KEY_PATH, 'utf8').trim()
    return /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null
  } catch {
    return null
  }
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

  // File already exists — verify permissions and read
  try {
    const st = statSync(FALLBACK_KEY_PATH)
    const perms = st.mode & 0o777
    if (perms !== 0o600) {
      // Tighten permissions if they were widened (e.g. by another tool)
      chmodSync(FALLBACK_KEY_PATH, 0o600)
    }
  } catch { /* stat/chmod may fail on some platforms — proceed with read */ }
  const hex = readFileSync(FALLBACK_KEY_PATH, 'utf8').trim()
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`Encryption key file is corrupted (expected 64 hex chars). Remove ${FALLBACK_KEY_PATH} to regenerate (existing credentials will be lost).`)
  }
  const key = Buffer.from(hex, 'hex')
  return key
}

/**
 * The macOS keychain via the `security` CLI. keytar is an optional dependency
 * and a native module: it was archived upstream in 2023 and publishes no
 * prebuilds for current Node, so on a modern runtime `import('keytar')` throws
 * MODULE_NOT_FOUND for its .node binary and every key silently lands in the
 * file fallback instead. The CLI ships with the OS, needs no build step, and
 * cannot go stale against a Node release.
 */
const macKeychain = {
  get(): string | null {
    try {
      // Exit code 44 (item not found) is the ordinary "no key yet" path.
      return execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    } catch {
      return null
    }
  },
  set(hex: string): boolean {
    try {
      // The key goes in on stdin, never as an argument: argv is world-readable
      // through ps, which would leak the very thing being protected. `-w` with
      // no value prompts for the secret and then a confirmation, so it is
      // written twice. -U updates an existing item rather than failing.
      execFileSync('security', ['add-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-U', '-w'], {
        input: `${hex}\n${hex}\n`, stdio: ['pipe', 'ignore', 'ignore'],
      })
      return macKeychain.get() === hex
    } catch {
      return false
    }
  },
}

export async function getOrCreateKey(): Promise<KeyResult> {
  if (platform() === 'darwin') {
    // A file key outranks anything in the keychain, and the ordering matters
    // more than it looks. loadOrCreateFallbackKey only ever runs after the
    // keychain path has failed, so once that file exists every subsequent
    // write is encrypted under it — including on a machine where the keychain
    // used to work and holds a now-stale item from an older key. Preferring
    // the keychain there would hand back a key that decrypts nothing, and the
    // stores read an undecryptable file as an empty one and overwrite it,
    // destroying stored credentials and bearer notes without an error.
    const fileKey = readFallbackKeyIfPresent()
    if (fileKey) {
      const hex = fileKey.toString('hex')
      if (macKeychain.get() !== hex && macKeychain.set(hex)) {
        console.error(`Note: encryption key copied into the macOS keychain. ${FALLBACK_KEY_PATH} still holds the same key and can be deleted once you have confirmed things still open.`)
      }
      return { key: fileKey, source: 'keychain' }
    }

    const existing = macKeychain.get()
    if (existing && /^[0-9a-f]{64}$/.test(existing)) {
      return { key: Buffer.from(existing, 'hex'), source: 'keychain' }
    }

    const newKey = randomBytes(32)
    // Only claim the keychain once the value reads back intact; a half-written
    // item that fell through to the file would strand anything encrypted under
    // whichever key actually got used.
    if (macKeychain.set(newKey.toString('hex'))) {
      return { key: newKey, source: 'keychain' }
    }
  }

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
