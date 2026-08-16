import {
  tryDecodeBolt11,
  bolt11AmountMsats,
  generatePreimage,
  computePaymentHash,
  verifyLud21,
  fetchJson,
} from 'farrier-kit'
import type { WalletProvider, PaymentResult, PayInvoiceOptions } from './types.js'
import type { LnurlcashNoteStore, StoredNote } from '../store/lnurlcash-notes.js'

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

/** LUD-03/LUD-25 responses are either a success object or `{status:'ERROR'}`. */
interface LnurlError { status: 'ERROR'; reason?: string }
interface WithdrawRequest {
  status?: string
  tag?: string
  callback?: string
  k1?: string
  minWithdrawable?: number
  maxWithdrawable?: number
}
interface CallbackOk { status?: string; verify?: string; pr?: string; reason?: string }

function isError(res: unknown): res is LnurlError {
  return typeof res === 'object' && res !== null && (res as LnurlError).status === 'ERROR'
}

/**
 * Mint responses are the only thing safe to surface. Anything thrown by the
 * HTTP layer may carry a URL, and our URLs carry note secrets in the query
 * string, so exceptions are never stringified outward.
 */
class MintRefused extends Error {}

/**
 * The mint doesn't recognise a note we thought we held. Expected, not
 * exceptional: a bearer note can be spent by anyone holding a copy, so every
 * local balance is a cache and the mint is the only authority. Signals "drop
 * this one and try the next", never "fail the payment".
 */
class NoteGone extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Appends params to a callback URL that may already carry some. */
function callbackUrl(base: string, params: Record<string, string>): string {
  const url = new URL(base)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return url.toString()
}

export function createLnurlcashWallet(
  store: LnurlcashNoteStore,
  options: LnurlcashWalletOptions = {},
  lock?: <T>(fn: () => Promise<T>) => Promise<T>,
): WalletProvider {
  const cfg = { ...DEFAULTS, ...options }

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

  /**
   * Reads a note's current value from the mint. `null` means the mint doesn't
   * recognise it: unknown, already spent, or pending another operation.
   */
  async function resolveNote(mint: string, secret: string): Promise<{ amountMsat: number; callback: string } | null> {
    let res: WithdrawRequest | LnurlError
    try {
      res = await get<WithdrawRequest | LnurlError>(callbackUrl(new URL('/w', mint).toString(), { k1: secret }))
    } catch {
      return null
    }
    if (isError(res) || typeof res.maxWithdrawable !== 'number' || typeof res.callback !== 'string') return null
    return { amountMsat: res.maxWithdrawable, callback: res.callback }
  }

  /**
   * Settles notes left in an indeterminate state by an earlier crash or a melt
   * whose outcome never came back. A provisional note the mint knows about
   * means its split landed; one it doesn't means the split never happened. A
   * melting note the mint still honours means the payment failed and the mint
   * restored it.
   */
  async function reconcile(): Promise<void> {
    for (const note of [...store.byState('provisional'), ...store.byState('melting')]) {
      const resolved = await resolveNote(note.mint, note.secret)
      if (resolved) {
        store.confirm(note.secret, resolved.amountMsat)
        // A landed split burned its parent, whatever our local copy says.
        if (note.parent) store.remove(note.parent)
      } else {
        store.remove(note.secret)
      }
    }
  }

  /**
   * Splits `parent` into a note worth exactly `amountMsat` plus change, and
   * returns the exact-value note. The mint requires a melt invoice to match
   * the note value exactly, so this is how an arbitrary invoice gets paid.
   */
  async function split(parent: StoredNote, amountMsat: number): Promise<StoredNote> {
    const resolved = await resolveNote(parent.mint, parent.secret)
    if (!resolved) {
      store.remove(parent.secret)
      throw new NoteGone('note not recognised by the mint')
    }

    const paySecret = generatePreimage()
    const changeSecret = generatePreimage()
    const addedAt = new Date().toISOString()

    // Persisted BEFORE the request, deliberately. The mint keys the new notes
    // to hashes of these secrets and never learns the secrets themselves, so a
    // crash between its swap and our write would destroy the value outright.
    store.addMany([
      { secret: paySecret, mint: parent.mint, amountMsat, state: 'provisional', parent: parent.secret, addedAt },
      { secret: changeSecret, mint: parent.mint, amountMsat: 0, state: 'provisional', parent: parent.secret, addedAt },
    ])

    let res: CallbackOk | LnurlError
    try {
      res = await get<CallbackOk | LnurlError>(callbackUrl(resolved.callback, {
        k1: parent.secret,
        amount: String(amountMsat),
        h: computePaymentHash(paySecret),
        h2: computePaymentHash(changeSecret),
      }))
    } catch {
      // Outcome unknown. Leave both children provisional; reconcile() decides
      // on the next call, once the mint can be asked again.
      throw new MintRefused('Split outcome unknown; it will be reconciled on the next attempt')
    }

    if (isError(res)) {
      // A refusal is synchronous and burns nothing, so the children are dead.
      store.removeMany([paySecret, changeSecret])
      throw new MintRefused(res.reason ?? 'Mint refused the split')
    }

    store.remove(parent.secret)
    store.confirm(paySecret, amountMsat)

    const change = await resolveNote(parent.mint, changeSecret)
    if (change) store.confirm(changeSecret, change.amountMsat)
    else store.remove(changeSecret)

    return store.find(paySecret)!
  }

  /** Melts `note` against `invoice` and waits for cryptographic settlement proof. */
  async function melt(note: StoredNote, invoice: string, paymentHashHex: string): Promise<PaymentResult> {
    const resolved = await resolveNote(note.mint, note.secret)
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
        store.remove(note.secret)
        if (result.verified && result.preimage) {
          return { paid: true, preimage: result.preimage, method: METHOD }
        }
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
          reason: 'Melt did not settle before the timeout. The note is held pending and will be reconciled before the next payment.',
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

    try {
      await reconcile()
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
          : await split(candidate, needMsat)
        return await melt(exact, invoice, decoded.paymentHashHex)
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
      reason: `No note large enough: need ${needMsat} msat, largest available is ${best} msat${staleNote}`,
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
