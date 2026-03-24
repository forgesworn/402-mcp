import { describe, it, expect } from 'vitest'
import { buildIETFPaymentCredential } from '../../src/ietf-payment/credential.js'
import type { IETFPaymentChallenge } from '../../src/ietf-payment/parse.js'

const REQUEST = Buffer.from(JSON.stringify({
  amount: '100',
  currency: 'sat',
  methodDetails: { invoice: 'lnbc100n1ptest', paymentHash: 'a'.repeat(64), network: 'mainnet' },
})).toString('base64url')

const CHALLENGE: IETFPaymentChallenge = {
  id: 'hmac123',
  realm: 'api.example.com',
  method: 'lightning',
  intent: 'charge',
  request: REQUEST,
  expires: '2026-12-31T23:59:59Z',
  invoice: 'lnbc100n1ptest',
  paymentHash: 'a'.repeat(64),
  amountSats: 100,
}

const PREIMAGE = 'b'.repeat(64)

describe('buildIETFPaymentCredential', () => {
  it('returns a valid base64url-encoded credential', () => {
    const credential = buildIETFPaymentCredential(CHALLENGE, PREIMAGE)
    const decoded = JSON.parse(Buffer.from(credential, 'base64url').toString())

    expect(decoded.challenge.id).toBe('hmac123')
    expect(decoded.challenge.realm).toBe('api.example.com')
    expect(decoded.challenge.method).toBe('lightning')
    expect(decoded.challenge.intent).toBe('charge')
    expect(decoded.challenge.request).toBe(REQUEST)
    expect(decoded.challenge.expires).toBe('2026-12-31T23:59:59Z')
    expect(decoded.payload.preimage).toBe(PREIMAGE)
  })

  it('omits expires when not present', () => {
    const noExpiry: IETFPaymentChallenge = { ...CHALLENGE, expires: undefined }
    const credential = buildIETFPaymentCredential(noExpiry, PREIMAGE)
    const decoded = JSON.parse(Buffer.from(credential, 'base64url').toString())

    expect(decoded.challenge.expires).toBeUndefined()
  })

  it('includes description when present', () => {
    const withDesc: IETFPaymentChallenge = { ...CHALLENGE, description: 'Pay per request' }
    const credential = buildIETFPaymentCredential(withDesc, PREIMAGE)
    const decoded = JSON.parse(Buffer.from(credential, 'base64url').toString())

    expect(decoded.challenge.description).toBe('Pay per request')
  })

  it('produces credential that toll-booth can verify', () => {
    const credential = buildIETFPaymentCredential(CHALLENGE, PREIMAGE)
    const decoded = JSON.parse(Buffer.from(credential, 'base64url').toString())

    // toll-booth expects: challenge.id, challenge.realm, challenge.method,
    // challenge.intent, challenge.request, payload.preimage
    expect(decoded).toHaveProperty('challenge.id')
    expect(decoded).toHaveProperty('challenge.realm')
    expect(decoded).toHaveProperty('challenge.method')
    expect(decoded).toHaveProperty('challenge.intent')
    expect(decoded).toHaveProperty('challenge.request')
    expect(decoded).toHaveProperty('payload.preimage')
  })
})
