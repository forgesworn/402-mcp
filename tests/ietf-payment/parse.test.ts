import { describe, it, expect } from 'vitest'
import { isIETFPaymentChallenge, parseIETFPaymentChallenge } from '../../src/ietf-payment/parse.js'

// Helper: encode a Lightning charge request as base64url JCS
function encodeChargeRequest(amountSats: number, invoice: string, paymentHash: string): string {
  const request = {
    amount: String(amountSats),
    currency: 'sat',
    methodDetails: { invoice, paymentHash, network: 'mainnet' },
  }
  return Buffer.from(JSON.stringify(request)).toString('base64url')
}

const INVOICE = 'lnbc100n1ptest'
const PAYMENT_HASH = 'a'.repeat(64)
const REQUEST = encodeChargeRequest(100, INVOICE, PAYMENT_HASH)
const CHALLENGE_HEADER = `Payment id="hmac123", realm="api.example.com", method="lightning", intent="charge", request="${REQUEST}", expires="2026-12-31T23:59:59Z"`

describe('isIETFPaymentChallenge', () => {
  it('detects Payment scheme in WWW-Authenticate', () => {
    const headers = new Headers({ 'www-authenticate': CHALLENGE_HEADER })
    expect(isIETFPaymentChallenge(headers)).toBe(true)
  })

  it('detects Payment in multi-scheme header', () => {
    const multi = `L402 macaroon="mac1", invoice="lnbc1test", ${CHALLENGE_HEADER}`
    const headers = new Headers({ 'www-authenticate': multi })
    expect(isIETFPaymentChallenge(headers)).toBe(true)
  })

  it('returns false when no Payment scheme present', () => {
    const headers = new Headers({ 'www-authenticate': 'L402 macaroon="mac1", invoice="lnbc1test"' })
    expect(isIETFPaymentChallenge(headers)).toBe(false)
  })

  it('returns false for empty header', () => {
    const headers = new Headers()
    expect(isIETFPaymentChallenge(headers)).toBe(false)
  })
})

describe('parseIETFPaymentChallenge', () => {
  it('parses a standard Payment challenge', () => {
    const result = parseIETFPaymentChallenge(CHALLENGE_HEADER)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('hmac123')
    expect(result!.realm).toBe('api.example.com')
    expect(result!.method).toBe('lightning')
    expect(result!.intent).toBe('charge')
    expect(result!.request).toBe(REQUEST)
    expect(result!.expires).toBe('2026-12-31T23:59:59Z')
  })

  it('decodes Lightning charge request details', () => {
    const result = parseIETFPaymentChallenge(CHALLENGE_HEADER)
    expect(result!.invoice).toBe(INVOICE)
    expect(result!.paymentHash).toBe(PAYMENT_HASH)
    expect(result!.amountSats).toBe(100)
  })

  it('extracts Payment from multi-scheme header (Payment first)', () => {
    const multi = `${CHALLENGE_HEADER}, L402 macaroon="mac1", invoice="lnbc1test"`
    const result = parseIETFPaymentChallenge(multi)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('hmac123')
    expect(result!.method).toBe('lightning')
  })

  it('extracts Payment from multi-scheme header (L402 first)', () => {
    const multi = `L402 macaroon="mac1", invoice="lnbc1test", ${CHALLENGE_HEADER}`
    const result = parseIETFPaymentChallenge(multi)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('hmac123')
  })

  it('parses challenge with description', () => {
    const header = `Payment id="h1", realm="r1", method="lightning", intent="charge", request="${REQUEST}", description="Pay per request"`
    const result = parseIETFPaymentChallenge(header)
    expect(result!.description).toBe('Pay per request')
  })

  it('parses challenge without expires', () => {
    const header = `Payment id="h1", realm="r1", method="lightning", intent="charge", request="${REQUEST}"`
    const result = parseIETFPaymentChallenge(header)
    expect(result).not.toBeNull()
    expect(result!.expires).toBeUndefined()
  })

  it('returns null for missing required fields', () => {
    expect(parseIETFPaymentChallenge('Payment id="h1"')).toBeNull()
    expect(parseIETFPaymentChallenge('Payment id="h1", realm="r1"')).toBeNull()
    expect(parseIETFPaymentChallenge('Payment id="h1", realm="r1", method="lightning"')).toBeNull()
    expect(parseIETFPaymentChallenge('Payment id="h1", realm="r1", method="lightning", intent="charge"')).toBeNull()
  })

  it('returns null for non-Payment scheme', () => {
    expect(parseIETFPaymentChallenge('L402 macaroon="m", invoice="ln1"')).toBeNull()
    expect(parseIETFPaymentChallenge('Bearer token123')).toBeNull()
  })

  it('handles non-lightning method without decoding', () => {
    const request = Buffer.from(JSON.stringify({ amount: '5.00', currency: 'usd' })).toString('base64url')
    const header = `Payment id="h1", realm="r1", method="cashu", intent="charge", request="${request}"`
    const result = parseIETFPaymentChallenge(header)
    expect(result).not.toBeNull()
    expect(result!.method).toBe('cashu')
    expect(result!.invoice).toBeUndefined()
    expect(result!.amountSats).toBeUndefined()
  })

  it('handles corrupted base64url request gracefully', () => {
    const header = 'Payment id="h1", realm="r1", method="lightning", intent="charge", request="!!!notbase64"'
    const result = parseIETFPaymentChallenge(header)
    expect(result).not.toBeNull()
    expect(result!.invoice).toBeUndefined()
    expect(result!.amountSats).toBeUndefined()
  })
})
