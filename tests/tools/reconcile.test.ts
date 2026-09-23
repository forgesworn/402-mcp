import { describe, it, expect, vi } from 'vitest'
import { handleReconcile, type ReconcileDeps } from '../../src/tools/reconcile.js'
import type { PendingPayment } from '../../src/store/pending-payments.js'

const PREIMAGE = 'aa'.repeat(32)
const HASH = 'e0e77a507412b120f6ede61f62295b1a7b2ff19d3dcc8f7253e51663470c888e'

function entry(overrides: Partial<PendingPayment> = {}): PendingPayment {
  return {
    paymentHash: HASH,
    origins: ['https://api.example.com'],
    invoice: 'lnbc10n1...',
    costSats: 1,
    protocol: 'l402',
    method: 'nwc',
    macaroon: 'bWFjMQ==',
    createdAt: '2026-09-23T00:00:00Z',
    ...overrides,
  }
}

function makeDeps(pending: PendingPayment | undefined, overrides: Partial<ReconcileDeps> = {}): ReconcileDeps {
  const entries = new Map(pending ? [[pending.paymentHash, pending]] : [])
  return {
    pendingPayments: {
      get: vi.fn((h: string) => entries.get(h)),
      remove: vi.fn((h: string) => entries.delete(h)),
      list: vi.fn(() => [...entries.values()]),
    },
    lookupPayment: vi.fn().mockResolvedValue({ state: 'pending', reason: 'Still in flight.' }),
    storeCredential: vi.fn().mockReturnValue(true),
    confirmWithHuman: vi.fn().mockResolvedValue('unsupported'),
    ...overrides,
  }
}

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

describe('handleReconcile', () => {
  it('lists unresolved payments when called without a hash', async () => {
    const deps = makeDeps(entry())
    const parsed = parse(await handleReconcile({}, deps))
    expect(parsed.unresolved).toEqual([expect.objectContaining({ paymentHash: HASH, costSats: 1 })])
    expect(JSON.stringify(parsed)).not.toContain('bWFjMQ==')
  })

  it('clears a settled payment and stores its credential', async () => {
    const deps = makeDeps(entry(), { lookupPayment: vi.fn().mockResolvedValue({ state: 'settled', preimage: PREIMAGE }) })
    const result = await handleReconcile({ paymentHash: HASH }, deps)
    expect(parse(result)).toMatchObject({ resolved: true, state: 'settled', credentialsStored: true })
    expect(deps.storeCredential).toHaveBeenCalledWith('https://api.example.com', 'bWFjMQ==', PREIMAGE, HASH, null)
    expect(deps.pendingPayments.remove).toHaveBeenCalledWith(HASH)
    expect(result.content[0].text).not.toContain(PREIMAGE)
  })

  it('does not clear a settlement whose preimage does not match', async () => {
    const deps = makeDeps(entry(), { lookupPayment: vi.fn().mockResolvedValue({ state: 'settled', preimage: 'bb'.repeat(32) }) })
    const result = await handleReconcile({ paymentHash: HASH }, deps)
    expect(result.isError).toBe(true)
    expect(deps.pendingPayments.remove).not.toHaveBeenCalled()
  })

  it('clears a definitely failed payment without storing anything', async () => {
    const deps = makeDeps(entry(), { lookupPayment: vi.fn().mockResolvedValue({ state: 'failed' }) })
    expect(parse(await handleReconcile({ paymentHash: HASH }, deps))).toMatchObject({ resolved: true, state: 'failed' })
    expect(deps.storeCredential).not.toHaveBeenCalled()
    expect(deps.pendingPayments.remove).toHaveBeenCalledWith(HASH)
  })

  it('keeps a pending payment in place', async () => {
    const deps = makeDeps(entry())
    const result = await handleReconcile({ paymentHash: HASH }, deps)
    expect(result.isError).toBe(true)
    expect(parse(result)).toMatchObject({ resolved: false, state: 'pending' })
    expect(deps.pendingPayments.remove).not.toHaveBeenCalled()
  })

  it('accepts a preimage from the human only if it hashes to the payment hash', async () => {
    const deps = makeDeps(entry())
    expect((await handleReconcile({ paymentHash: HASH, preimage: 'bb'.repeat(32) }, deps)).isError).toBe(true)
    expect(parse(await handleReconcile({ paymentHash: HASH, preimage: PREIMAGE }, deps))).toMatchObject({ state: 'settled' })
    expect(deps.lookupPayment).not.toHaveBeenCalled()
  })

  it('abandons only with the human approval of the client, never the agent alone', async () => {
    const refused = makeDeps(entry())
    expect((await handleReconcile({ paymentHash: HASH, abandon: true }, refused)).isError).toBe(true)
    expect(refused.pendingPayments.remove).not.toHaveBeenCalled()

    const approved = makeDeps(entry(), { confirmWithHuman: vi.fn().mockResolvedValue('accepted') })
    expect(parse(await handleReconcile({ paymentHash: HASH, abandon: true }, approved))).toMatchObject({ state: 'abandoned' })
    expect(approved.pendingPayments.remove).toHaveBeenCalledWith(HASH)
  })
})
