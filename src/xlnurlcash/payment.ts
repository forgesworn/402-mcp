import type { LnurlcashNoteStore } from '../store/lnurlcash-notes.js'
import { createNoteOps, noteUrl, NoteGone, type NoteOps, type NoteOpsOptions } from '../wallet/lnurlcash-ops.js'
import type { LnurlcashChallenge } from './parse.js'

export interface LnurlcashPaymentResult {
  /** The bearer note URL to send in the X-LNURLcash header. */
  header: string
  /** Amount in sats the note covers. */
  amountSats: number
  /**
   * Records what the paywall did with the note. `true` means it granted
   * access, so it rotated the note and our secret is dead. `false` leaves the
   * note held pending: only the mint can say whether it was rotated, and the
   * next lnurlcash operation asks.
   */
  settle: (accepted: boolean) => void
}

/**
 * Mints arrive as bare hosts (`mint.example.com`), origins, or full discovery
 * URLs. Compared on host so all three forms match a stored note's origin.
 */
export function mintHost(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed.replace(/^lnurlw:\/\//i, 'https://')
    : `https://${trimmed}`
  try {
    const host = new URL(withScheme).host
    return host.length > 0 ? host.toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * Builds a bearer-note payment for an lnurlcash challenge: an exact-value note
 * from an accepted mint, or one split at the mint to the exact price so the
 * paywall is never overpaid and the change stays in the store. Returns null
 * when no note can cover it, so the caller falls through to another rail.
 *
 * The chosen note is held pending before it is returned. Handing a bearer note
 * to a server puts it beyond our control: the server settles by rotating it,
 * and only the mint knows whether that happened.
 */
export async function attemptLnurlcashPayment(opts: {
  challenge: LnurlcashChallenge
  noteStore: LnurlcashNoteStore
  ops?: NoteOps
  options?: NoteOpsOptions
}): Promise<LnurlcashPaymentResult | null> {
  const { challenge, noteStore } = opts
  const ops = opts.ops ?? createNoteOps(noteStore, opts.options ?? {})

  const accepted = new Set(
    challenge.mints.map(mintHost).filter((h): h is string => h !== null),
  )
  if (accepted.size === 0) return null

  const needMsat = challenge.amount * 1000

  try {
    await ops.reconcile()
  } catch { /* best effort; selection below simply sees fewer notes */ }

  const live = noteStore.live().filter(n => {
    const host = mintHost(n.mint)
    return host !== null && accepted.has(host)
  })

  // Exact-value notes first: handing one over avoids a split round trip
  // entirely. Then the smallest note that covers the price, so large notes
  // stay whole.
  const candidates = [
    ...live.filter(n => n.amountMsat === needMsat),
    ...live.filter(n => n.amountMsat > needMsat).sort((a, b) => a.amountMsat - b.amountMsat),
  ]

  for (const candidate of candidates) {
    // The stored value is a cache. Only the mint knows what a note is worth
    // now, and a bearer note anyone else holds a copy of may already be spent,
    // so it is confirmed before it is handed over.
    const probe = await ops.probeNote(candidate.mint, candidate.secret)
    if (!probe.ok) {
      // A mint that refuses the note has retired it: drop it and try the next.
      // A mint that cannot be reached has said nothing, so nothing is dropped
      // and no further note is risked against it.
      if (probe.reason === 'unreachable') return null
      noteStore.remove(candidate.secret)
      continue
    }

    if (probe.note.amountMsat !== candidate.amountMsat) {
      noteStore.setAmount(candidate.secret, probe.note.amountMsat)
    }
    if (probe.note.amountMsat < needMsat) continue

    const current = noteStore.find(candidate.secret)
    if (!current) continue

    let exact
    try {
      exact = probe.note.amountMsat === needMsat
        ? current
        : await ops.split(current, needMsat)
    } catch (error) {
      // A note the mint no longer recognises is normal for a bearer asset:
      // drop it and try the next. Anything else means the mint is refusing or
      // unreachable, so stop rather than burn more notes against it.
      if (error instanceof NoteGone) continue
      return null
    }

    noteStore.setState(exact.secret, 'melting')
    const secret = exact.secret

    return {
      header: noteUrl(exact),
      amountSats: challenge.amount,
      settle(granted: boolean) {
        if (granted) noteStore.remove(secret)
      },
    }
  }

  return null
}
