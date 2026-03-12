import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('keytar', () => {
  const store = new Map<string, string>()
  return {
    default: {
      getPassword: vi.fn(async (_s: string, _a: string) => store.get(`${_s}:${_a}`) ?? null),
      setPassword: vi.fn(async (_s: string, _a: string, p: string) => { store.set(`${_s}:${_a}`, p) }),
    },
  }
})

import { CredentialStore, type StoredCredential } from '../../src/store/credentials.js'
import { isEncrypted } from '../../src/store/encryption.js'

describe('CredentialStore', () => {
  let dir: string
  let filePath: string
  let store: CredentialStore

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'l402-test-'))
    filePath = join(dir, 'credentials.json')
    store = new CredentialStore(filePath)
    await store.init()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const cred: StoredCredential = {
    macaroon: 'mac123',
    preimage: 'pre123',
    paymentHash: 'hash123',
    creditBalance: 100,
    storedAt: '2026-03-11T10:00:00Z',
    lastUsed: '2026-03-11T10:00:00Z',
    server: 'toll-booth',
  }

  it('stores and retrieves a credential by origin', () => {
    store.set('https://api.example.com', cred)
    expect(store.get('https://api.example.com')).toEqual(cred)
  })

  it('returns undefined for unknown origin', () => {
    expect(store.get('https://unknown.com')).toBeUndefined()
  })

  it('replaces existing credential for same origin', () => {
    store.set('https://api.example.com', cred)
    const updated = { ...cred, creditBalance: 50 }
    store.set('https://api.example.com', updated)
    expect(store.get('https://api.example.com')?.creditBalance).toBe(50)
  })

  it('persists to disk and reloads', async () => {
    store.set('https://api.example.com', cred)
    const store2 = new CredentialStore(filePath)
    await store2.init()
    expect(store2.get('https://api.example.com')).toEqual(cred)
  })

  it('lists all credentials', () => {
    store.set('https://a.com', cred)
    store.set('https://b.com', { ...cred, paymentHash: 'hash456' })
    const all = store.list()
    expect(all).toHaveLength(2)
  })

  it('counts credentials', () => {
    store.set('https://a.com', cred)
    store.set('https://b.com', cred)
    expect(store.count()).toBe(2)
  })

  it('creates parent directory if missing', async () => {
    const deepPath = join(dir, 'sub', 'dir', 'creds.json')
    const deepStore = new CredentialStore(deepPath)
    await deepStore.init()
    deepStore.set('https://a.com', cred)
    expect(deepStore.get('https://a.com')).toEqual(cred)
  })

  it('persists credentials in encrypted format', async () => {
    const store = new CredentialStore(filePath)
    await store.init()
    store.set('https://api.example.com', {
      macaroon: 'test-mac',
      preimage: 'test-pre',
      paymentHash: 'test-hash',
      creditBalance: 100,
      storedAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
      server: 'toll-booth',
    })
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    expect(isEncrypted(raw)).toBe(true)
  })

  it('deletes a credential by origin', () => {
    store.set('https://api.example.com', cred)
    expect(store.get('https://api.example.com')).not.toBeUndefined()

    store.delete('https://api.example.com')

    expect(store.get('https://api.example.com')).toBeUndefined()
    expect(store.count()).toBe(0)
  })

  it('delete is a no-op for unknown origin', () => {
    expect(() => store.delete('https://unknown.com')).not.toThrow()
  })

  it('migrates plaintext credentials on first read', async () => {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, JSON.stringify({
      'https://old.example.com': {
        macaroon: 'old-mac', preimage: 'old-pre', paymentHash: 'old-hash',
        creditBalance: 50, storedAt: '2026-01-01T00:00:00Z',
        lastUsed: '2026-01-01T00:00:00Z', server: null,
      },
    }))
    const store = new CredentialStore(filePath)
    await store.init()
    const cred = store.get('https://old.example.com')
    expect(cred?.macaroon).toBe('old-mac')
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    expect(isEncrypted(raw)).toBe(true)
  })
})
