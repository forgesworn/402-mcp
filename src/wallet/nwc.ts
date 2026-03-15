import type { WalletProvider, PaymentResult, PayInvoiceOptions } from './types.js'

/** Creates a Nostr Wallet Connect provider that pays Lightning invoices via the NWC protocol. */
export function createNwcWallet(nwcUri: string): WalletProvider {
  return {
    method: 'nwc',
    available: true,

    async payInvoice(invoice: string, _options?: PayInvoiceOptions): Promise<PaymentResult> {
      // Parse NWC URI: nostr+walletconnect://<pubkey>?relay=<relay>&secret=<secret>
      const url = new URL(nwcUri.replace('nostr+walletconnect://', 'https://'))
      const walletPubkey = url.hostname || url.pathname.replace('//', '')
      const relay = url.searchParams.get('relay')
      const secret = url.searchParams.get('secret')

      if (!relay || !secret) {
        return { paid: false, method: 'nwc', reason: 'Invalid NWC URI: missing relay or secret' }
      }

      // Validate relay URL scheme (defence in depth — only WebSocket allowed)
      if (!relay.startsWith('wss://') && !relay.startsWith('ws://')) {
        return { paid: false, method: 'nwc', reason: 'Invalid NWC URI: relay must use ws:// or wss://' }
      }

      let secretBytes: Uint8Array | undefined
      let conversationKey: Uint8Array | undefined

      try {
        const { getPublicKey, finalizeEvent, verifyEvent } = await import('nostr-tools/pure')
        const { Relay } = await import('nostr-tools/relay')
        const { encrypt, decrypt, getConversationKey } = await import('nostr-tools/nip44')

        secretBytes = hexToBytes(secret)
        getPublicKey(secretBytes)

        conversationKey = getConversationKey(secretBytes, walletPubkey)

        const content = JSON.stringify({
          method: 'pay_invoice',
          params: { invoice },
        })

        const encrypted = encrypt(content, conversationKey)

        const event = finalizeEvent({
          kind: 23194,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['p', walletPubkey]],
          content: encrypted,
        }, secretBytes)

        // Zeroise secret bytes now that signing is complete
        secretBytes.fill(0)
        secretBytes = undefined

        const r = await Relay.connect(relay)

        // Capture conversationKey in local const for the closure; clear
        // the outer reference so the finally block doesn't double-zero.
        const ck = conversationKey
        conversationKey = undefined

        return new Promise<PaymentResult>((resolve) => {
          const timeout = setTimeout(() => {
            ck.fill(0)
            r.close()
            resolve({ paid: false, method: 'nwc', reason: 'NWC payment timeout' })
          }, 60_000)

          r.subscribe([{
            kinds: [23195],
            '#e': [event.id],
            authors: [walletPubkey],
          }], {
            onevent: (responseEvent) => {
              clearTimeout(timeout)
              try {
                // Verify the event is from the expected wallet — relay-side
                // filtering is advisory; a compromised relay could inject
                // events from a different pubkey.
                if (responseEvent.pubkey !== walletPubkey || !verifyEvent(responseEvent)) {
                  ck.fill(0)
                  r.close()
                  resolve({ paid: false, method: 'nwc', reason: 'NWC response signature verification failed' })
                  return
                }
                const decrypted = decrypt(responseEvent.content, ck)
                const response = JSON.parse(decrypted)
                const preimage = response.result?.preimage
                if (typeof preimage === 'string' && preimage && /^[0-9a-fA-F]{64}$/.test(preimage)) {
                  ck.fill(0)
                  r.close()
                  resolve({ paid: true, preimage, method: 'nwc' })
                } else {
                  ck.fill(0)
                  r.close()
                  resolve({ paid: false, method: 'nwc', reason: response.error?.message ?? 'Payment failed' })
                }
              } catch {
                ck.fill(0)
                r.close()
                resolve({ paid: false, method: 'nwc', reason: 'NWC response decryption failed' })
              }
            },
          })

          r.publish(event)
        })
      } catch {
        // Never expose raw error messages — they may contain the NWC secret
        return { paid: false, method: 'nwc', reason: 'NWC payment failed' }
      } finally {
        // Ensure key material is always zeroised, even on unexpected errors
        if (secretBytes) secretBytes.fill(0)
        if (conversationKey) conversationKey.fill(0)
      }
    },
  }
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length === 0 || hex.length % 2 !== 0) {
    throw new TypeError(`Hex string must have even length (got ${hex.length})`)
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new TypeError('String contains non-hex characters')
  }
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  }
  return bytes
}
