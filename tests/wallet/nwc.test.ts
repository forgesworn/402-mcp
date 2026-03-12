import { describe, it, expect, vi } from 'vitest'

describe('createNwcWallet', () => {
  it('returns a wallet provider with method nwc', async () => {
    const { createNwcWallet } = await import('../../src/wallet/nwc.js')
    const wallet = createNwcWallet('nostr+walletconnect://abc123?relay=wss://relay.example.com&secret=abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234')
    expect(wallet.method).toBe('nwc')
    expect(wallet.available).toBe(true)
  })

  it('returns error for invalid NWC URI missing relay', async () => {
    const { createNwcWallet } = await import('../../src/wallet/nwc.js')
    const wallet = createNwcWallet('nostr+walletconnect://abc123?secret=abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234')
    const result = await wallet.payInvoice('lnbc100n1test')
    expect(result.paid).toBe(false)
    expect(result.reason).toContain('missing relay')
  })

  it('returns error for invalid NWC URI missing secret', async () => {
    const { createNwcWallet } = await import('../../src/wallet/nwc.js')
    const wallet = createNwcWallet('nostr+walletconnect://abc123?relay=wss://relay.example.com')
    const result = await wallet.payInvoice('lnbc100n1test')
    expect(result.paid).toBe(false)
    expect(result.reason).toContain('missing relay or secret')
  })
})
