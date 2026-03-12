import { describe, it, expect } from 'vitest'
import { parseL402Challenge } from '../../src/l402/parse.js'

describe('parseL402Challenge', () => {
  it('parses standard WWW-Authenticate L402 header', () => {
    const header = 'L402 macaroon="abc123", invoice="lnbc100n1test"'
    const result = parseL402Challenge(header)
    expect(result).toEqual({
      macaroon: 'abc123',
      invoice: 'lnbc100n1test',
    })
  })

  it('parses LSAT header (backwards compat)', () => {
    const header = 'LSAT macaroon="abc123", invoice="lnbc100n1test"'
    const result = parseL402Challenge(header)
    expect(result).toEqual({
      macaroon: 'abc123',
      invoice: 'lnbc100n1test',
    })
  })

  it('returns null for non-L402 header', () => {
    const result = parseL402Challenge('Bearer token123')
    expect(result).toBeNull()
  })

  it('returns null for malformed L402 header (missing invoice)', () => {
    const result = parseL402Challenge('L402 macaroon="abc123"')
    expect(result).toBeNull()
  })

  it('handles unquoted values', () => {
    const header = 'L402 macaroon=abc123, invoice=lnbc100n1test'
    const result = parseL402Challenge(header)
    expect(result).toEqual({
      macaroon: 'abc123',
      invoice: 'lnbc100n1test',
    })
  })
})

describe('strict validation', () => {
  it('rejects macaroon with invalid characters', () => {
    const header = 'L402 macaroon="not!valid@chars", invoice="lnbc1234"'
    const result = parseL402Challenge(header)
    expect(result).toBeNull()
  })

  it('rejects macaroon with angle brackets', () => {
    const header = 'L402 macaroon="abc<>def", invoice="lnbc1234"'
    const result = parseL402Challenge(header)
    expect(result).toBeNull()
  })

  it('accepts valid base64url macaroon', () => {
    const header = 'L402 macaroon="AgELbG9jYWxob3N0AEI", invoice="lnbc100n1ptest"'
    const result = parseL402Challenge(header)
    expect(result).not.toBeNull()
    expect(result!.macaroon).toBe('AgELbG9jYWxob3N0AEI')
  })

  it('accepts macaroon with padding chars', () => {
    const header = 'L402 macaroon="AgELbG9jYWxob3N0AEI=", invoice="lnbc100n1ptest"'
    const result = parseL402Challenge(header)
    expect(result).not.toBeNull()
  })
})
