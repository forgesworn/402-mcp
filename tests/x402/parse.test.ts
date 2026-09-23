import { describe, it, expect } from 'vitest'
import { isX402Challenge, parseX402Challenge, buildPaymentDeeplink, type X402Challenge } from '../../src/x402/parse.js'

describe('isX402Challenge', () => {
  it('returns true when X-Payment-Required is x402', () => {
    const headers = new Headers({ 'X-Payment-Required': 'x402' })
    expect(isX402Challenge(headers)).toBe(true)
  })

  it('is case-insensitive', () => {
    const headers = new Headers({ 'X-Payment-Required': 'X402' })
    expect(isX402Challenge(headers)).toBe(true)
  })

  it('returns false when header is missing', () => {
    const headers = new Headers()
    expect(isX402Challenge(headers)).toBe(false)
  })

  it('returns false when header has different value', () => {
    const headers = new Headers({ 'X-Payment-Required': 'l402' })
    expect(isX402Challenge(headers)).toBe(false)
  })
})

describe('parseX402Challenge', () => {
  const validBody = {
    x402: {
      receiver: '0x1234567890abcdef1234567890abcdef12345678',
      network: 'base',
      asset: 'usdc',
      amount_usd: 1,
    },
  }

  it('parses a valid x402 challenge body', () => {
    const result = parseX402Challenge(validBody)
    expect(result).toEqual({
      receiver: '0x1234567890abcdef1234567890abcdef12345678',
      network: 'base',
      asset: 'usdc',
      amountUsd: 1,
      chainId: 8453,
      amountSmallestUnit: 1000000n,
    })
  })

  it('accepts amountUsd (camelCase) as well as amount_usd', () => {
    const body = {
      x402: {
        receiver: '0x1234567890abcdef1234567890abcdef12345678',
        network: 'base',
        asset: 'usdc',
        amountUsd: 0.5,
      },
    }
    const result = parseX402Challenge(body)
    expect(result).not.toBeNull()
    expect(result!.amountUsd).toBe(0.5)
    expect(result!.amountSmallestUnit).toBe(500000n)
  })

  it('normalises network and asset to lowercase', () => {
    const body = {
      x402: {
        receiver: '0x1234567890abcdef1234567890abcdef12345678',
        network: 'Base',
        asset: 'USDC',
        amount_usd: 1,
      },
    }
    const result = parseX402Challenge(body)
    expect(result!.network).toBe('base')
    expect(result!.asset).toBe('usdc')
  })

  it('returns chainId null for unknown networks', () => {
    const body = {
      x402: {
        receiver: '0x1234567890abcdef1234567890abcdef12345678',
        network: 'solana',
        asset: 'usdc',
        amount_usd: 1,
      },
    }
    const result = parseX402Challenge(body)
    expect(result).not.toBeNull()
    expect(result!.chainId).toBeNull()
  })

  it('returns amountSmallestUnit null for unknown assets', () => {
    const body = {
      x402: {
        receiver: '0x1234567890abcdef1234567890abcdef12345678',
        network: 'base',
        asset: 'wbtc',
        amount_usd: 1,
      },
    }
    const result = parseX402Challenge(body)
    expect(result).not.toBeNull()
    expect(result!.amountSmallestUnit).toBeNull()
  })

  it('returns null when body is null', () => {
    expect(parseX402Challenge(null)).toBeNull()
  })

  it('returns null when body is not an object', () => {
    expect(parseX402Challenge('string')).toBeNull()
  })

  it('returns null when x402 key is missing', () => {
    expect(parseX402Challenge({ other: 'value' })).toBeNull()
  })

  it('returns null when receiver is missing', () => {
    const body = {
      x402: { network: 'base', asset: 'usdc', amount_usd: 1 },
    }
    expect(parseX402Challenge(body)).toBeNull()
  })

  it('returns null when receiver is invalid Ethereum address', () => {
    const body = {
      x402: {
        receiver: '0xinvalid',
        network: 'base',
        asset: 'usdc',
        amount_usd: 1,
      },
    }
    expect(parseX402Challenge(body)).toBeNull()
  })

  it('returns null when amount is zero', () => {
    const body = {
      x402: {
        receiver: '0x1234567890abcdef1234567890abcdef12345678',
        network: 'base',
        asset: 'usdc',
        amount_usd: 0,
      },
    }
    expect(parseX402Challenge(body)).toBeNull()
  })

  it('returns null when amount is negative', () => {
    const body = {
      x402: {
        receiver: '0x1234567890abcdef1234567890abcdef12345678',
        network: 'base',
        asset: 'usdc',
        amount_usd: -1,
      },
    }
    expect(parseX402Challenge(body)).toBeNull()
  })

  it('returns null when amount is NaN', () => {
    const body = {
      x402: {
        receiver: '0x1234567890abcdef1234567890abcdef12345678',
        network: 'base',
        asset: 'usdc',
        amount_usd: NaN,
      },
    }
    expect(parseX402Challenge(body)).toBeNull()
  })

  it('returns null when amount is Infinity', () => {
    const body = {
      x402: {
        receiver: '0x1234567890abcdef1234567890abcdef12345678',
        network: 'base',
        asset: 'usdc',
        amount_usd: Infinity,
      },
    }
    expect(parseX402Challenge(body)).toBeNull()
  })

  it('handles supported networks with correct chain IDs', () => {
    const networks = [
      { network: 'base', chainId: 8453 },
      { network: 'base-sepolia', chainId: 84532 },
      { network: 'ethereum', chainId: 1 },
      { network: 'optimism', chainId: 10 },
      { network: 'arbitrum', chainId: 42161 },
      { network: 'polygon', chainId: 137 },
    ]

    for (const { network, chainId } of networks) {
      const body = {
        x402: {
          receiver: '0x1234567890abcdef1234567890abcdef12345678',
          network,
          asset: 'usdc',
          amount_usd: 1,
        },
      }
      const result = parseX402Challenge(body)
      expect(result!.chainId).toBe(chainId)
    }
  })

  it('calculates correct smallest unit for different assets', () => {
    const assets = [
      { asset: 'usdc', amount: 1, expected: 1000000n },
      { asset: 'usdt', amount: 2.5, expected: 2500000n },
      { asset: 'dai', amount: 1, expected: 1000000000000000000n },
    ]

    for (const { asset, amount, expected } of assets) {
      const body = {
        x402: {
          receiver: '0x1234567890abcdef1234567890abcdef12345678',
          network: 'base',
          asset,
          amount_usd: amount,
        },
      }
      const result = parseX402Challenge(body)
      expect(result!.amountSmallestUnit).toBe(expected)
    }
  })
})

describe('buildPaymentDeeplink', () => {
  it('returns null rather than a link with no token contract or amount', () => {
    const challenge: X402Challenge = {
      receiver: '0x1234567890abcdef1234567890abcdef12345678',
      network: 'base',
      asset: 'usdc',
      amountUsd: 1,
      chainId: 8453,
      amountSmallestUnit: 1000000n,
    }
    expect(buildPaymentDeeplink(challenge)).toBeNull()
  })
})

describe('parseX402Challenge amounts', () => {
  it('does not turn a USD amount into wei for ETH', () => {
    const result = parseX402Challenge({
      x402: { receiver: '0x1234567890abcdef1234567890abcdef12345678', network: 'base', asset: 'eth', amount_usd: 1 },
    })
    expect(result!.amountSmallestUnit).toBeNull()
  })
})
