/**
 * Live mainnet check for the LNURLcash wallet provider. SPENDS REAL MONEY.
 *
 * Skipped unless LNURLCASH_LIVE_NOTE_FILE points at a file containing one note,
 * in whatever form the wallet gave you: bech32 `LNURL1...`, an `lnurlw://` URL,
 * or a bare 64-hex secret. The note goes in a file, never an env value or CLI
 * argument, for the same reason NWC_URI_FILE does: it is a bearer credential
 * and both of those leak into shell history and the process table.
 *
 *   echo -n 'LNURL1...' > ~/.402-mcp/live-note.txt   # paste from the wallet
 *   chmod 600 ~/.402-mcp/live-note.txt
 *   LNURLCASH_LIVE_NOTE_FILE=~/.402-mcp/live-note.txt \
 *   LNURLCASH_LIVE_TARGET=https://example.com/api \
 *     npx vitest run tests/e2e/lnurlcash-live.integration.test.ts
 *
 * The mint comes from the note itself; LNURLCASH_LIVE_MINT only matters for a
 * bare-hex secret, which carries no origin.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLnurlcashWallet } from '../../src/wallet/lnurlcash.js'
import { LnurlcashNoteStore } from '../../src/store/lnurlcash-notes.js'
import { parseNote } from '../../src/wallet/lnurlcash-note.js'
import { parseL402Challenge } from '../../src/l402/parse.js'

const noteFile = process.env.LNURLCASH_LIVE_NOTE_FILE
/** An existing encrypted store to spend from, and keep the change in. */
const storeEnv = process.env.LNURLCASH_LIVE_STORE
const TARGET = process.env.LNURLCASH_LIVE_TARGET

describe.skipIf((!noteFile && !storeEnv) || !TARGET)('LNURLcash live payment', () => {
  it('pays an L402 challenge with a bearer note and gets access', async () => {
    // Either spend from a real store (change stays there) or seed a throwaway
    // one from a pasted note.
    const storePath = storeEnv ?? join(mkdtempSync(join(tmpdir(), 'lnurlcash-live-')), 'notes.json')
    const store = new LnurlcashNoteStore(storePath)
    await store.init()

    let MINT: string
    if (!storeEnv) {
      const parsed = parseNote(readFileSync(noteFile!, 'utf-8'))
      expect(parsed, 'note file must hold an LNURL, lnurlw:// URL, or 64-hex secret').toBeTruthy()
      MINT = parsed!.mint ?? process.env.LNURLCASH_LIVE_MINT ?? 'https://mint.forgesworn.dev'
      store.add({ secret: parsed!.secret, mint: MINT, amountMsat: 0, state: 'live', addedAt: new Date().toISOString() })
    } else {
      const held = store.live()
      expect(held.length, `store ${storePath} holds no live notes`).toBeGreaterThan(0)
      MINT = held[0].mint
    }
    console.log(`store: ${storePath}`)
    console.log(`mint:  ${MINT}`)

    // 1. Confirm the mint still honours each note, and record true values.
    for (const note of store.live()) {
      const wRes = await fetch(`${MINT}/w?k1=${note.secret}`).then(r => r.json()) as {
        status?: string; reason?: string; maxWithdrawable?: number
      }
      expect(wRes.status, `mint rejected a stored note: ${wRes.reason ?? ''}`).not.toBe('ERROR')
      store.setAmount(note.secret, wRes.maxWithdrawable!)
    }
    console.log(`spendable: ${store.totalBalanceMsat() / 1000} sats across ${store.live().length} note(s)`)

    // 2. Get a real 402 challenge. A free tier that refills on a short window
    // can outpace sequential requests, so drain it here rather than expecting
    // the caller to have done it.
    let challengeRes = await fetch(TARGET!)
    for (let i = 0; i < 40 && challengeRes.status !== 402; i++) {
      challengeRes = await fetch(TARGET!)
    }
    expect(challengeRes.status, 'target never returned 402; is it actually L402-gated?').toBe(402)
    const header = challengeRes.headers.get('www-authenticate')
    expect(header).toBeTruthy()
    const challenge = parseL402Challenge(header!)
    expect(challenge, 'could not parse the L402 challenge').toBeTruthy()

    // 3. Pay it from the note.
    const wallet = createLnurlcashWallet(store, { meltTimeoutMs: 120_000, meltPollMs: 2_000 })
    const result = await wallet.payInvoice(challenge!.invoice)
    console.log('payment:', { paid: result.paid, outcome: result.outcome, reason: result.reason })
    expect(result.paid, result.reason ?? 'melt did not settle').toBe(true)
    expect(result.preimage).toBeTruthy()

    // 4. Prove the gate is actually shut before claiming the credential opened
    // it. A free tier that refills on a short window returns 200 to anyone, so
    // a bare 200 after paying proves nothing on its own.
    let unauth = await fetch(TARGET!)
    for (let i = 0; i < 40 && unauth.status !== 402; i++) unauth = await fetch(TARGET!)
    expect(unauth.status, 'could not re-close the gate, so a 200 below would be meaningless').toBe(402)

    // 5. Now the same request, with the preimage as the L402 credential.
    const paid = await fetch(TARGET!, {
      headers: { authorization: `L402 ${challenge!.macaroon}:${result.preimage}` },
    })
    expect(paid.status).toBe(200)
    // Only a credentialed response carries this; a free-tier 200 does not.
    expect(paid.headers.get('x-credit-balance'), 'got 200 but no credit header, so this was the free tier, not the credential').toBeTruthy()
    console.log('credit balance after access:', paid.headers.get('x-credit-balance'))

    // 6. Change from the split stays spendable.
    console.log(`change retained: ${store.totalBalanceMsat() / 1000} sats across ${store.live().length} note(s)`)
    console.log('KEEP THIS STORE FILE, it holds the change note:', storePath)
  }, 180_000)
})
