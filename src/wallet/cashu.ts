import type { WalletProvider, PaymentResult } from './types.js'
import type { CashuTokenStore } from '../store/cashu-tokens.js'

async function doPayInvoice(invoice: string, tokenStore: CashuTokenStore): Promise<PaymentResult> {
  const token = tokenStore.consumeFirst()
  if (!token) {
    return { paid: false, method: 'cashu', reason: 'No Cashu tokens available' }
  }

  // Track whether wallet.send() has completed so the catch block knows
  // whether to restore original token or the swapped proofs.
  let sendProofs: {
    proofsToSend: Array<{ id: string; amount: number; secret: string; C: string }>
    proofsToKeep: Array<{ id: string; amount: number; secret: string; C: string }>
    getEncodedTokenV4: (token: { mint: string; proofs: Array<{ id: string; amount: number; secret: string; C: string }> }) => string
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
    sendProofs = { proofsToSend, proofsToKeep, getEncodedTokenV4 }

    const meltResponse = await wallet.meltProofs(meltQuote, proofsToSend)

    if (meltResponse.quote.state === 'PAID') {
      // Re-add any change proofs from the melt and kept proofs from send()
      // to avoid silent funds loss
      restoreChangeProofs(
        tokenStore,
        getEncodedTokenV4,
        token.mint,
        proofsToKeep,
        meltResponse.change,
      )

      return {
        paid: true,
        preimage: meltResponse.quote.payment_preimage ?? undefined,
        method: 'cashu',
      }
    } else {
      // Melt failed but send() already swapped proofs on the mint.
      // Re-add the send + keep proofs (NOT the original token which is now dead).
      restoreChangeProofs(
        tokenStore,
        getEncodedTokenV4,
        token.mint,
        proofsToKeep,
        proofsToSend,
      )
      return { paid: false, method: 'cashu', reason: 'Cashu melt failed' }
    }
  } catch {
    if (sendProofs) {
      // send() succeeded before the error — original proofs are dead on the mint.
      // Restore the new proofs instead; they are the only ones still valid.
      console.warn('[402-mcp] Cashu payment failed after send() succeeded — restoring swapped proofs')
      restoreChangeProofs(
        tokenStore,
        sendProofs.getEncodedTokenV4,
        token.mint,
        sendProofs.proofsToKeep,
        sendProofs.proofsToSend,
      )
    } else {
      // Error occurred before send() — original token is still valid
      tokenStore.add(token)
    }
    return { paid: false, method: 'cashu', reason: 'Cashu payment failed' }
  }
}

/** Creates a Cashu wallet provider that melts ecash tokens to pay Lightning invoices. */
export function createCashuWallet(tokenStore: CashuTokenStore): WalletProvider {
  // Serialise payment attempts to prevent concurrent token consumption races
  let paymentLock: Promise<PaymentResult> = Promise.resolve({ paid: false, method: 'cashu' })

  return {
    method: 'cashu',
    get available() {
      return tokenStore.totalBalance() > 0
    },

    payInvoice(invoice: string): Promise<PaymentResult> {
      paymentLock = paymentLock
        .catch(() => {})  // never let a prior rejection block the chain
        .then(() => doPayInvoice(invoice, tokenStore))
      return paymentLock
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
  encodeFn: (token: { mint: string; proofs: Array<{ id: string; amount: number; secret: string; C: string }> }) => string,
  mint: string,
  keepProofs: Array<{ id: string; amount: number; secret: string; C: string }>,
  changeProofs: Array<{ id: string; amount: number; secret: string; C: string }>,
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
  } catch (err) {
    // Payment already succeeded; log but don't fail
    // Log generic message only — err may contain proof secrets
    console.warn('[402-mcp] Failed to restore change proofs to token store')
  }
}
