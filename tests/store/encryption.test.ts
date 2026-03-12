import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomBytes } from 'node:crypto'

vi.mock('keytar', () => {
  const store = new Map<string, string>()
  return {
    default: {
      getPassword: vi.fn(async (_service: string, _account: string) => store.get(`${_service}:${_account}`) ?? null),
      setPassword: vi.fn(async (_service: string, _account: string, password: string) => { store.set(`${_service}:${_account}`, password) }),
    },
  }
})

import { encrypt, decrypt, isEncrypted, getOrCreateKey } from '../../src/store/encryption.js'

describe('encrypt / decrypt', () => {
  const key = randomBytes(32)

  it('round-trips plaintext correctly', () => {
    const plaintext = 'hello, world!'
    const payload = encrypt(plaintext, key)
    expect(decrypt(payload, key)).toBe(plaintext)
  })

  it('produces different IVs on each call', () => {
    const payload1 = encrypt('same text', key)
    const payload2 = encrypt('same text', key)
    expect(payload1.iv).not.toBe(payload2.iv)
  })

  it('throws when ciphertext is tampered', () => {
    const payload = encrypt('secret data', key)
    const tampered = {
      ...payload,
      ciphertext: payload.ciphertext.replace(/.$/, payload.ciphertext.endsWith('f') ? '0' : 'f'),
    }
    expect(() => decrypt(tampered, key)).toThrow()
  })

  it('throws when auth tag is tampered', () => {
    const payload = encrypt('secret data', key)
    const tampered = {
      ...payload,
      tag: payload.tag.replace(/.$/, payload.tag.endsWith('f') ? '0' : 'f'),
    }
    expect(() => decrypt(tampered, key)).toThrow()
  })

  it('throws when wrong key is used', () => {
    const payload = encrypt('secret data', key)
    const wrongKey = randomBytes(32)
    expect(() => decrypt(payload, wrongKey)).toThrow()
  })
})

describe('isEncrypted', () => {
  it('returns true for a valid EncryptedPayload', () => {
    const key = randomBytes(32)
    const payload = encrypt('data', key)
    expect(isEncrypted(payload)).toBe(true)
  })

  it('returns false for a plain object without required fields', () => {
    expect(isEncrypted({ foo: 'bar' })).toBe(false)
  })

  it('returns false for null', () => {
    expect(isEncrypted(null)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isEncrypted(undefined)).toBe(false)
  })

  it('returns false for a string', () => {
    expect(isEncrypted('some string')).toBe(false)
  })

  it('returns false for an array', () => {
    expect(isEncrypted(['iv', 'tag', 'ciphertext'])).toBe(false)
  })

  it('returns false when any required field is empty', () => {
    expect(isEncrypted({ iv: '', tag: 'abc', ciphertext: 'def' })).toBe(false)
    expect(isEncrypted({ iv: 'abc', tag: '', ciphertext: 'def' })).toBe(false)
    expect(isEncrypted({ iv: 'abc', tag: 'def', ciphertext: '' })).toBe(false)
  })

  it('returns false when iv has wrong length', () => {
    // iv should be 24 hex chars (12 bytes); tag 32 hex chars (16 bytes)
    expect(isEncrypted({ iv: 'aabb', tag: 'a'.repeat(32), ciphertext: 'ff' })).toBe(false)
  })

  it('returns false when tag has wrong length', () => {
    expect(isEncrypted({ iv: 'a'.repeat(24), tag: 'aabb', ciphertext: 'ff' })).toBe(false)
  })

  it('returns false when fields contain non-hex characters', () => {
    expect(isEncrypted({ iv: 'g'.repeat(24), tag: 'a'.repeat(32), ciphertext: 'ff' })).toBe(false)
    expect(isEncrypted({ iv: 'a'.repeat(24), tag: 'Z'.repeat(32), ciphertext: 'ff' })).toBe(false)
    expect(isEncrypted({ iv: 'a'.repeat(24), tag: 'a'.repeat(32), ciphertext: 'XY' })).toBe(false)
  })

  it('returns true for correctly-sized hex fields', () => {
    expect(isEncrypted({ iv: 'ab'.repeat(12), tag: 'cd'.repeat(16), ciphertext: 'ef01' })).toBe(true)
  })
})

describe('getOrCreateKey', () => {
  beforeEach(async () => {
    const keytar = await import('keytar')
    vi.mocked(keytar.default.getPassword).mockClear()
    vi.mocked(keytar.default.setPassword).mockClear()
    // Reset internal keytar store between tests by clearing mocked data
    const store = new Map<string, string>()
    vi.mocked(keytar.default.getPassword).mockImplementation(
      async (_service: string, _account: string) => store.get(`${_service}:${_account}`) ?? null
    )
    vi.mocked(keytar.default.setPassword).mockImplementation(
      async (_service: string, _account: string, password: string) => { store.set(`${_service}:${_account}`, password) }
    )
  })

  it('creates a new key and returns the same key on subsequent calls', async () => {
    const key1 = await getOrCreateKey()
    expect(key1).toBeInstanceOf(Buffer)
    expect(key1.length).toBe(32)

    const key2 = await getOrCreateKey()
    expect(key2.toString('hex')).toBe(key1.toString('hex'))
  })

  it('falls back to file-based key when keytar throws', async () => {
    const keytar = await import('keytar')
    vi.mocked(keytar.default.getPassword).mockRejectedValueOnce(new Error('keychain unavailable'))

    const key = await getOrCreateKey()
    expect(key).toBeInstanceOf(Buffer)
    expect(key.length).toBe(32)
  })
})
