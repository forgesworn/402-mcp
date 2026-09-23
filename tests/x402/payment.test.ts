import { describe, it, expect } from 'vitest'
import { formatX402PaymentRequest, isValidTxHash } from '../../src/x402/payment.js'
import type { X402Challenge } from '../../src/x402/parse.js'

describe('formatX402PaymentRequest', () => {
  const challenge: X402Challenge = {
    receiver: '0x1234567890abcdef1234567890abcdef12345678',
    network: 'base',
    asset: 'usdc',
    amountUsd: 1,
    chainId: 8453,
    amountSmallestUnit: 1000000n,
  }

  it('includes all payment details in the JSON', () => {
    const result = formatX402PaymentRequest(challenge)

    expect(result.json.status).toBe(402)
    expect(result.json.protocol).toBe('x402')
    expect(result.json.receiver).toBe('0x1234567890abcdef1234567890abcdef12345678')
    expect(result.json.network).toBe('base')
    expect(result.json.asset).toBe('USDC')
    expect(result.json.amountUsd).toBe(1)
    expect(result.json.chainId).toBe(8453)
  })

  it('emits no EIP-681 link, which would lack the token contract and amount', () => {
    expect(formatX402PaymentRequest(challenge).json.paymentDeeplink).toBeUndefined()
  })

  it('marks x402 support as experimental', () => {
    expect(formatX402PaymentRequest(challenge).json.experimental).toContain('custom format')
  })

  it('does not present a USD price as a quantity of ETH', () => {
    const result = formatX402PaymentRequest({ ...challenge, asset: 'eth', amountSmallestUnit: null })
    expect(result.message).toContain('a USD value, payable in ETH')
    expect(result.message).not.toMatch(/\$1 ETH/)
  })

  it('omits chainId when null', () => {
    const unknownChain: X402Challenge = {
      ...challenge,
      network: 'solana',
      chainId: null,
    }
    const result = formatX402PaymentRequest(unknownChain)
    expect(result.json.chainId).toBeUndefined()
  })

  it('generates a human-readable message', () => {
    const result = formatX402PaymentRequest(challenge)
    expect(result.message).toContain('1 USDC')
    expect(result.message).toContain('USDC')
    expect(result.message).toContain('base')
    expect(result.message).toContain('0x1234567890abcdef1234567890abcdef12345678')
    expect(result.message).toContain('transaction hash')
  })
})

describe('isValidTxHash', () => {
  it('accepts a valid 0x-prefixed 64-char hex hash', () => {
    expect(isValidTxHash('0x' + 'a'.repeat(64))).toBe(true)
  })

  it('accepts mixed-case hex', () => {
    expect(isValidTxHash('0xAbCdEf1234567890AbCdEf1234567890AbCdEf1234567890AbCdEf1234567890')).toBe(true)
  })

  it('rejects hash without 0x prefix', () => {
    expect(isValidTxHash('a'.repeat(64))).toBe(false)
  })

  it('rejects hash that is too short', () => {
    expect(isValidTxHash('0x' + 'a'.repeat(63))).toBe(false)
  })

  it('rejects hash that is too long', () => {
    expect(isValidTxHash('0x' + 'a'.repeat(65))).toBe(false)
  })

  it('rejects non-hex characters', () => {
    expect(isValidTxHash('0x' + 'g'.repeat(64))).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isValidTxHash('')).toBe(false)
  })
})
