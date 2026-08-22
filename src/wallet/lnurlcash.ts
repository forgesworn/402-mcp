import {
  tryDecodeBolt11,
  bolt11AmountMsats,
  verifyLud21,
  fetchJson,
} from 'farrier-kit'
import type { WalletProvider, PaymentResult, PayInvoiceOptions } from './types.js'
import type { LnurlcashNoteStore, StoredNote } from '../store/lnurlcash-notes.js'
import {
  createNoteOps,
  callbackUrl,
  isError,
  MintRefused,
  NoteGone,
  type CallbackOk,
  type LnurlError,
} from './lnurlcash-ops.js'

const METHOD = 'lnurlcash' as const

export interface LnurlcashWalletOptions {
  /** Total time to wait for a melt to settle before reporting it unknown. */
  meltTimeoutMs?: number
  /** Delay between melt verify polls. */
  meltPollMs?: number
  /** Per-request HTTP timeout. */
  httpTimeoutMs?: number
  /** SSRF guard, matching farrier-kit's verifyLud21 hook. */
  urlGuard?: (url: URL) => void | Promise<void>
  fetchImpl?: typeof fetch
}

const DEFAULTS = {
  meltTimeoutMs: 60_000,
  meltPollMs: 1_000,
  httpTimeoutMs: 8_000,
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function createLnurlcashWallet(
  store: LnurlcashNoteStore,
  options: LnurlcashWalletOptions = {},
  lock?: <T>(fn: () => Promise<T>) => Promise<T>,
): WalletProvider {
  const cfg = { ...DEFAULTS, ...options }
  const ops = createNoteOps(store, {
    httpTimeoutMs: cfg.httpTimeoutMs,
    fetchImpl: cfg.fetchImpl,
    // reconcile polls verify URLs of its own now, so the guard has to reach it
    ...(cfg.urlGuard ? { urlGuard: cfg.urlGuard } : {}),
  })

  let internalLock: Promise<unknown> = Promise.resolve()
  const defaultLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = internalLock.catch(() => {}).then(() => fn())
    internalLock = result.catch(() => {})
    return result
  }
  const withLock = lock ?? defaultLock

  const get = async <T>(url: string): Promise<T> =>
    fetchJson<T>(url, {
      timeoutMs: cfg.httpTimeoutMs,
      fetchImpl: cfg.fetchImpl,
    })

  /** Melts `note` against `invoice` and waits for cryptographic settlement proof. */
  async function melt(note: StoredNote, invoice: string, paymentHashHex: string): Promise<PaymentResult> {
    const resolved = await ops.resolveNote(note.mint, note.secret)
    if (!resolved) {
      store.remove(note.secret)
      throw new NoteGone('note not recognised by the mint')
    }

    // Held back from spending before the request: the mint marks it pending
    // immediately and a concurrent attempt would just be refused.
    store.setState(note.secret, 'melting')

    let res: CallbackOk | LnurlError
    try {
      res = await get<CallbackOk | LnurlError>(callbackUrl(resolved.callback, { k1: note.secret, pr: invoice }))
    } catch {
      return {
        paid: false,
        method: METHOD,
        outcome: 'unknown',
        reason: 'Melt outcome is unknown. The note is held pending and will be reconciled before the next payment.',
      }
    }

    if (isError(res)) {
      // Refused before any payment; the mint never marked it pending.
      store.setState(note.secret, 'live')
      return { paid: false, method: METHOD, reason: res.reason ?? 'Mint refused the melt' }
    }

    // Payment runs as a background task at the mint, so OK here means accepted,
    // not settled. Without a verify URL there is nothing to prove it with.
    if (typeof res.verify !== 'string') {
      return {
        paid: false,
        method: METHOD,
        outcome: 'unknown',
        reason: 'Mint accepted the melt but offers no LUD-21 verify URL, so settlement cannot be proven.',
      }
    }

    // Persisted before the first poll, not after the last one. A melt that
    // settles late still spends the note, and the verify URL is the only
    // route back to the preimage it bought. Keeping it in a local variable
    // meant a timeout - or a crash, or the process being killed - threw the
    // credential away while the sats were already gone.
    store.setMeltProof(note.secret, res.verify, paymentHashHex)

    const deadline = Date.now() + cfg.meltTimeoutMs
    for (;;) {
      let result
      try {
        result = await verifyLud21({
          verifyUrl: res.verify,
          paymentHashHex,
          fetchImpl: cfg.fetchImpl,
          timeoutMs: cfg.httpTimeoutMs,
          urlGuard: cfg.urlGuard,
        })
      } catch {
        result = undefined
      }

      if (result?.settled) {
        if (result.verified && result.preimage) {
          // Recorded before the note goes, so a crash between the two lines
          // cannot lose what the payment bought.
          store.recordSettledMelt({
            paymentHashHex,
            preimage: result.preimage,
            amountMsat: note.amountMsat,
            mint: note.mint,
            settledAt: new Date().toISOString(),
          })
          store.remove(note.secret)
          return { paid: true, preimage: result.preimage, method: METHOD }
        }
        store.remove(note.secret)
        // Settled per the mint, but unproven. Same stance as the NWC provider:
        // the note is spent either way, so it must not go back in the store.
        return {
          paid: false,
          method: METHOD,
          outcome: 'unknown',
          reason: 'Mint reported the melt settled but returned no verifiable preimage.',
        }
      }

      if (Date.now() >= deadline) {
        return {
          paid: false,
          method: METHOD,
          outcome: 'unknown',
          verifyUrl: res.verify,
          reason:
            'Melt did not settle before the timeout. The note is held with its verify URL, so a later reconcile can still recover the preimage if the payment lands.',
        }
      }
      await sleep(cfg.meltPollMs)
    }
  }

  async function doPayInvoice(invoice: string, _options?: PayInvoiceOptions): Promise<PaymentResult> {
    const decoded = tryDecodeBolt11(invoice)
    if (!decoded) {
      return { paid: false, method: METHOD, reason: 'Invalid BOLT-11 invoice' }
    }
    // Normalised to a number, and null past MAX_SAFE_INTEGER as well as for an
    // amountless invoice — both are amounts this provider must not act on.
    const needMsat = bolt11AmountMsats(invoice)
    if (needMsat === null) {
      return { paid: false, method: METHOD, reason: 'Amountless BOLT-11 invoices require an explicit amount and are refused' }
    }

    // A reconcile can turn up a payment that landed after an earlier attempt
    // gave up on it. That preimage is a credential somebody paid for, so it
    // is said out loud here rather than only filed: the caller is a wallet
    // asking to spend, and "by the way, that payment you wrote off did go
    // through" changes what they do next.
    let recoveredNote = ''
    try {
      const report = await ops.reconcile()
      if (report.recovered.length > 0) {
        const each = report.recovered
          .map(m => `${m.paymentHashHex.slice(0, 12)}… preimage ${m.preimage}`)
          .join('; ')
        recoveredNote = ` Also recovered ${report.recovered.length} earlier melt(s) that settled after being written off: ${each}.`
      }
    } catch { /* best effort; selection below simply sees fewer notes */ }

    const live = store.live()

    // Exact-value notes first: melting one directly avoids a split and its base
    // fee. Then the smallest note that covers the amount, so large notes stay
    // whole. Notes the mint no longer recognises are dropped as they are found
    // and the next candidate is tried, since a stale local balance is normal
    // for a bearer asset that someone else may already have spent.
    const candidates = [
      ...live.filter(n => n.amountMsat === needMsat),
      ...live.filter(n => n.amountMsat > needMsat).sort((a, b) => a.amountMsat - b.amountMsat),
    ]

    let gone = 0
    for (const candidate of candidates) {
      try {
        const exact = candidate.amountMsat === needMsat
          ? candidate
          : await ops.split(candidate, needMsat)
        const result = await melt(exact, invoice, decoded.paymentHashHex)
        return recoveredNote
          ? { ...result, reason: `${result.reason ?? 'Paid.'}${recoveredNote}` }
          : result
      } catch (error) {
        if (error instanceof NoteGone) { gone++; continue }
        return {
          paid: false,
          method: METHOD,
          reason: error instanceof MintRefused ? error.message : 'Could not split a note to the invoice amount',
        }
      }
    }

    const best = store.live().reduce((max, n) => Math.max(max, n.amountMsat), 0)
    const staleNote = gone > 0 ? ` (${gone} stored note(s) had already been spent elsewhere and were dropped)` : ''
    return {
      paid: false,
      method: METHOD,
      reason: `No note large enough: need ${needMsat} msat, largest available is ${best} msat${staleNote}${recoveredNote}`,
    }
  }

  return {
    method: METHOD,
    get available() {
      return store.totalBalanceMsat() > 0
    },
    payInvoice(invoice: string, options?: PayInvoiceOptions): Promise<PaymentResult> {
      return withLock(() => doPayInvoice(invoice, options))
    },
  }
}
