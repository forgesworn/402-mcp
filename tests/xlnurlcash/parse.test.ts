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
