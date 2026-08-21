import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computePaymentHash } from 'farrier-kit'
import { attemptLnurlcashPayment, mintHost } from '../../src/xlnurlcash/payment.js'
import type { LnurlcashChallenge } from '../../src/xlnurlcash/parse.js'
import { LnurlcashNoteStore } from '../../src/store/lnurlcash-notes.js'

const MINT = 'https://mint.example.com'

let dir: string
let store: LnurlcashNoteStore

/** A store with no init(): no keychain access, plaintext temp file. */
function freshStore(): LnurlcashNoteStore {
  return new LnurlcashNoteStore(join(dir, `notes-${Math.random().toString(36).slice(2)}.json`))
}

function addNote(s: LnurlcashNoteStore, secret: string, amountMsat: number, mint = MINT): void {
  s.add({ secret, mint, amountMsat, state: 'live', addedAt: new Date().toISOString() })
}

/**
 * Stateful mock mint keyed by note hash, exactly as the real one is: it only
 * ever sees `h`/`h2`, never the secrets behind them. A split's children do not
 * exist until the payment path generates them, so a hash-keyed mock is the
 * only way to test that path.
 */
function mockMint(initial: Record<string, number>, baseFeeMsat = 1000) {
  const byHash = new Map<string, number>()
  for (const [secret, amount] of Object.entries(initial)) byHash.set(computePaymentHash(secret), amount)
  const seen: string[] = []

  const impl = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    seen.push(url.href)
    let body: unknown

    if (url.pathname === '/w') {
      const secret = url.searchParams.get('k1') ?? ''
      const amount = byHash.get(computePaymentHash(secret))
      body = amount === undefined
        ? { status: 'ERROR', reason: 'Unknown or already spent note.' }
        : { tag: 'withdrawRequest', callback: `${MINT}/w/cb`, k1: secret, minWithdrawable: 0, maxWithdrawable: amount }
    } else if (url.pathname === '/w/cb') {
      const hash = computePaymentHash(url.searchParams.get('k1') ?? '')
      const total = byHash.get(hash)
      if (total === undefined) {
        body = { status: 'ERROR', reason: 'Unknown or already spent note.' }
      } else {
        const want = Number(url.searchParams.get('amount'))
        const change = total - want - baseFeeMsat
        if (change < 1) {
          body = { status: 'ERROR', reason: 'insufficient value' }
        } else {
          byHash.delete(hash)
          byHash.set(url.searchParams.get('h')!, want)
          byHash.set(url.searchParams.get('h2')!, change)
          body = { status: 'OK' }
        }
      }
    } else {
      body = { status: 'ERROR', reason: 'unexpected route' }
    }

    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })

  return {
    impl: impl as unknown as typeof fetch,
    seen,
    balanceOf: (secret: string) => byHash.get(computePaymentHash(secret)),
    /** Burns a note the way a paywall's rotate does. */
    burn: (secret: string) => byHash.delete(computePaymentHash(secret)),
  }
}

function challengeFor(amount: number, mints: string[] = [MINT]): LnurlcashChallenge {
  return { amount, unit: 'sat', mints }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xlnurlcash-'))
  store = freshStore()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('mintHost', () => {
  it('accepts a bare host', () => {
    expect(mintHost('mint.example.com')).toBe('mint.example.com')
  })

  it('accepts an origin and a full URL alike', () => {
    expect(mintHost('https://mint.example.com')).toBe('mint.example.com')
    expect(mintHost('https://mint.example.com/.well-known/lnurlp/mint')).toBe('mint.example.com')
  })

  it('keeps the port, so two mints on one host stay distinct', () => {
    expect(mintHost('127.0.0.1:8899')).toBe('127.0.0.1:8899')
    expect(mintHost('http://127.0.0.1:8899')).toBe('127.0.0.1:8899')
  })

  it('accepts the LUD-17 withdraw scheme', () => {
    expect(mintHost('lnurlw://mint.example.com')).toBe('mint.example.com')
  })

  it('lowercases the host so comparison is case-insensitive', () => {
    expect(mintHost('MINT.Example.COM')).toBe('mint.example.com')
  })

  it('returns null for junk', () => {
    expect(mintHost('')).toBeNull()
    expect(mintHost('   ')).toBeNull()
    expect(mintHost('https://')).toBeNull()
  })
})

describe('attemptLnurlcashPayment', () => {
  it('hands over an exact-value note without splitting', async () => {
    const secret = 'ab'.repeat(32)
    addNote(store, secret, 5000)
    const mint = mockMint({ [secret]: 5000 })

    const result = await attemptLnurlcashPayment({
      challenge: challengeFor(5),
      noteStore: store,
      options: { fetchImpl: mint.impl },
    })

    expect(result).not.toBeNull()
    expect(result!.amountSats).toBe(5)
    const url = new URL(result!.header)
    expect(url.origin + url.pathname).toBe(`${MINT}/w`)
    expect(url.searchParams.get('k1')).toBe(secret)
    expect(url.searchParams.get('amount')).toBe('5000')
    expect(mint.seen.filter(u => u.includes('h2='))).toHaveLength(0)
  })

  it('holds the note pending, so nothing else can spend it while the paywall has it', async () => {
    const secret = 'ab'.repeat(32)
    addNote(store, secret, 5000)
    const mint = mockMint({ [secret]: 5000 })

    await attemptLnurlcashPayment({
      challenge: challengeFor(5),
      noteStore: store,
      options: { fetchImpl: mint.impl },
    })

    expect(store.find(secret)!.state).toBe('melting')
    expect(store.live()).toHaveLength(0)
    expect(store.totalBalanceMsat()).toBe(0)
  })

  it('drops the note once the paywall grants access', async () => {
    const secret = 'ab'.repeat(32)
    addNote(store, secret, 5000)
    const mint = mockMint({ [secret]: 5000 })

    const result = await attemptLnurlcashPayment({
      challenge: challengeFor(5),
      noteStore: store,
      options: { fetchImpl: mint.impl },
    })
    result!.settle(true)

    expect(store.find(secret)).toBeUndefined()
  })

  it('keeps a refused note pending, for the mint to rule on later', async () => {
    const secret = 'ab'.repeat(32)
    addNote(store, secret, 5000)
    const mint = mockMint({ [secret]: 5000 })

    const result = await attemptLnurlcashPayment({
      challenge: challengeFor(5),
      noteStore: store,
      options: { fetchImpl: mint.impl },
    })
    result!.settle(false)

    expect(store.find(secret)!.state).toBe('melting')
  })

  it('restores a pending note the paywall never rotated on the next attempt', async () => {
    const secret = 'ab'.repeat(32)
    addNote(store, secret, 5000)
    const mint = mockMint({ [secret]: 5000 })

    const first = await attemptLnurlcashPayment({
      challenge: challengeFor(5),
      noteStore: store,
      options: { fetchImpl: mint.impl },
    })
    first!.settle(false)

    const second = await attemptLnurlcashPayment({
      challenge: challengeFor(5),
      noteStore: store,
      options: { fetchImpl: mint.impl },
    })

    expect(second).not.toBeNull()
    expect(new URL(second!.header).searchParams.get('k1')).toBe(secret)
  })

  it('forgets a pending note the paywall did rotate', async () => {
    const secret = 'ab'.repeat(32)
    addNote(store, secret, 5000)
    const mint = mockMint({ [secret]: 5000 })

    const first = await attemptLnurlcashPayment({
      challenge: challengeFor(5),
      noteStore: store,
      options: { fetchImpl: mint.impl },
    })
    first!.settle(false)
    mint.burn(secret)

    const second = await attemptLnurlcashPayment({
      challenge: challengeFor(5),
      noteStore: store,
      options: { fetchImpl: mint.impl },
    })

    expect(second).toBeNull()
    expect(store.find(secret)).toBeUndefined()
  })

  it('splits a larger note to the exact price and keeps the change', async () => {
    const parent = 'ab'.repeat(32)
    addNote(store, parent, 50_000)
    const mint = mockMint({ [parent]: 50_000 })

    const result = await attemptLnurlcashPayment({
      challenge: challengeFor(5),
      noteStore: store,
      options: { fetchImpl: mint.impl },
    })

    expect(result).not.toBeNull()
    const paid = new URL(result!.header).searchParams.get('k1')!
    expect(paid).not.toBe(parent)
    expect(mint.balanceOf(paid)).toBe(5000)
    expect(new URL(result!.header).searchParams.get('amount')).toBe('5000')

    // The parent is burned and the change is spendable, at the mint's value.
    expect(store.find(parent)).toBeUndefined()
    const change = store.live()
    expect(change).toHaveLength(1)
    expect(change[0].amountMsat).toBe(50_000 - 5000 - 1000)
  })

  it('prefers an exact note over splitting a larger one', async () => {
    const exact = 'ab'.repeat(32)
    const large = 'cd'.repeat(32)
    addNote(store, exact, 5000)
    addNote(store, large, 50_000)
    const mint = mockMint({ [exact]: 5000, [large]: 50_000 })

    const result = await attemptLnurlcashPayment({
      challenge: challengeFor(5),
      noteStore: store,
      options: { fetchImpl: mint.impl },
    })

    expect(new URL(result!.header).searchParams.get('k1')).toBe(exact)
    expect(store.find(large)!.state).toBe('live')
  })

  it('splits the smallest note that covers the price, so large notes stay whole', async () => {
    const small = 'ab'.repeat(32)
    const large = 'cd'.repeat(32)
    addNote(store, small, 20_000)
    addNote(store, large, 500_000)
    const mint = mockMint({ [small]: 20_000, [large]: 500_000 })

    await attemptLnurlcashPayment({
      challenge: challengeFor(5),
      noteStore: store,
      options: { fetchImpl: mint.impl },
    })

    expect(store.find(small)).toBeUndefined()
    expect(store.find(large)!.amountMsat).toBe(500_000)
  })

  it('accepts a mint named as a bare host in the challenge', async () => {
    const secret = 'ab'.repeat(32)
    addNote(store, secret, 5000)
    const mint = mockMint({ [secret]: 5000 })

    const result = await attemptLnurlcashPayment({
      challenge: challengeFor(5, ['mint.example.com']),
      noteStore: store,
      options: { fetchImpl: mint.impl },
    })

    expect(result).not.toBeNull()
  })

  it('ignores notes held at a mint the server does not accept', async () => {
    const secret = 'ab'.repeat(32)
    addNote(store, secret, 5000, 'https://other-mint.example')
    const mint = mockMint({ [secret]: 5000 })

    const result = await attemptLnurlcashPayment({
      challenge: challengeFor(5, ['mint.example.com']),
      noteStore: store,
      options: { fetchImpl: mint.impl },
    })

    expect(result).toBeNull()
    expect(store.find(secret)!.state).toBe('live')
  })

  it('returns null when the challenge names no usable mint', async () => {
    const secret = 'ab'.repeat(32)
    addNote(store, secret, 5000)
    const mint = mockMint({ [secret]: 5000 })

    const result = await attemptLnurlcashPayment({
      challenge: challengeFor(5, ['   ']),
      noteStore: store,
      options: { fetchImpl: mint.impl },
    })

    expect(result).toBeNull()
  })

  it('returns null when no note is large enough', async () => {
    const secret = 'ab'.repeat(32)
    addNote(store, secret, 4000)
    const mint = mockMint({ [secret]: 4000 })

    const result = await attemptLnurlcashPayment({
      challenge: challengeFor(5),
      noteStore: store,
      options: { fetchImpl: mint.impl },
    })

    expect(result).toBeNull()
    expect(store.find(secret)!.state).toBe('live')
  })

  it('drops a note already spent elsewhere and pays from the next one', async () => {
    const stale = 'ab'.repeat(32)
    const good = 'cd'.repeat(32)
    addNote(store, stale, 30_000)
    addNote(store, good, 40_000)
    // The mint has never heard of the stale note: someone else spent it.
    const mint = mockMint({ [good]: 40_000 })

    const result = await attemptLnurlcashPayment({
      challenge: challengeFor(5),
      noteStore: store,
      options: { fetchImpl: mint.impl },
    })

    expect(result).not.toBeNull()
    expect(store.find(stale)).toBeUndefined()
  })

  it('trusts the mint over the stored value and splits a note worth more than recorded', async () => {
    const secret = 'ab'.repeat(32)
    addNote(store, secret, 5000)
    // The mint says it is worth ten times what the store recorded.
    const mint = mockMint({ [secret]: 50_000 })

    const result = await attemptLnurlcashPayment({
      challenge: challengeFor(5),
      noteStore: store,
      options: { fetchImpl: mint.impl },
    })

    expect(result).not.toBeNull()
    const paid = new URL(result!.header).searchParams.get('k1')!
    expect(paid).not.toBe(secret)
    expect(mint.balanceOf(paid)).toBe(5000)
  })

  it('trusts the mint over the stored value and skips a note worth less than recorded', async () => {
    const secret = 'ab'.repeat(32)
    addNote(store, secret, 50_000)
    const mint = mockMint({ [secret]: 4000 })

    const result = await attemptLnurlcashPayment({
      challenge: challengeFor(5),
      noteStore: store,
      options: { fetchImpl: mint.impl },
    })

    expect(result).toBeNull()
    expect(store.find(secret)!.amountMsat).toBe(4000)
  })

  it('returns null when the mint is unreachable, leaving the note untouched', async () => {
    const secret = 'ab'.repeat(32)
    addNote(store, secret, 5000)
    const dead = vi.fn(async () => { throw new Error('connect ECONNREFUSED') }) as unknown as typeof fetch

    const result = await attemptLnurlcashPayment({
      challenge: challengeFor(5),
      noteStore: store,
      options: { fetchImpl: dead },
    })

    expect(result).toBeNull()
    // Only the mint can retire a note, and it did not answer.
    expect(store.find(secret)!.state).toBe('live')
  })
})
