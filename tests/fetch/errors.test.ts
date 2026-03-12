import { describe, it, expect } from 'vitest'
import { SsrfError, TimeoutError, RetryExhaustedError, ResponseTooLargeError, DowngradeError } from '../../src/fetch/errors.js'

describe('SsrfError', () => {
  it('formats message with reason and URL', () => {
    const err = new SsrfError('private IP', 'http://192.168.1.1/api')
    expect(err.message).toBe('SSRF blocked: private IP (http://192.168.1.1/api)')
    expect(err.name).toBe('SsrfError')
    expect(err).toBeInstanceOf(Error)
  })
})

describe('TimeoutError', () => {
  it('formats message with ms and URL', () => {
    const err = new TimeoutError(30000, 'http://example.com/api')
    expect(err.message).toBe('Request timed out after 30000ms (http://example.com/api)')
    expect(err.name).toBe('TimeoutError')
    expect(err).toBeInstanceOf(Error)
  })
})

describe('RetryExhaustedError', () => {
  it('formats message with attempts, URL, and cause', () => {
    const cause = new TypeError('fetch failed')
    const err = new RetryExhaustedError(3, 'http://example.com/api', cause)
    expect(err.message).toBe('Request failed after 3 attempts (http://example.com/api): fetch failed')
    expect(err.name).toBe('RetryExhaustedError')
    expect(err.cause).toBe(cause)
    expect(err).toBeInstanceOf(Error)
  })
})

describe('ResponseTooLargeError', () => {
  it('includes max bytes in message', () => {
    const err = new ResponseTooLargeError(10_485_760)
    expect(err.message).toContain('10485760')
    expect(err.name).toBe('ResponseTooLargeError')
    expect(err.maxBytes).toBe(10_485_760)
    expect(err).toBeInstanceOf(Error)
  })
})

describe('DowngradeError', () => {
  it('includes both URLs in message', () => {
    const err = new DowngradeError('https://api.example.com', 'http://api.example.com')
    expect(err.message).toContain('https://api.example.com')
    expect(err.message).toContain('http://api.example.com')
    expect(err.name).toBe('DowngradeError')
    expect(err).toBeInstanceOf(Error)
  })
})
