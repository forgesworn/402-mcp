import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'

// The module computes its fallback key path from homedir() at load, and on
// darwin shells out to `security`. Both are redirected here so the suite can
// never read, write or overwrite the real key file or the real login keychain.
// Hoisted, because vi.mock factories are lifted above ordinary declarations.
const { fakeHome, platformMock, execFileSyncMock } = vi.hoisted(() => {
  const base = (process.env.TMPDIR ?? '/tmp').replace(/\/+$/, '')
  return {
    fakeHome: `${base}/402-enc-${Math.random().toString(36).slice(2)}`,
    platformMock: vi.fn(() => 'linux'),
    execFileSyncMock: vi.fn(() => { throw new Error('no keychain in tests') }),
  }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => fakeHome, platform: () => platformMock() }
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: (...args: unknown[]) => execFileSyncMock(...(args as [])) }
})

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

  it('creates a new key from keychain and returns keychain source', async () => {
    const result = await getOrCreateKey()
    expect(result.key).toBeInstanceOf(Buffer)
    expect(result.key.length).toBe(32)
    expect(result.source).toBe('keychain')

    const result2 = await getOrCreateKey()
    expect(result2.key.toString('hex')).toBe(result.key.toString('hex'))
    expect(result2.source).toBe('keychain')
  })

  it('falls back to file-based key when keytar throws and reports file source', async () => {
    const keytar = await import('keytar')
    vi.mocked(keytar.default.getPassword).mockRejectedValueOnce(new Error('keychain unavailable'))

    const result = await getOrCreateKey()
    expect(result.key).toBeInstanceOf(Buffer)
    expect(result.key.length).toBe(32)
    expect(result.source).toBe('file')
  })
})

describe('getOrCreateKey on macOS', () => {
  /** Minimal `security` stand-in, holding at most one generic password. */
  function fakeSecurity(initial?: string) {
    let stored = initial
    execFileSyncMock.mockImplementation(((_cmd: string, args: string[], opts?: { input?: string }) => {
      if (args[0] === 'find-generic-password') {
        if (stored === undefined) throw new Error('exit 44: item not found')
        return stored
      }
      // add-generic-password reads the secret twice off stdin, never argv
      const lines = (opts?.input ?? '').split('\n')
      expect(args).not.toContain(lines[0])
      stored = lines[0]
      return ''
    }) as never)
    return { current: () => stored }
  }

  beforeEach(() => {
    platformMock.mockReturnValue('darwin')
    execFileSyncMock.mockReset()
  })
  afterEach(() => platformMock.mockReturnValue('linux'))

  it('adopts an existing file key and copies it into the keychain', async () => {
    // Simulates the real-world state: keytar broke, the fallback re-keyed, and
    // the keychain still holds a stale item from before. Returning the stale
    // one would decrypt nothing and the stores would overwrite themselves.
    const stale = 'ff'.repeat(32)
    const security = fakeSecurity(stale)
    const fileKey = await getOrCreateKey() // creates the file key on first run
    expect(fileKey.key.length).toBe(32)

    const again = await getOrCreateKey()
    expect(again.key.toString('hex')).toBe(fileKey.key.toString('hex'))
    expect(again.key.toString('hex')).not.toBe(stale)
    expect(security.current()).toBe(again.key.toString('hex'))
  })

  it('never puts the key in argv', async () => {
    fakeSecurity()
    await getOrCreateKey()
    for (const call of execFileSyncMock.mock.calls) {
      const args = (call as unknown as [string, string[]])[1]
      expect(args.some(a => /^[0-9a-f]{64}$/.test(a))).toBe(false)
    }
  })
})
