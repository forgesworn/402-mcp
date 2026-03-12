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
        const { CashuMint, CashuWallet, getDecodedToken } = await import('@cashu/cashu-ts')
        const mint = new CashuMint(token.mint)
        const wallet = new CashuWallet(mint)

        // Decode the token to get proofs (v2 format: { mint, proofs, unit })
        const decoded = getDecodedToken(token.token)
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
        const { send: proofsToSend } = await wallet.send(amountNeeded, proofs, {
          includeFees: true,
        })

        const meltResponse = await wallet.meltProofs(meltQuote, proofsToSend)

        if (meltResponse.quote.state === 'PAID') {
          // Store any change proofs back (proofsToKeep + meltResponse.change)
          // For simplicity we don't re-add partial change; the token was consumed
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
