import { SsrfError, TimeoutError, RetryExhaustedError, ResponseTooLargeError, DowngradeError } from '../fetch/errors.js'

/** Converts an error to a user-facing message without leaking internal details or stack traces. */
export function safeErrorMessage(err: unknown): string {
  if (err instanceof SsrfError) return 'Request blocked: target address is not allowed.'
  if (err instanceof TimeoutError) return 'Request timed out.'
  if (err instanceof ResponseTooLargeError) return 'Response body exceeded maximum allowed size.'
  if (err instanceof DowngradeError) return 'HTTPS-to-HTTP downgrade blocked.'
  if (err instanceof RetryExhaustedError) return 'Request failed after multiple retries.'

  if (err instanceof TypeError && (err as NodeJS.ErrnoException).code === 'ERR_INVALID_URL') {
    return 'Invalid URL.'
  }

  // Network errors — expose the code but not the full message/stack
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code
    if (code) return `Network error: ${code}`
    // Generic fallback — do not expose err.name as custom error classes may leak details
    return 'Request failed.'
  }

  return 'An unexpected error occurred.'
}
