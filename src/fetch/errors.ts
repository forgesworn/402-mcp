export class SsrfError extends Error {
  override readonly name = 'SsrfError'

  constructor(reason: string, url: string) {
    super(`SSRF blocked: ${reason} (${url})`)
  }
}

export class TimeoutError extends Error {
  override readonly name = 'TimeoutError'

  constructor(ms: number, url: string) {
    super(`Request timed out after ${ms}ms (${url})`)
  }
}

export class RetryExhaustedError extends Error {
  override readonly name = 'RetryExhaustedError'

  constructor(attempts: number, url: string, cause: Error) {
    super(`Request failed after ${attempts} attempts (${url}): ${cause.message}`, { cause })
  }
}

export class ResponseTooLargeError extends Error {
  override readonly name = 'ResponseTooLargeError'
  readonly maxBytes: number

  constructor(maxBytes: number) {
    super(`Response body exceeded maximum size of ${maxBytes} bytes`)
    this.maxBytes = maxBytes
  }
}

export class DowngradeError extends Error {
  override readonly name = 'DowngradeError'

  constructor(originalUrl: string, redirectUrl: string) {
    super(`HTTPS downgrade blocked: ${originalUrl} redirected to ${redirectUrl}`)
  }
}
