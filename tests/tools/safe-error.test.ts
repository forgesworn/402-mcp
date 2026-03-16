import { describe, it, expect } from 'vitest'
import { safeErrorMessage } from '../../src/tools/safe-error.js'
import { SsrfError, TimeoutError, RetryExhaustedError, ResponseTooLargeError, DowngradeError } from '../../src/fetch/errors.js'

describe('safeErrorMessage', () => {
  it('returns safe message for SsrfError', () => {
    const err = new SsrfError('private IP', 'http://10.0.0.1/secret')
    expect(safeErrorMessage(err)).toBe('Request blocked: target address is not allowed.')
    expect(safeErrorMessage(err)).not.toContain('10.0.0.1')
  })

  it('returns safe message for TimeoutError', () => {
    const err = new TimeoutError(30000, 'https://slow.api.com/endpoint')
    expect(safeErrorMessage(err)).toBe('Request timed out.')
    expect(safeErrorMessage(err)).not.toContain('slow.api.com')
  })

  it('returns safe message for RetryExhaustedError', () => {
    const cause = new Error('connection reset')
    const err = new RetryExhaustedError(3, 'https://flaky.api.com/data', cause)
    expect(safeErrorMessage(err)).toBe('Request failed after multiple retries.')
    expect(safeErrorMessage(err)).not.toContain('flaky.api.com')
  })

  it('returns safe message for ResponseTooLargeError', () => {
    const err = new ResponseTooLargeError(10_485_760)
    expect(safeErrorMessage(err)).toBe('Response body exceeded maximum allowed size.')
  })

  it('returns safe message for DowngradeError', () => {
    const err = new DowngradeError('https://secure.com', 'http://secure.com')
    expect(safeErrorMessage(err)).toBe('HTTPS-to-HTTP downgrade blocked.')
  })

  it('exposes error code for network errors', () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:3000')
    ;(err as NodeJS.ErrnoException).code = 'ECONNREFUSED'
    expect(safeErrorMessage(err)).toBe('Network error: ECONNREFUSED')
    expect(safeErrorMessage(err)).not.toContain('127.0.0.1')
  })

  it('returns generic message for unknown Error without leaking name', () => {
    const err = new Error('some internal stack trace details')
    expect(safeErrorMessage(err)).toBe('Request failed.')
    expect(safeErrorMessage(err)).not.toContain('stack trace')
  })

  it('does not leak custom error class names', () => {
    class InternalDatabaseError extends Error { name = 'InternalDatabaseError at /var/db/prod' }
    const err = new InternalDatabaseError('connection details')
    expect(safeErrorMessage(err)).toBe('Request failed.')
    expect(safeErrorMessage(err)).not.toContain('Database')
    expect(safeErrorMessage(err)).not.toContain('/var/db')
  })

  it('returns generic message for non-Error values', () => {
    expect(safeErrorMessage('string error')).toBe('An unexpected error occurred.')
    expect(safeErrorMessage(42)).toBe('An unexpected error occurred.')
    expect(safeErrorMessage(null)).toBe('An unexpected error occurred.')
  })
})
