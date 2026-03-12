import type { WalletProvider, PaymentResult } from './types.js'
import type { CashuTokenStore } from '../store/cashu-tokens.js'

export function createCashuWallet(tokenStore: CashuTokenStore): WalletProvider {
  return {
    method: 'cashu',
    get available() {
      return tokenStore.totalBalance() > 0
    },

    async payInvoice(invoice: string): Promise<PaymentResult> {
      const token = tokenStore.consumeFirst()
      if (!token) {
        return { paid: false, method: 'cashu', reason: 'No Cashu tokens available' }
      }

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
          // Payment failed; re-add the token since it wasn't spent
          tokenStore.add(token)
          return { paid: false, method: 'cashu', reason: 'Cashu melt failed' }
        }
      } catch (err) {
        // On error, re-add the token (it may not have been spent)
        tokenStore.add(token)
        return { paid: false, method: 'cashu', reason: String(err) }
      }
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
    console.warn('[l402-mcp] Failed to restore change proofs to token store:', err)
  }
}
