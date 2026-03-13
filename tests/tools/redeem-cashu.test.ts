import { describe, it, expect, vi } from 'vitest'
import { handleRedeemCashu } from '../../src/tools/redeem-cashu.js'

describe('handleRedeemCashu', () => {
  it('redeems a token and stores credential', async () => {
    const mockFetch = vi.fn()
      // First call: create-invoice
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          payment_hash: 'hash789',
          macaroon: 'mac789',
          payment_url: '/invoice-status/hash789?token=status123',
        }),
      })
      // Second call: cashu-redeem
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token_suffix: 'suffix456',
          credited: 1000,
        }),
      })

    const storeCredential = vi.fn()
    const removeToken = vi.fn()

    const result = await handleRedeemCashu(
      { url: 'https://api.example.com/data', token: 'cashuAeyJ...' },
      {
        fetchFn: mockFetch as unknown as typeof fetch,
        storeCredential,
        removeToken,
      },
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.redeemed).toBe(true)
    expect(parsed.creditsReceived).toBe(1000)
    expect(parsed.credentialsStored).toBe(true)
    expect(storeCredential).toHaveBeenCalledWith('https://api.example.com', 'mac789', 'suffix456', 'hash789')
    expect(removeToken).toHaveBeenCalledWith('cashuAeyJ...')

    // Verify fetch calls
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.example.com/create-invoice')
    expect(mockFetch.mock.calls[1][0]).toBe('https://api.example.com/cashu-redeem')
  })

  it('returns error when create-invoice response JSON is an array', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ['not', 'an', 'object'],
    })

    const result = await handleRedeemCashu(
      { url: 'https://api.example.com/data', token: 'cashuAeyJ...' },
      {
        fetchFn: mockFetch as unknown as typeof fetch,
        storeCredential: vi.fn(),
        removeToken: vi.fn(),
      },
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error).toBeDefined()
    expect(result.isError).toBe(true)
  })

  it('returns error when create-invoice fails', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: 'Rate limited' }),
    })

    const result = await handleRedeemCashu(
      { url: 'https://api.example.com/data', token: 'cashuAeyJ...' },
      {
        fetchFn: mockFetch as unknown as typeof fetch,
        storeCredential: vi.fn(),
        removeToken: vi.fn(),
      },
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error).toContain('Failed to create invoice')
    expect(parsed.error).toContain('429')
    // Must NOT leak upstream error body
    expect(parsed.error).not.toContain('Rate limited')
    expect(result.isError).toBe(true)
  })

  it('returns error when cashu-redeem fails', async () => {
    const mockFetch = vi.fn()
      // First call: create-invoice succeeds
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          payment_hash: 'hash789',
          macaroon: 'mac789',
          payment_url: '/invoice-status/hash789?token=status123',
        }),
      })
      // Second call: cashu-redeem fails
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: 'Token already spent' }),
      })

    const storeCredential = vi.fn()
    const removeToken = vi.fn()

    const result = await handleRedeemCashu(
      { url: 'https://api.example.com/data', token: 'cashuAeyJ...' },
      {
        fetchFn: mockFetch as unknown as typeof fetch,
        storeCredential,
        removeToken,
      },
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error).toContain('Cashu redemption failed')
    expect(parsed.error).toContain('400')
    // Must NOT leak upstream error body
    expect(parsed.error).not.toContain('Token already spent')
    expect(result.isError).toBe(true)
    expect(storeCredential).not.toHaveBeenCalled()
    expect(removeToken).not.toHaveBeenCalled()
  })

  it('rejects empty token_suffix from server', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          payment_hash: 'hash789',
          macaroon: 'mac789',
          payment_url: '/invoice-status/hash789?token=status123',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token_suffix: '',
          credited: 1000,
        }),
      })

    const storeCredential = vi.fn()

    const result = await handleRedeemCashu(
      { url: 'https://api.example.com/data', token: 'cashuAeyJ...' },
      {
        fetchFn: mockFetch as unknown as typeof fetch,
        storeCredential,
        removeToken: vi.fn(),
      },
    )

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error).toBeDefined()
    expect(result.isError).toBe(true)
    // Must NOT store credential with empty preimage
    expect(storeCredential).not.toHaveBeenCalled()
  })
})
