import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computePaymentHash } from 'farrier-kit'
import { createLnurlcashWallet } from '../../src/wallet/lnurlcash.js'
import { LnurlcashNoteStore } from '../../src/store/lnurlcash-notes.js'

const MINT = 'https://mint.example.com'

// Real invoices, since the provider actually decodes them.
const INV_1000 = 'lnbc10n1pj48ugqpp5urnh55r5z2cjpahduc0ky22mrfajluva8hxg7ujnu5txx3cv3z8qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqgp0xzz'
const HASH_1000 = 'e0e77a507412b120f6ede61f62295b1a7b2ff19d3dcc8f7253e51663470c888e'
const INV_AMOUNTLESS = 'lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq8rkx3yf5tcsyz3d73gafnh3cax9rn449d9p5uxz9ezhhypd0elx87sjle52x86fux2ypatgddc6k63n7erqz25le42c4u4ecky03ylcqca784w'

/** The real preimage for INV_1000: sha256(0xaa * 32) is that invoice's hash. */
const PREIMAGE = 'aa'.repeat(32)
/** A valid-looking preimage that is not the invoice's, for false-positive tests. */
const WRONG_PREIMAGE = 'bb'.repeat(32)

let dir: string
let store: LnurlcashNoteStore

/** A store with no init(): no keychain access, plaintext temp file. */
function freshStore(): LnurlcashNoteStore {
  return new LnurlcashNoteStore(join(dir, `notes-${Math.random().toString(36).slice(2)}.json`))
}

function addNote(s: LnurlcashNoteStore, secret: string, amountMsat: number): void {
  s.add({ secret, mint: MINT, amountMsat, state: 'live', addedAt: new Date().toISOString() })
}

interface Handlers {
  withdraw?: (secret: string) => unknown
  callback?: (params: URLSearchParams) => unknown
  verify?: () => unknown
}

/** Routes /w, /w/cb and /verify/* to handlers, and records every URL seen. */
function fakeFetch(handlers: Handlers) {
  const seen: string[] = []
  const impl = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    seen.push(url.href)
    let body: unknown
    if (url.pathname === '/w') {
      body = handlers.withdraw?.(url.searchParams.get('k1') ?? '') ?? {
        tag: 'withdrawRequest', callback: `${MINT}/w/cb`, k1: url.searchParams.get('k1'),
        minWithdrawable: 0, maxWithdrawable: 0,
      }
    } else if (url.pathname === '/w/cb') {
      body = handlers.callback?.(url.searchParams) ?? { status: 'OK' }
    } else if (url.pathname.startsWith('/verify/')) {
      body = handlers.verify?.() ?? { status: 'OK', settled: false }
    } else {
      body = { status: 'ERROR', reason: 'unexpected route' }
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  return { impl: impl as unknown as typeof fetch, seen }
}

function wallet(s: LnurlcashNoteStore, fetchImpl: typeof fetch) {
  return createLnurlcashWallet(s, { fetchImpl, meltPollMs: 1, meltTimeoutMs: 200 })
}

/** A mint that honours `secret` for `amountMsat`. */
function withdrawFor(map: Record<string, number>) {
  return (secret: string) =>
    secret in map
      ? { tag: 'withdrawRequest', callback: `${MINT}/w/cb`, k1: secret, minWithdrawable: 0, maxWithdrawable: map[secret] }
      : { status: 'ERROR', reason: 'Unknown or already spent note.' }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lnurlcash-'))
  store = freshStore()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('createLnurlcashWallet', () => {
  it('is unavailable with no notes and available once funded', () => {
    const { impl } = fakeFetch({})
    const w = wallet(store, impl)
    expect(w.available).toBe(false)
    addNote(store, 'ab'.repeat(32), 5000)
    expect(w.available).toBe(true)
  })

  it('refuses an undecodable invoice without contacting the mint', async () => {
    const { impl, seen } = fakeFetch({})
    addNote(store, 'ab'.repeat(32), 5000)
    const res = await wallet(store, impl).payInvoice('not-an-invoice')
    expect(res.paid).toBe(false)
    expect(res.reason).toMatch(/Invalid BOLT-11/)
    expect(seen).toHaveLength(0)
  })

  it('refuses an amountless invoice', async () => {
    const { impl } = fakeFetch({})
    addNote(store, 'ab'.repeat(32), 5000)
    const res = await wallet(store, impl).payInvoice(INV_AMOUNTLESS)
    expect(res.paid).toBe(false)
    expect(res.reason).toMatch(/Amountless/)
  })

  it('reports the shortfall when no note is large enough', async () => {
    const { impl } = fakeFetch({})
    addNote(store, 'ab'.repeat(32), 500)
    const res = await wallet(store, impl).payInvoice(INV_1000)
    expect(res.paid).toBe(false)
    expect(res.reason).toMatch(/No note large enough: need 1000 msat, largest available is 500 msat/)
  })

  it('melts an exact-value note directly, without splitting', async () => {
    const secret = 'ab'.repeat(32)
    addNote(store, secret, 1000)
    const { impl, seen } = fakeFetch({
      withdraw: withdrawFor({ [secret]: 1000 }),
      callback: () => ({ status: 'OK', verify: `${MINT}/verify/${HASH_1000}` }),
      verify: () => ({ status: 'OK', settled: true, preimage: PREIMAGE, pr: INV_1000 }),
    })

    const res = await wallet(store, impl).payInvoice(INV_1000)

    expect(res).toMatchObject({ paid: true, method: 'lnurlcash', preimage: PREIMAGE })
    expect(seen.filter(u => u.includes('amount='))).toHaveLength(0)
    expect(store.find(secret)).toBeUndefined()
  })

  it('refuses to call a melt paid when the preimage does not match the invoice', async () => {
    const secret = 'ab'.repeat(32)
    addNote(store, secret, 1000)
    const { impl } = fakeFetch({
      withdraw: withdrawFor({ [secret]: 1000 }),
      callback: () => ({ status: 'OK', verify: `${MINT}/verify/${HASH_1000}` }),
      verify: () => ({ status: 'OK', settled: true, preimage: WRONG_PREIMAGE, pr: INV_1000 }),
    })

    const res = await wallet(store, impl).payInvoice(INV_1000)

    expect(res.paid).toBe(false)
    expect(res.outcome).toBe('unknown')
    expect(res.reason).toMatch(/no verifiable preimage/)
    // Settled per the mint, so the note is gone either way.
    expect(store.find(secret)).toBeUndefined()
  })

  it('splits a larger note and persists both secrets BEFORE the split request', async () => {
    const parent = 'ab'.repeat(32)
    addNote(store, parent, 5000)

    let seenAtSplit: string[] = []
    const { impl } = fakeFetch({
      withdraw: withdrawFor({ [parent]: 5000 }),
      callback: (params) => {
        if (params.has('amount')) {
          // Crash safety: both children must already be on disk at this point,
          // keyed by the hashes the mint is being told about.
          seenAtSplit = store.byState('provisional').map(n => computePaymentHash(n.secret))
          return { status: 'OK' }
        }
        return { status: 'OK', verify: `${MINT}/verify/${HASH_1000}` }
      },
      verify: () => ({ status: 'OK', settled: true, preimage: PREIMAGE }),
    })

    await wallet(store, impl).payInvoice(INV_1000)

    expect(seenAtSplit).toHaveLength(2)
  })

  it('sends h and h2 matching the persisted child secrets', async () => {
    const parent = 'ab'.repeat(32)
    addNote(store, parent, 5000)

    let split: URLSearchParams | undefined
    let childHashes: string[] = []
    const { impl } = fakeFetch({
      withdraw: withdrawFor({ [parent]: 5000 }),
      callback: (params) => {
        if (params.has('amount')) {
          split = new URLSearchParams(params)
          childHashes = store.byState('provisional').map(n => computePaymentHash(n.secret))
          return { status: 'OK' }
        }
        return { status: 'OK', verify: `${MINT}/verify/${HASH_1000}` }
      },
    })

    await wallet(store, impl).payInvoice(INV_1000)

    expect(split?.get('amount')).toBe('1000')
    expect(childHashes).toContain(split?.get('h'))
    expect(childHashes).toContain(split?.get('h2'))
    expect(split?.get('h')).not.toBe(split?.get('h2'))
  })

  it('drops both children and keeps the parent when the mint refuses the split', async () => {
    const parent = 'ab'.repeat(32)
    addNote(store, parent, 5000)
    const { impl } = fakeFetch({
      withdraw: withdrawFor({ [parent]: 5000 }),
      callback: (params) => params.has('amount')
        ? { status: 'ERROR', reason: 'insufficient value' }
        : { status: 'OK' },
    })

    const res = await wallet(store, impl).payInvoice(INV_1000)

    expect(res.paid).toBe(false)
    expect(res.reason).toMatch(/insufficient value/)
    expect(store.byState('provisional')).toHaveLength(0)
    expect(store.find(parent)?.state).toBe('live')
  })

  it('restores the note when the mint refuses the melt outright', async () => {
    const secret = 'ab'.repeat(32)
    addNote(store, secret, 1000)
    const { impl } = fakeFetch({
      withdraw: withdrawFor({ [secret]: 1000 }),
      callback: () => ({ status: 'ERROR', reason: 'pending' }),
    })

    const res = await wallet(store, impl).payInvoice(INV_1000)

    expect(res.paid).toBe(false)
    expect(res.reason).toMatch(/pending/)
    expect(store.find(secret)?.state).toBe('live')
  })

  it('holds the note pending, not live, when a melt never settles', async () => {
    const secret = 'ab'.repeat(32)
    addNote(store, secret, 1000)
    const { impl } = fakeFetch({
      withdraw: withdrawFor({ [secret]: 1000 }),
      callback: () => ({ status: 'OK', verify: `${MINT}/verify/${HASH_1000}` }),
      verify: () => ({ status: 'OK', settled: false }),
    })

    const res = await wallet(store, impl).payInvoice(INV_1000)

    expect(res.paid).toBe(false)
    expect(res.outcome).toBe('unknown')
    expect(store.find(secret)?.state).toBe('melting')
    expect(store.totalBalanceMsat()).toBe(0)
  })

  it('reports unknown, not failure, when the mint offers no verify URL', async () => {
    const secret = 'ab'.repeat(32)
    addNote(store, secret, 1000)
    const { impl } = fakeFetch({
      withdraw: withdrawFor({ [secret]: 1000 }),
      callback: () => ({ status: 'OK' }),
    })

    const res = await wallet(store, impl).payInvoice(INV_1000)
    expect(res.outcome).toBe('unknown')
    expect(res.reason).toMatch(/cannot be proven/)
  })

  it('restores a melting note the mint still honours, and drops one it does not', async () => {
    // Both too small to pay INV_1000, so reconciliation is all that happens.
    const restored = 'ab'.repeat(32)
    const burned = 'cd'.repeat(32)
    store.add({ secret: restored, mint: MINT, amountMsat: 500, state: 'melting', addedAt: 'x' })
    store.add({ secret: burned, mint: MINT, amountMsat: 500, state: 'melting', addedAt: 'x' })

    const { impl } = fakeFetch({ withdraw: withdrawFor({ [restored]: 500 }) })

    await wallet(store, impl).payInvoice(INV_1000)

    expect(store.find(burned)).toBeUndefined()
    expect(store.find(restored)?.state).toBe('live')
    expect(store.totalBalanceMsat()).toBe(500)
  })

  it('drops a provisional note whose split never landed', async () => {
    const orphan = 'ab'.repeat(32)
    store.add({ secret: orphan, mint: MINT, amountMsat: 0, state: 'provisional', parent: 'ef'.repeat(32), addedAt: 'x' })
    const { impl } = fakeFetch({ withdraw: withdrawFor({}) })

    await wallet(store, impl).payInvoice(INV_1000)

    expect(store.find(orphan)).toBeUndefined()
  })

  it('never leaks a note secret in a failure reason', async () => {
    const secret = 'ab'.repeat(32)
    addNote(store, secret, 5000)
    const { impl } = fakeFetch({
      withdraw: withdrawFor({ [secret]: 5000 }),
      callback: () => { throw new Error(`network failure for ${MINT}/w/cb?k1=${secret}`) },
    })

    const res = await wallet(store, impl).payInvoice(INV_1000)

    expect(res.paid).toBe(false)
    expect(JSON.stringify(res)).not.toContain(secret)
  })

  it('serialises concurrent payments so one note is not spent twice', async () => {
    const secret = 'ab'.repeat(32)
    addNote(store, secret, 1000)
    let callbacks = 0
    const { impl } = fakeFetch({
      withdraw: withdrawFor({ [secret]: 1000 }),
      callback: () => { callbacks++; return { status: 'OK', verify: `${MINT}/verify/${HASH_1000}` } },
      verify: () => ({ status: 'OK', settled: true, preimage: PREIMAGE }),
    })

    const w = wallet(store, impl)
    const [a, b] = await Promise.all([w.payInvoice(INV_1000), w.payInvoice(INV_1000)])

    // Exactly one melt reaches the mint; the second finds the note already
    // gone rather than racing it into a double spend.
    expect(callbacks).toBe(1)
    expect([a.paid, b.paid].filter(Boolean)).toHaveLength(1)
    expect([a.reason, b.reason].some(r => /No note large enough/.test(r ?? ''))).toBe(true)
  })
})
