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

import { CashuTokenStore, type StoredToken } from '../../src/store/cashu-tokens.js'
import { isEncrypted } from '../../src/store/encryption.js'

describe('CashuTokenStore', () => {
  let dir: string
  let filePath: string
  let store: CashuTokenStore

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'l402-cashu-test-'))
    filePath = join(dir, 'tokens.json')
    store = new CashuTokenStore(filePath)
    await store.init()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const token: StoredToken = {
    token: 'cashuAey...',
    mint: 'https://mint.example.com',
    amountSats: 100,
    addedAt: '2026-03-11T09:00:00Z',
  }

  it('starts empty', () => {
    expect(store.list()).toEqual([])
    expect(store.totalBalance()).toBe(0)
  })

  it('adds and lists tokens', () => {
    store.add(token)
    expect(store.list()).toHaveLength(1)
  })

  it('returns total balance', () => {
    store.add(token)
    store.add({ ...token, amountSats: 50 })
    expect(store.totalBalance()).toBe(150)
  })

  it('consumes first token (FIFO)', () => {
    store.add({ ...token, amountSats: 100 })
    store.add({ ...token, token: 'second', amountSats: 50 })
    const consumed = store.consumeFirst()
    expect(consumed?.amountSats).toBe(100)
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0].token).toBe('second')
  })

  it('returns undefined when consuming from empty store', () => {
    expect(store.consumeFirst()).toBeUndefined()
  })

  it('persists tokens in encrypted format', async () => {
    store.add(token)
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    expect(isEncrypted(raw)).toBe(true)
  })

  it('persists to disk and reloads', async () => {
    store.add(token)
    const store2 = new CashuTokenStore(filePath)
    await store2.init()
    expect(store2.list()).toHaveLength(1)
    expect(store2.list()[0].token).toBe(token.token)
  })

  it('removes a specific token', () => {
    store.add(token)
    store.add({ ...token, token: 'second' })
    store.remove('cashuAey...')
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0].token).toBe('second')
  })

  it('migrates plaintext tokens on first read', async () => {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, JSON.stringify({
      tokens: [{ token: 'cashuOld', mint: 'https://old.mint.com', amountSats: 50, addedAt: '2026-01-01T00:00:00Z' }],
    }))
    const migrated = new CashuTokenStore(filePath)
    await migrated.init()
    expect(migrated.list()).toHaveLength(1)
    expect(migrated.list()[0].token).toBe('cashuOld')
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    expect(isEncrypted(raw)).toBe(true)
  })

  describe('reserved proofs from an unresolved melt', () => {
    const reserved = { ...token, token: 'cashuBreserved', amountSats: 128, paymentHash: 'ab'.repeat(32), quoteId: 'q1', reservedAt: '2026-03-11T09:00:00Z' }

    it('are neither spendable nor counted, and survive a reload', async () => {
      store.reserve(reserved)
      expect(store.totalBalance()).toBe(0)
      expect(store.consumeFirst()).toBeUndefined()
      const reloaded = new CashuTokenStore(filePath)
      await reloaded.init()
      expect(reloaded.getReserved(reserved.paymentHash)).toMatchObject({ quoteId: 'q1', amountSats: 128 })
    })

    it('return to the spendable pool when released', () => {
      store.reserve(reserved)
      expect(store.releaseReserved(reserved.paymentHash)).toBe(true)
      expect(store.totalBalance()).toBe(128)
      expect(store.listReserved()).toHaveLength(0)
    })

    it('are forgotten when dropped', () => {
      store.reserve(reserved)
      expect(store.dropReserved(reserved.paymentHash)).toBe(true)
      expect(store.totalBalance()).toBe(0)
      expect(store.listReserved()).toHaveLength(0)
    })
  })
})
