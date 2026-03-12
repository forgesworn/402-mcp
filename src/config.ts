import { resolve } from 'node:path'
import { homedir } from 'node:os'

export interface L402Config {
  nwcUri: string | undefined
  cashuTokensPath: string | undefined
  maxAutoPaySats: number
  maxSpendPerMinuteSats: number
  credentialStorePath: string
  transport: 'stdio' | 'http'
  port: number
  humanPayTimeoutS: number
  humanPayPollS: number
  fetchTimeoutMs: number
  fetchMaxRetries: number
  fetchMaxResponseBytes: number
  ssrfAllowPrivate: boolean
  corsOrigin: string | false
  bindAddress: string
}

function assertNonNegativeInt(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error(`${name} must be a positive integer or zero; got ${value}`)
  }
}

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 1 || !Number.isInteger(value)) {
    throw new Error(`${name} must be a positive integer (> 0); got ${value}`)
  }
}

function assertRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max || !Number.isInteger(value)) {
    throw new Error(`${name} must be an integer between ${min} and ${max}; got ${value}`)
  }
}

export function loadConfig(): L402Config {
  const defaultCredentialStore = resolve(homedir(), '.l402-mcp', 'credentials.json')

  const nwcUri = process.env.NWC_URI
  if (nwcUri !== undefined) {
    delete process.env.NWC_URI
  }

  const transport = process.env.TRANSPORT ?? 'stdio'
  if (transport !== 'stdio' && transport !== 'http') {
    throw new Error(`TRANSPORT must be 'stdio' or 'http'; got '${transport}'`)
  }

  const config: L402Config = {
    nwcUri,
    cashuTokensPath: process.env.CASHU_TOKENS,
    maxAutoPaySats: parseInt(process.env.MAX_AUTO_PAY_SATS ?? '1000', 10),
    maxSpendPerMinuteSats: parseInt(process.env.MAX_SPEND_PER_MINUTE_SATS ?? '10000', 10),
    credentialStorePath: process.env.CREDENTIAL_STORE ?? defaultCredentialStore,
    transport,
    port: parseInt(process.env.PORT ?? '3402', 10),
    humanPayTimeoutS: parseInt(process.env.HUMAN_PAY_TIMEOUT_S ?? '600', 10),
    humanPayPollS: parseInt(process.env.HUMAN_PAY_POLL_S ?? '3', 10),
    fetchTimeoutMs: parseInt(process.env.FETCH_TIMEOUT_MS ?? '30000', 10),
    fetchMaxRetries: parseInt(process.env.FETCH_MAX_RETRIES ?? '2', 10),
    fetchMaxResponseBytes: parseInt(process.env.FETCH_MAX_RESPONSE_BYTES ?? '10485760', 10),
    ssrfAllowPrivate: process.env.SSRF_ALLOW_PRIVATE === 'true',
    corsOrigin: process.env.CORS_ORIGIN || false,
    bindAddress: process.env.BIND_ADDRESS ?? '127.0.0.1',
  }

  assertNonNegativeInt('MAX_AUTO_PAY_SATS', config.maxAutoPaySats)
  assertNonNegativeInt('MAX_SPEND_PER_MINUTE_SATS', config.maxSpendPerMinuteSats)
  assertRange('PORT', config.port, 1, 65535)
  assertPositiveInt('FETCH_TIMEOUT_MS', config.fetchTimeoutMs)
  assertNonNegativeInt('FETCH_MAX_RETRIES', config.fetchMaxRetries)
  assertPositiveInt('FETCH_MAX_RESPONSE_BYTES', config.fetchMaxResponseBytes)
  assertPositiveInt('HUMAN_PAY_TIMEOUT_S', config.humanPayTimeoutS)
  assertPositiveInt('HUMAN_PAY_POLL_S', config.humanPayPollS)

  return config
}
