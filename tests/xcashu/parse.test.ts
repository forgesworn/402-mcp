import { describe, it, expect } from 'vitest'
import { parseXCashuChallenge, isXCashuChallenge } from '../../src/xcashu/parse.js'

function encode(obj: unknown): string {
  return 'creqA' + Buffer.from(JSON.stringify(obj)).toString('base64url')
}

describe('isXCashuChallenge', () => {
  it('returns true when X-Cashu header starts with creqA', () => {
    const headers = new Headers({ 'X-Cashu': encode({ a: 5, u: 'sat', m: ['https://mint.example.com'] }) })
    expect(isXCashuChallenge(headers)).toBe(true)
  })

  it('returns false when no X-Cashu header', () => {
    expect(isXCashuChallenge(new Headers())).toBe(false)
  })

  it('returns false for non-creqA value', () => {
    const headers = new Headers({ 'X-Cashu': 'cashuBsomething' })
    expect(isXCashuChallenge(headers)).toBe(false)
  })
})

describe('parseXCashuChallenge', () => {
  it('parses valid NUT-18 payment request', () => {
    const header = encode({ a: 5, u: 'sat', m: ['https://mint.example.com'] })
    const result = parseXCashuChallenge(header)
    expect(result).toEqual({
      amount: 5,
      unit: 'sat',
      mints: ['https://mint.example.com'],
    })
  })

  it('parses multiple mints', () => {
    const header = encode({ a: 10, u: 'sat', m: ['https://mint1.com', 'https://mint2.com'] })
    const result = parseXCashuChallenge(header)
    expect(result!.mints).toEqual(['https://mint1.com', 'https://mint2.com'])
  })

  it('returns null for missing prefix', () => {
    expect(parseXCashuChallenge('notcreqA...')).toBeNull()
  })

  it('returns null for invalid base64', () => {
    expect(parseXCashuChallenge('creqA!!invalid!!')).toBeNull()
  })

  it('returns null for missing amount', () => {
    const header = encode({ u: 'sat', m: ['https://mint.example.com'] })
    expect(parseXCashuChallenge(header)).toBeNull()
  })

  it('returns null for missing mints', () => {
    const header = encode({ a: 5, u: 'sat' })
    expect(parseXCashuChallenge(header)).toBeNull()
  })

  it('returns null for empty mints array', () => {
    const header = encode({ a: 5, u: 'sat', m: [] })
    expect(parseXCashuChallenge(header)).toBeNull()
  })

  it('returns null for non-sat unit (v1 only supports sat)', () => {
    const header = encode({ a: 5, u: 'usd', m: ['https://mint.example.com'] })
    expect(parseXCashuChallenge(header)).toBeNull()
  })

  it('returns null for zero amount', () => {
    const header = encode({ a: 0, u: 'sat', m: ['https://mint.example.com'] })
    expect(parseXCashuChallenge(header)).toBeNull()
  })

  it('returns null for negative amount', () => {
    const header = encode({ a: -5, u: 'sat', m: ['https://mint.example.com'] })
    expect(parseXCashuChallenge(header)).toBeNull()
  })
})
