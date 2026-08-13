import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import type {
  NwcEvent,
  NwcFilter,
  NwcPublishResult,
  NwcSubscription,
  NwcTransport,
} from '@forgesworn/nwc-kit'
import { createNwcWallet } from '../../src/wallet/nwc.js'

const CLIENT_SECRET = '11'.repeat(32)
const SETTLED_INVOICE = 'lnbc10n1pj48ugqpp5urnh55r5z2cjpahduc0ky22mrfajluva8hxg7ujnu5txx3cv3z8qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqgp0xzz'
const AMOUNTLESS_INVOICE =
  'lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmw' +
  'wd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq8rkx3yf5tcsyz3d73gafnh3cax9rn449d9p5uxz' +
  '9ezhhypd0elx87sjle52x86fux2ypatgddc6k63n7erqz25le42c4u4ecky03ylcqca784w'

class WalletTransport implements NwcTransport {
  readonly walletSecret = generateSecretKey()
  readonly walletPubkey = getPublicKey(this.walletSecret)
  preimage = 'aa'.repeat(32)
  respond = true
  walletError: { code: string; message: string } | undefined
  #handler: ((event: NwcEvent) => void) | undefined

  get uri(): string {
    return `nostr+walletconnect://${this.walletPubkey}?relay=${encodeURIComponent('wss://wallet.example')}&secret=${CLIENT_SECRET}`
  }

  async query(): Promise<NwcEvent[]> {
    return [finalizeEvent({
      kind: 13_194,
      created_at: 1_700_000_000,
      tags: [['encryption', 'nip44_v2']],
      content: 'pay_invoice',
    }, this.walletSecret) as NwcEvent]
  }

  subscribe(
    _relays: readonly string[],
    _filter: NwcFilter,
    handlers: { onevent(event: NwcEvent): void },
  ): NwcSubscription {
    this.#handler = handlers.onevent
    return { close: () => { this.#handler = undefined } }
  }

  async publish(relays: readonly string[], request: NwcEvent): Promise<NwcPublishResult[]> {
    const conversationKey = nip44.v2.utils.getConversationKey(this.walletSecret, request.pubkey)
    const response = finalizeEvent({
      kind: 23_195,
      created_at: request.created_at + 1,
      tags: [['p', request.pubkey], ['e', request.id]],
      content: nip44.v2.encrypt(JSON.stringify({
        result_type: 'pay_invoice',
        error: this.walletError ?? null,
        ...(!this.walletError ? { result: { preimage: this.preimage } } : {}),
      }), conversationKey),
    }, this.walletSecret) as NwcEvent
    if (this.respond) queueMicrotask(() => this.#handler?.(response))
    return relays.map((relay) => ({ relay, accepted: true }))
  }

  close(): void {
    this.#handler = undefined
  }
}

describe('createNwcWallet', () => {
  it('returns a NWC wallet provider', () => {
    const transport = new WalletTransport()
    const wallet = createNwcWallet(transport.uri, { transport })
    expect(wallet).toMatchObject({ method: 'nwc', available: true })
  })

  it('reports paid only for an authenticated matching preimage', async () => {
    const transport = new WalletTransport()
    const wallet = createNwcWallet(transport.uri, { transport })
    await expect(wallet.payInvoice(SETTLED_INVOICE)).resolves.toEqual({
      paid: true,
      preimage: 'aa'.repeat(32),
      method: 'nwc',
    })
  })

  it('fails closed on malformed invoices, insecure connections, and mismatched preimages', async () => {
    const transport = new WalletTransport()
    await expect(createNwcWallet(transport.uri, { transport }).payInvoice('lnbc100n1test')).resolves.toMatchObject({
      paid: false,
      reason: 'Invalid BOLT-11 invoice',
    })
    await expect(createNwcWallet(transport.uri, { transport }).payInvoice(AMOUNTLESS_INVOICE)).resolves.toMatchObject({
      paid: false,
      reason: 'Amountless BOLT-11 invoices require an explicit amount and are refused',
    })

    const insecure = transport.uri.replace('wss%3A%2F%2F', 'ws%3A%2F%2F')
    expect(() => createNwcWallet(insecure, { transport })).toThrow('wss')

    transport.preimage = 'ff'.repeat(32)
    await expect(createNwcWallet(transport.uri, { transport }).payInvoice(SETTLED_INVOICE)).resolves.toMatchObject({
      paid: false,
      outcome: 'unknown',
      reason: expect.stringContaining('settlement could not be proven'),
    })
  })

  it('preserves an unknown outcome when the request may have executed', async () => {
    const transport = new WalletTransport()
    transport.respond = false
    const result = await createNwcWallet(transport.uri, {
      transport,
      requestTimeoutMs: 100,
    }).payInvoice(SETTLED_INVOICE)
    expect(result).toMatchObject({
      paid: false,
      method: 'nwc',
      outcome: 'unknown',
      reason: expect.stringContaining('Reconcile'),
    })
    expect(JSON.stringify(result)).not.toContain(CLIENT_SECRET)
  })

  it('surfaces a bounded wallet rejection without exposing the connection URI', async () => {
    const transport = new WalletTransport()
    transport.walletError = { code: 'RATE_LIMITED', message: 'Daily budget exhausted' }
    const result = await createNwcWallet(transport.uri, { transport }).payInvoice(SETTLED_INVOICE)
    expect(result).toEqual({ paid: false, method: 'nwc', reason: 'Daily budget exhausted' })
    expect(JSON.stringify(result)).not.toContain(CLIENT_SECRET)
  })
})
