import { generatePreimage, computePaymentHash, fetchJson } from 'farrier-kit'
import type { LnurlcashNoteStore, StoredNote } from '../store/lnurlcash-notes.js'

/**
 * Note operations shared by the wallet provider (which melts a note to pay a
 * BOLT-11 invoice) and the lnurlcash HTTP rail (which hands a note straight to
 * a paywall). Both need the same crash-safe split and the same reconciliation,
 * and two copies of that would drift.
 */

/** LUD-03/LUD-25 responses are either a success object or `{status:'ERROR'}`. */
export interface LnurlError { status: 'ERROR'; reason?: string }
export interface WithdrawRequest {
  status?: string
  tag?: string
  callback?: string
  k1?: string
  minWithdrawable?: number
  maxWithdrawable?: number
}
export interface CallbackOk { status?: string; verify?: string; pr?: string; reason?: string }

export function isError(res: unknown): res is LnurlError {
  return typeof res === 'object' && res !== null && (res as LnurlError).status === 'ERROR'
}

/**
 * Mint responses are the only thing safe to surface. Anything thrown by the
 * HTTP layer may carry a URL, and our URLs carry note secrets in the query
 * string, so exceptions are never stringified outward.
 */
export class MintRefused extends Error {}

/**
 * The mint doesn't recognise a note we thought we held. Expected, not
 * exceptional: a bearer note can be spent by anyone holding a copy, so every
 * local balance is a cache and the mint is the only authority. Signals "drop
 * this one and try the next", never "fail the payment".
 */
export class NoteGone extends Error {}

export interface NoteOpsOptions {
  /** Per-request HTTP timeout. */
  httpTimeoutMs?: number
  fetchImpl?: typeof fetch
}

export interface ResolvedNote {
  amountMsat: number
  callback: string
}

/**
 * `refused` is the mint saying it does not honour this note: unknown, already
 * spent, or pending another operation. `unreachable` is the mint saying
 * nothing at all. The difference matters because a note is only safe to drop
 * on the first: a bearer note is money, and a flaky network must never destroy
 * it.
 */
export type NoteProbe =
  | { ok: true; note: ResolvedNote }
  | { ok: false; reason: 'refused' | 'unreachable' }

export interface NoteOps {
  probeNote(mint: string, secret: string): Promise<NoteProbe>
  resolveNote(mint: string, secret: string): Promise<ResolvedNote | null>
  reconcile(): Promise<void>
  split(parent: StoredNote, amountMsat: number): Promise<StoredNote>
}

const DEFAULT_HTTP_TIMEOUT_MS = 8_000

/** Appends params to a callback URL that may already carry some. */
export function callbackUrl(base: string, params: Record<string, string>): string {
  const url = new URL(base)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return url.toString()
}

/**
 * The note as a LUD-25 withdraw URL: the secret as `k1`, its value alongside.
 * This is the form a wallet shows and the form a paywall is handed. The
 * `amount` is only a claim; the mint's `maxWithdrawable` is authoritative.
 */
export function noteUrl(note: Pick<StoredNote, 'mint' | 'secret' | 'amountMsat'>): string {
  const url = new URL('/w', note.mint)
  url.searchParams.set('k1', note.secret)
  url.searchParams.set('amount', String(note.amountMsat))
  return url.toString()
}

export function createNoteOps(store: LnurlcashNoteStore, options: NoteOpsOptions = {}): NoteOps {
  const httpTimeoutMs = options.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS

  const get = async <T>(url: string): Promise<T> =>
    fetchJson<T>(url, { timeoutMs: httpTimeoutMs, fetchImpl: options.fetchImpl })

  /** Reads a note's current value from the mint, keeping why it failed. */
  async function probeNote(mint: string, secret: string): Promise<NoteProbe> {
    let res: WithdrawRequest | LnurlError
    try {
      res = await get<WithdrawRequest | LnurlError>(callbackUrl(new URL('/w', mint).toString(), { k1: secret }))
    } catch {
      return { ok: false, reason: 'unreachable' }
    }
    if (isError(res) || typeof res.maxWithdrawable !== 'number' || typeof res.callback !== 'string') {
      return { ok: false, reason: 'refused' }
    }
    return { ok: true, note: { amountMsat: res.maxWithdrawable, callback: res.callback } }
  }

  /**
   * Reads a note's current value from the mint. `null` means the mint doesn't
   * recognise it: unknown, already spent, or pending another operation.
   */
  async function resolveNote(mint: string, secret: string): Promise<ResolvedNote | null> {
    const probe = await probeNote(mint, secret)
    return probe.ok ? probe.note : null
  }

  /**
   * Settles notes left in an indeterminate state by an earlier crash, a melt
   * whose outcome never came back, or a note handed to a paywall that may or
   * may not have rotated it. A provisional note the mint knows about means its
   * split landed; one it doesn't means the split never happened. A melting note
   * the mint still honours means the spend failed and the mint restored it.
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
   * returns the exact-value note. A melt invoice must match the note value
   * exactly and a paywall must not be overpaid, so this is how an arbitrary
   * amount gets covered.
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

  return { probeNote, resolveNote, reconcile, split }
}
