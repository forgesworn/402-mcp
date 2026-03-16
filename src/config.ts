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
  transportPreference: string[]
  torProxy: string | undefined
  hnsGatewayUrl: string
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

/** Loads and validates configuration from environment variables, applying defaults. */
export function loadConfig(): L402Config {
  const defaultCredentialStore = resolve(homedir(), '.402-mcp', 'credentials.json')

  const nwcUri = process.env.NWC_URI
  if (nwcUri !== undefined) {
    delete process.env.NWC_URI
  }

  const transport = process.env.TRANSPORT ?? 'stdio'
  if (transport !== 'stdio' && transport !== 'http') {
    throw new Error(`TRANSPORT must be 'stdio' or 'http'; got '${transport}'`)
  }

  const transportPref = process.env.TRANSPORT_PREFERENCE
  const transportPreference = transportPref
    ? transportPref.split(',').map(s => s.trim()).filter(Boolean)
    : ['onion', 'hns', 'https', 'http']
  const torProxy = process.env.TOR_PROXY || process.env.SOCKS_PROXY || undefined
  const hnsGatewayUrl = process.env.HNS_GATEWAY_URL || 'https://query.hdns.io/'

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
    transportPreference,
    torProxy,
    hnsGatewayUrl,
  }

  assertNonNegativeInt('MAX_AUTO_PAY_SATS', config.maxAutoPaySats)
  assertNonNegativeInt('MAX_SPEND_PER_MINUTE_SATS', config.maxSpendPerMinuteSats)
  assertRange('PORT', config.port, 1, 65535)
  assertPositiveInt('FETCH_TIMEOUT_MS', config.fetchTimeoutMs)
  assertNonNegativeInt('FETCH_MAX_RETRIES', config.fetchMaxRetries)
  assertPositiveInt('FETCH_MAX_RESPONSE_BYTES', config.fetchMaxResponseBytes)
  assertPositiveInt('HUMAN_PAY_TIMEOUT_S', config.humanPayTimeoutS)
  assertPositiveInt('HUMAN_PAY_POLL_S', config.humanPayPollS)

  // Validate credential store path stays within home directory
  // Use home + sep to prevent /home/user matching /home/username-evil
  const home = homedir()
  const homePrefix = home.endsWith('/') ? home : home + '/'
  const resolvedStorePath = resolve(config.credentialStorePath)
  if (!resolvedStorePath.startsWith(homePrefix) && resolvedStorePath !== home) {
    throw new Error(`CREDENTIAL_STORE must be within the home directory (got: ${config.credentialStorePath})`)
  }

  // Validate Cashu tokens path too — same constraint
  if (config.cashuTokensPath) {
    const resolvedCashuPath = resolve(config.cashuTokensPath)
    if (!resolvedCashuPath.startsWith(homePrefix) && resolvedCashuPath !== home) {
      throw new Error(`CASHU_TOKENS must be within the home directory (got: ${config.cashuTokensPath})`)
    }
  }

  // Warn if BIND_ADDRESS is non-loopback (server will be network-accessible without auth)
  if (config.transport === 'http' && config.bindAddress !== '127.0.0.1' && config.bindAddress !== '::1') {
    console.error(`Warning: BIND_ADDRESS is ${config.bindAddress} — server will be network-accessible without authentication. Use a reverse proxy with TLS and auth for production.`)
  }

  // Warn if CORS allows all origins (potential CSRF risk on HTTP transport)
  if (config.corsOrigin === '*') {
    console.error('Warning: CORS_ORIGIN=* — any website can make cross-origin requests to the MCP HTTP transport. Restrict to specific origins in production.')
  }

  // Block operation if TLS verification is disabled without explicit opt-in.
  // Disabling TLS defeats DNS-rebinding protection for HTTPS and WSS connections.
  // Accept either SSRF_ALLOW_PRIVATE=true or ALLOW_INSECURE_TLS=true — the latter
  // acknowledges the TLS risk without also disabling private-address SSRF blocking.
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    const tlsAcknowledged = config.ssrfAllowPrivate || process.env.ALLOW_INSECURE_TLS === 'true'
    if (!tlsAcknowledged) {
      throw new Error('NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS certificate validation, defeating DNS-rebinding protection. Set ALLOW_INSECURE_TLS=true to acknowledge the risk, or SSRF_ALLOW_PRIVATE=true for local dev.')
    }
    console.error('Warning: NODE_TLS_REJECT_UNAUTHORIZED=0 — TLS certificate validation is disabled. HTTPS DNS rebinding attacks become possible. Do not use in production.')
  }

  return config
}
