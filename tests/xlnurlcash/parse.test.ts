import { describe, it, expect } from 'vitest'
import { parseLnurlcashChallenge, isLnurlcashChallenge } from '../../src/xlnurlcash/parse.js'

function encode(obj: unknown): string {
  return 'lnurlcashreq1' + Buffer.from(JSON.stringify(obj)).toString('base64url')
}

describe('isLnurlcashChallenge', () => {
  it('returns true when X-LNURLcash header carries a payment request', () => {
    const headers = new Headers({ 'X-LNURLcash': encode({ a: 5, u: 'sat', m: ['mint.example.com'] }) })
    expect(isLnurlcashChallenge(headers)).toBe(true)
  })

  it('matches the header name case-insensitively, as HTTP requires', () => {
    const headers = new Headers({ 'x-lnurlcash': encode({ a: 5, u: 'sat', m: ['mint.example.com'] }) })
    expect(isLnurlcashChallenge(headers)).toBe(true)
  })

  it('returns false when there is no X-LNURLcash header', () => {
    expect(isLnurlcashChallenge(new Headers())).toBe(false)
  })

  it('returns false for a value that is not a payment request', () => {
    const headers = new Headers({ 'X-LNURLcash': 'lnurlw://mint.example.com/w?k1=deadbeef' })
    expect(isLnurlcashChallenge(headers)).toBe(false)
  })
})

describe('parseLnurlcashChallenge', () => {
  it('parses a payment request', () => {
    const result = parseLnurlcashChallenge(encode({ a: 5, u: 'sat', m: ['mint.example.com'] }))
    expect(result).toEqual({ amount: 5, unit: 'sat', mints: ['mint.example.com'] })
  })

  it('parses several mints', () => {
    const result = parseLnurlcashChallenge(encode({ a: 10, u: 'sat', m: ['mint1.example', 'https://mint2.example'] }))
    expect(result!.mints).toEqual(['mint1.example', 'https://mint2.example'])
  })

  it('ignores unknown fields so the server can add some later', () => {
    const result = parseLnurlcashChallenge(encode({ a: 5, u: 'sat', m: ['mint.example.com'], d: 'a coffee' }))
    expect(result).toEqual({ amount: 5, unit: 'sat', mints: ['mint.example.com'] })
  })

  it('returns null for a missing prefix', () => {
    expect(parseLnurlcashChallenge('creqAsomething')).toBeNull()
  })

  it('returns null for an undecodable payload', () => {
    expect(parseLnurlcashChallenge('lnurlcashreq1!!invalid!!')).toBeNull()
  })

  it('returns null for a missing amount', () => {
    expect(parseLnurlcashChallenge(encode({ u: 'sat', m: ['mint.example.com'] }))).toBeNull()
  })

  it('returns null for a zero amount', () => {
    expect(parseLnurlcashChallenge(encode({ a: 0, u: 'sat', m: ['mint.example.com'] }))).toBeNull()
  })

  it('returns null for a negative amount', () => {
    expect(parseLnurlcashChallenge(encode({ a: -5, u: 'sat', m: ['mint.example.com'] }))).toBeNull()
  })

  it('returns null for a fractional amount', () => {
    expect(parseLnurlcashChallenge(encode({ a: 1.5, u: 'sat', m: ['mint.example.com'] }))).toBeNull()
  })

  it('returns null for an amount that cannot be expressed in msat', () => {
    expect(parseLnurlcashChallenge(encode({ a: Number.MAX_SAFE_INTEGER, u: 'sat', m: ['mint.example.com'] }))).toBeNull()
  })

  it('returns null for missing mints', () => {
    expect(parseLnurlcashChallenge(encode({ a: 5, u: 'sat' }))).toBeNull()
  })

  it('returns null for an empty mints array', () => {
    expect(parseLnurlcashChallenge(encode({ a: 5, u: 'sat', m: [] }))).toBeNull()
  })

  it('returns null for a unit other than sat', () => {
    expect(parseLnurlcashChallenge(encode({ a: 5, u: 'usd', m: ['mint.example.com'] }))).toBeNull()
  })
})

// The shape the conformance vectors pin and lnurlcash-kit encodes: amount as
// a decimal string, the mints under methodDetails, with a version and a
// handle on the charge.
describe('parseLnurlcashChallenge, the settled request shape', () => {
  const request = (over: Record<string, unknown> = {}): string =>
    encode({
      v: 1,
      id: '0b86351d2cbdd44a',
      amount: '21',
      currency: 'sat',
      methodDetails: { mints: ['mint.example.com'] },
      ...over,
    })

  it('reads amount, currency and mints', () => {
    expect(parseLnurlcashChallenge(request())).toEqual({
      amount: 21,
      unit: 'sat',
      mints: ['mint.example.com'],
    })
  })

  it('keeps every mint, including a host carrying a port', () => {
    const parsed = parseLnurlcashChallenge(
      request({ methodDetails: { mints: ['mint.example.com', '127.0.0.1:8899'] } }),
    )
    expect(parsed?.mints).toEqual(['mint.example.com', '127.0.0.1:8899'])
  })

  it('ignores anything else the request carries', () => {
    const parsed = parseLnurlcashChallenge(
      request({ memo: 'lunch', expires: 1787003600, to: 'npub1...' }),
    )
    expect(parsed?.amount).toBe(21)
  })

  it('refuses a currency it cannot price a note in', () => {
    expect(parseLnurlcashChallenge(request({ currency: 'usd' }))).toBeNull()
  })

  it('refuses an amount that is not a whole number of sats', () => {
    expect(parseLnurlcashChallenge(request({ amount: '2.5' }))).toBeNull()
    expect(parseLnurlcashChallenge(request({ amount: '-1' }))).toBeNull()
    expect(parseLnurlcashChallenge(request({ amount: '0' }))).toBeNull()
    expect(parseLnurlcashChallenge(request({ amount: 'lots' }))).toBeNull()
  })

  it('refuses an amount too large to price in msat', () => {
    expect(parseLnurlcashChallenge(request({ amount: String(Number.MAX_SAFE_INTEGER) }))).toBeNull()
  })

  it('refuses a request naming no mint it could pay', () => {
    expect(parseLnurlcashChallenge(request({ methodDetails: { mints: [] } }))).toBeNull()
    expect(parseLnurlcashChallenge(request({ methodDetails: {} }))).toBeNull()
    expect(parseLnurlcashChallenge(request({ methodDetails: 'mint.example.com' }))).toBeNull()
  })

  it('still reads the short form that went out before the shape settled', () => {
    expect(parseLnurlcashChallenge(encode({ a: 21, u: 'sat', m: ['mint.example.com'] }))).toEqual({
      amount: 21,
      unit: 'sat',
      mints: ['mint.example.com'],
    })
  })
})
