import { describe, expect, it } from 'vitest'
import { decodeBolt11 } from '../../src/l402/bolt11.js'

const PAYMENT_HASH = 'a1'.repeat(32)
const AMOUNT_INVOICE =
  'lnbc2500u1pj48ugqpp55xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xssqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqju7u8g'
const SUB_SAT_INVOICE =
  'lnbc100p1pj48ugqpp55xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xssqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq2ut6f8'
const AMOUNTLESS_INVOICE =
  'lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq8rkx3yf5tcsyz3d73gafnh3cax9rn449d9p5uxz9ezhhypd0elx87sjle52x86fux2ypatgddc6k63n7erqz25le42c4u4ecky03ylcqca784w'

describe('decodeBolt11', () => {
  it('maps Farrier Kit fields to the stable 402-mcp facade', () => {
    expect(decodeBolt11(AMOUNT_INVOICE)).toEqual({
      costSats: 250_000,
      paymentHash: PAYMENT_HASH,
      expiry: 3600,
    })
  })

  it('preserves amountless invoice and explicit sat-floor behaviour', () => {
    expect(decodeBolt11(AMOUNTLESS_INVOICE)).toEqual({
      costSats: null,
      paymentHash: '0001020304050607080900010203040506070809000102030405060708090102',
      expiry: 3600,
    })
    expect(decodeBolt11(SUB_SAT_INVOICE).costSats).toBe(0)
  })

  it('keeps invalid invoices non-throwing', () => {
    expect(decodeBolt11('not-an-invoice')).toEqual({
      costSats: null,
      paymentHash: null,
      expiry: 3600,
    })
  })
})
