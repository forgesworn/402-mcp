import { tryDecodeBolt11, verifyPreimage } from 'farrier-kit'
import type { WalletProvider, PaymentResult, PayInvoiceOptions } from './types.js'
import type { CashuTokenStore } from '../store/cashu-tokens.js'

type Proof = { id: string; amount: number; secret: string; C: string }

const UNKNOWN_REASON = 'Call l402-reconcile with this payment hash before paying this service again.'

async function doPayInvoice(invoice: string, tokenStore: CashuTokenStore, _options?: PayInvoiceOptions): Promise<PaymentResult> {
  // The payment hash is what proves settlement later, so an invoice that
  // cannot be decoded is refused before any token leaves the store.
  const invoiceDecoded = tryDecodeBolt11(invoice)
  if (!invoiceDecoded) {
    return { paid: false, method: 'cashu', reason: 'Invalid BOLT-11 invoice' }
  }
  const paymentHash = invoiceDecoded.paymentHashHex

  const token = tokenStore.consumeFirst()
  if (!token) {
    return { paid: false, method: 'cashu', reason: 'No Cashu tokens available' }
  }

  // Track whether wallet.send() has completed so the catch block knows
  // whether to restore original token or the swapped proofs.
  let sendProofs: {
    proofsToSend: Proof[]
    proofsToKeep: Proof[]
    getEncodedTokenV4: (token: { mint: string; proofs: Proof[] }) => string
    quoteId: string
  } | undefined

  try {
    const { Wallet, getDecodedToken, getEncodedTokenV4 } = await import('@cashu/cashu-ts')

    // Decode the token to get proofs ({ mint, proofs, unit })
    const decoded = getDecodedToken(token.token)
    const wallet = new Wallet(token.mint, { unit: decoded.unit ?? 'sat' })
    const proofs = decoded.proofs ?? []

    // Create melt quote to determine required amount including fee reserve
    const meltQuote = await wallet.createMeltQuote(invoice)
    const amountNeeded = meltQuote.amount + meltQuote.fee_reserve

    // Check if we have enough value in proofs
    const proofsTotal = proofs.reduce((sum: number, p: { amount: number }) => sum + p.amount, 0)
    if (proofsTotal < amountNeeded) {
      tokenStore.add(token)
      return {
        paid: false,
        method: 'cashu',
        reason: `Token value (${proofsTotal} sats) insufficient for invoice (${meltQuote.amount} sats + ${meltQuote.fee_reserve} fee reserve)`,
      }
    }

    // Use wallet.send() to select proofs properly, accounting for fees
    const { send: proofsToSend, keep: proofsToKeep } = await wallet.send(amountNeeded, proofs, {
      includeFees: true,
    })

    // After send() succeeds, the original token is spent on the mint.
    // From this point, only proofsToSend/proofsToKeep are valid — never
    // re-add the original token.  Track this so the catch block knows
    // whether the original or the new proofs should be restored.
    sendProofs = { proofsToSend, proofsToKeep, getEncodedTokenV4, quoteId: meltQuote.quote }

    const meltResponse = await wallet.meltProofs(meltQuote, proofsToSend)
    const state = meltResponse.quote.state

    if (state === 'PAID') {
      // The sent proofs are spent. Keep and change proofs are ours either way.
      restoreChangeProofs(tokenStore, getEncodedTokenV4, token.mint, proofsToKeep, meltResponse.change ?? [])

      // NUT-05 lets a mint report PAID with a null preimage. Without a
      // preimage that hashes to the invoice, settlement is only the mint's
      // word, and a caller told "not paid" would pay again.
      const preimage = meltResponse.quote.payment_preimage ?? undefined
      if (!preimage || !verifyPreimage(preimage, paymentHash)) {
        return {
          paid: false,
          method: 'cashu',
          outcome: 'unknown',
          reason: `The mint reported the melt as paid but returned no preimage that matches the invoice. ${UNKNOWN_REASON}`,
        }
      }
      return { paid: true, preimage, method: 'cashu' }
    }

    if (state === 'PENDING') {
      // The mint may still pay with the sent proofs, so they are neither
      // spendable nor lost. Hold them aside until reconcile rules on them.
      restoreChangeProofs(tokenStore, getEncodedTokenV4, token.mint, proofsToKeep, [])
      reserveProofs(tokenStore, getEncodedTokenV4, token.mint, proofsToSend, paymentHash, meltQuote.quote)
      return {
        paid: false,
        method: 'cashu',
        outcome: 'unknown',
        reason: `The mint reports the melt as pending. ${UNKNOWN_REASON}`,
      }
    }

    // UNPAID: the mint refused the melt, so the swapped proofs are still
    // valid. Re-add the send + keep proofs (NOT the dead original token).
    restoreChangeProofs(tokenStore, getEncodedTokenV4, token.mint, proofsToKeep, proofsToSend)
    return { paid: false, method: 'cashu', reason: 'Cashu melt failed' }
  } catch {
    if (sendProofs) {
      // send() succeeded, so the melt request may have reached the mint
      // before the error. Only the keep proofs are certainly ours; the sent
      // ones are held aside until reconcile learns what the mint did.
      console.warn('[402-mcp] Cashu melt failed after send() succeeded — melt outcome unknown, sent proofs reserved')
      restoreChangeProofs(tokenStore, sendProofs.getEncodedTokenV4, token.mint, sendProofs.proofsToKeep, [])
      reserveProofs(tokenStore, sendProofs.getEncodedTokenV4, token.mint, sendProofs.proofsToSend, paymentHash, sendProofs.quoteId)
      return {
        paid: false,
        method: 'cashu',
        outcome: 'unknown',
        reason: `The Cashu melt request failed after it may have reached the mint. ${UNKNOWN_REASON}`,
      }
    }
    // Error occurred before send() — original token is still valid
    tokenStore.add(token)
    return { paid: false, method: 'cashu', reason: 'Cashu payment failed' }
  }
}

function reserveProofs(
  tokenStore: CashuTokenStore,
  encodeFn: (token: { mint: string; proofs: Proof[] }) => string,
  mint: string,
  proofs: Proof[],
  paymentHash: string,
  quoteId: string,
): void {
  const amountSats = proofs.reduce((sum, p) => sum + p.amount, 0)
  if (amountSats <= 0) return
  try {
    const now = new Date().toISOString()
    tokenStore.reserve({ token: encodeFn({ mint, proofs }), mint, amountSats, addedAt: now, paymentHash, quoteId, reservedAt: now })
  } catch {
    console.warn('[402-mcp] Failed to reserve proofs from an unresolved melt')
  }
}

/** Creates a Cashu wallet provider that melts ecash tokens to pay Lightning invoices. */
export function createCashuWallet(
  tokenStore: CashuTokenStore,
  lock?: <T>(fn: () => Promise<T>) => Promise<T>,
): WalletProvider {
  // Use external lock if provided (shared with xcashu path), otherwise internal
  let internalLock: Promise<unknown> = Promise.resolve()
  const defaultLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = internalLock.catch(() => {}).then(() => fn())
    internalLock = result.catch(() => {})
    return result
  }
  const withLock = lock ?? defaultLock

  return {
    method: 'cashu',
    get available() {
      return tokenStore.totalBalance() > 0
    },

    payInvoice(invoice: string, options?: PayInvoiceOptions): Promise<PaymentResult> {
      return withLock(() => doPayInvoice(invoice, tokenStore, options))
    },
  }
}

/**
 * Encodes leftover proofs back into a Cashu token and adds them to the store.
 * Handles both `keep` proofs (from wallet.send() coin selection) and `change`
 * proofs (from overpaid melt fee reserves). Failures are logged but never
 * propagate; the payment has already succeeded at this point.
 */
function restoreChangeProofs(
  tokenStore: CashuTokenStore,
  encodeFn: (token: { mint: string; proofs: Proof[] }) => string,
  mint: string,
  keepProofs: Proof[],
  changeProofs: Proof[],
): void {
  const allProofs = [...keepProofs, ...changeProofs]
  if (allProofs.length === 0) return

  try {
    const totalSats = allProofs.reduce((sum, p) => sum + p.amount, 0)
    if (totalSats <= 0) return

    const encoded = encodeFn({ mint, proofs: allProofs })
    tokenStore.add({
      token: encoded,
      mint,
      amountSats: totalSats,
      addedAt: new Date().toISOString(),
    })
  } catch {
    // Payment already succeeded; log but don't fail
    // Log generic message only — err may contain proof secrets
    console.warn('[402-mcp] Failed to restore change proofs to token store')
  }
}
