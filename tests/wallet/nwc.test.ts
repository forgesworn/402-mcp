import { describe, it, expect } from 'vitest'
import { hexToBytes } from '../../src/wallet/nwc.js'

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

  it('rejects non-WebSocket relay URL', async () => {
    const { createNwcWallet } = await import('../../src/wallet/nwc.js')
    const wallet = createNwcWallet('nostr+walletconnect://abc123?relay=http://evil.example.com&secret=abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234')
    const result = await wallet.payInvoice('lnbc100n1test')
    expect(result.paid).toBe(false)
    expect(result.reason).toContain('ws:// or wss://')
  })
})

describe('hexToBytes', () => {
  it('converts valid hex string', () => {
    const result = hexToBytes('deadbeef')
    expect(result).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))
  })

  it('handles uppercase hex', () => {
    const result = hexToBytes('DEADBEEF')
    expect(result).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))
  })

  it('throws TypeError on odd-length string', () => {
    expect(() => hexToBytes('abc')).toThrow(TypeError)
    expect(() => hexToBytes('abc')).toThrow('even')
  })

  it('throws TypeError on non-hex characters', () => {
    expect(() => hexToBytes('ghij')).toThrow(TypeError)
    expect(() => hexToBytes('ghij')).toThrow('hex')
  })

  it('throws TypeError on empty string', () => {
    expect(() => hexToBytes('')).toThrow(TypeError)
  })
})
