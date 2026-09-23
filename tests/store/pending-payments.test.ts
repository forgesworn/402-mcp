import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

import { PendingPaymentStore, type PendingPayment } from '../../src/store/pending-payments.js'

const entry: PendingPayment = {
  paymentHash: 'ab'.repeat(32),
  origins: ['https://api.example.com', 'http://abc.onion'],
  pubkey: 'pk1',
  invoice: 'lnbc10n1...',
  costSats: 10,
  protocol: 'l402',
  method: 'nwc',
  createdAt: '2026-09-23T00:00:00Z',
}

describe('PendingPaymentStore', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'l402-pending-test-'))
    path = join(dir, 'pending-payments.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('survives a restart', async () => {
    const store = new PendingPaymentStore(path)
    await store.init()
    store.add(entry)
    const reloaded = new PendingPaymentStore(path)
    await reloaded.init()
    expect(reloaded.get(entry.paymentHash)).toMatchObject({ costSats: 10 })
  })

  it('matches on any recorded origin or on the service pubkey', async () => {
    const store = new PendingPaymentStore(path)
    await store.init()
    store.add(entry)
    expect(store.unresolvedFor(['http://abc.onion'])).toHaveLength(1)
    expect(store.unresolvedFor(['https://other.example'], 'pk1')).toHaveLength(1)
    expect(store.unresolvedFor(['https://other.example'])).toHaveLength(0)
    store.remove(entry.paymentHash)
    expect(store.unresolvedFor(['https://api.example.com'])).toHaveLength(0)
  })

  it('refuses to start on an unreadable ledger rather than silently unblocking', async () => {
    writeFileSync(path, 'not json')
    await expect(new PendingPaymentStore(path).init()).rejects.toThrow(/unresolved-payment ledger/)
  })
})
