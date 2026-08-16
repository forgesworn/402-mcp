import { describe, it, expect } from 'vitest'
import { bech32 } from '@scure/base'
import { parseNote } from '../../src/wallet/lnurlcash-note.js'

const SECRET = 'ab'.repeat(32)
const MINT = 'https://mint.forgesworn.dev'
const NOTE_URL = `${MINT}/w?k1=${SECRET}`

function toBech32(url: string): string {
  return bech32.encode('lnurl', bech32.toWords(new TextEncoder().encode(url)), 2000).toUpperCase()
}

describe('parseNote', () => {
  it('accepts a bare 64-hex secret, with no mint', () => {
    expect(parseNote(SECRET)).toEqual({ secret: SECRET })
  })

  it('normalises hex case', () => {
    expect(parseNote(SECRET.toUpperCase())?.secret).toBe(SECRET)
  })

  it('accepts an https withdraw URL and keeps the mint origin', () => {
    expect(parseNote(NOTE_URL)).toEqual({ secret: SECRET, mint: MINT })
  })

  it('accepts an lnurlw:// URL', () => {
    expect(parseNote(`lnurlw://mint.forgesworn.dev/w?k1=${SECRET}`)).toEqual({ secret: SECRET, mint: MINT })
  })

  it('accepts bech32 LNURL, upper or lower case', () => {
    const encoded = toBech32(NOTE_URL)
    expect(parseNote(encoded)).toEqual({ secret: SECRET, mint: MINT })
    expect(parseNote(encoded.toLowerCase())).toEqual({ secret: SECRET, mint: MINT })
  })

  it('strips a lightning: prefix and surrounding whitespace', () => {
    expect(parseNote(`  lightning:${toBech32(NOTE_URL)}  `)).toEqual({ secret: SECRET, mint: MINT })
  })

  it('keeps a non-standard callback path', () => {
    expect(parseNote(`${MINT}/custom/withdraw?k1=${SECRET}&amount=99000`)).toEqual({ secret: SECRET, mint: MINT })
  })

  it('uses http for onion hosts, which have no TLS', () => {
    const onion = 'lnurlw://bgjqr6g6sksyzdv3byhsjpy2tttg2mh7rqmnifrxiv4gms5eznr5vfqd.onion/w?k1=' + SECRET
    expect(parseNote(onion)?.mint).toMatch(/^http:\/\/.*\.onion$/)
  })

  it('rejects rubbish rather than throwing', () => {
    for (const bad of ['', '   ', 'not-a-note', 'LNURL1notvalidbech32', 'https://mint.example.com/w']) {
      expect(parseNote(bad)).toBeNull()
    }
  })

  it('rejects a k1 that is not 64 hex', () => {
    expect(parseNote(`${MINT}/w?k1=deadbeef`)).toBeNull()
    expect(parseNote(`${MINT}/w?k1=${'zz'.repeat(32)}`)).toBeNull()
  })

  it('rejects a bech32 payload that is not a withdraw URL', () => {
    expect(parseNote(toBech32('https://mint.forgesworn.dev/p'))).toBeNull()
  })
})
