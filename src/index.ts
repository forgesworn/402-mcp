#!/usr/bin/env node

import { createRequire } from 'node:module'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { loadConfig } from './config.js'
import { CredentialStore } from './store/credentials.js'
import { CashuTokenStore } from './store/cashu-tokens.js'
import { ChallengeCache } from './l402/challenge-cache.js'
import { decodeBolt11 } from './l402/bolt11.js'
import { parseL402Challenge } from './l402/parse.js'
import { detectServer } from './l402/detect.js'
import { resolveWallet } from './wallet/resolve.js'
import { createNwcWallet } from './wallet/nwc.js'
import { createCashuWallet } from './wallet/cashu.js'
import { createHumanWallet } from './wallet/human.js'
import type { WalletMethod, WalletProvider } from './wallet/types.js'
import { registerConfigTool } from './tools/config.js'
import { registerDiscoverTool } from './tools/discover.js'
import { registerFetchTool } from './tools/fetch.js'
import { registerPayTool } from './tools/pay.js'
import { registerCredentialsTool } from './tools/credentials.js'
import { registerStoreTokenTool } from './tools/store-token.js'
import { registerBalanceTool } from './tools/balance.js'
import { registerBuyCreditsTool } from './tools/buy-credits.js'
import { registerRedeemCashuTool } from './tools/redeem-cashu.js'
import { registerSearchTool } from './tools/search.js'
import { registerFetchPreviewTool } from './tools/fetch-preview.js'
import { createNostrSubscriber } from './tools/nostr-subscribe.js'
import { isX402Challenge, parseX402Challenge } from './x402/parse.js'
import { formatX402PaymentRequest } from './x402/payment.js'
import { isXCashuChallenge, parseXCashuChallenge } from './xcashu/parse.js'
import { attemptXCashuPayment } from './xcashu/payment.js'
import { isIETFPaymentChallenge, parseIETFPaymentChallenge } from './ietf-payment/parse.js'
import { buildIETFPaymentCredential } from './ietf-payment/credential.js'
import { createResilientFetch, withTransportFallback } from './fetch/resilient-fetch.js'
import { selectTransports } from './fetch/transport.js'
import { resolveHns as resolveHnsBase } from './fetch/hns-resolve.js'
import { SpendTracker } from './spend-tracker.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

const config = loadConfig()

// Bind the HNS resolver with the configured gateway URL
const resolveHns = (hostname: string) => resolveHnsBase(hostname, config.hnsGatewayUrl)

const resilientFetch = createResilientFetch(fetch, {
  timeoutMs: config.fetchTimeoutMs,
  retries: config.fetchMaxRetries,
  maxResponseBytes: config.fetchMaxResponseBytes,
  ssrfAllowPrivate: config.ssrfAllowPrivate,
  resolveHns,
  hasTorProxy: !!config.torProxy,
})

// Shared state
const credentialStore = new CredentialStore(config.credentialStorePath)
const { keySource } = await credentialStore.init()
if (keySource === 'file') {
  console.error('Warning: encryption key stored on disk (OS keychain unavailable). Credentials are encrypted but the key is accessible to anyone with file access.')
}
const cashuTokenStore = config.cashuTokensPath ? new CashuTokenStore(config.cashuTokensPath) : undefined
if (cashuTokenStore) await cashuTokenStore.init()
const challengeCache = new ChallengeCache()
const spendTracker = new SpendTracker()

// Wallet providers (priority order: NWC > Cashu > human)
const walletProviders: WalletProvider[] = []

if (config.nwcUri) {
  walletProviders.push(createNwcWallet(config.nwcUri))
}

// Shared lock for all Cashu token store operations (melt + xcashu)
// Prevents concurrent token consumption races.
let cashuLock: Promise<unknown> = Promise.resolve()
function withCashuLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = cashuLock.catch(() => {}).then(() => fn())
  cashuLock = result.catch(() => {})
  return result
}

if (cashuTokenStore) {
  walletProviders.push(createCashuWallet(cashuTokenStore, withCashuLock))
}

// QR generation for human-in-the-loop (text for terminals, PNG for GUI clients)
async function generateQr(invoice: string): Promise<{ png: string; text: string }> {
  const QRCode = await import('qrcode')
  const upper = invoice.toUpperCase()
  const [png, text] = await Promise.all([
    QRCode.toDataURL(upper, { type: 'image/png', margin: 2 }),
    QRCode.toString(upper, { type: 'terminal', small: true, margin: 2, errorCorrectionLevel: 'L' }),
  ])
  return { png, text }
}

walletProviders.push(createHumanWallet({
  initialIntervalS: config.humanPayPollS,
  maxIntervalS: 30,
  timeoutS: config.humanPayTimeoutS,
  fetchFn: resilientFetch,
}))

// Helper: resolve wallet with optional method override
function getWallet(method?: WalletMethod): WalletProvider | undefined {
  return resolveWallet(walletProviders, method)
}

// Helper: pay an invoice using wallet priority
async function payInvoice(
  invoice: string,
  options?: { serverOrigin?: string; method?: WalletMethod },
): Promise<{ paid: boolean; preimage?: string; method: string }> {
  const wallet = getWallet(options?.method)
  if (!wallet) return { paid: false, method: 'none' }
  const result = await wallet.payInvoice(invoice, { serverOrigin: options?.serverOrigin })
  return { paid: result.paid, preimage: result.preimage, method: result.method }
}

// Helper: store credential — validates preimage and macaroon to prevent credential poisoning
const HEX_RE = /^[0-9a-fA-F]+$/
const MACAROON_RE = /^[A-Za-z0-9+/_\-=]+$/
function storeCredential(origin: string, macaroon: string, preimage: string, paymentHash: string, server: 'toll-booth' | null = null): boolean {
  const safeOrigin = (() => { try { return new URL(origin).hostname } catch { return '(invalid)' } })()
  if (!preimage || typeof preimage !== 'string' || preimage.length === 0) {
    console.error(`[402-mcp] Refusing to store credential for ${safeOrigin}: missing or empty preimage`)
    return false
  }
  // Preimage is sent in Authorization headers — must be valid hex to prevent injection
  if (!HEX_RE.test(preimage)) {
    console.error(`[402-mcp] Refusing to store credential for ${safeOrigin}: preimage contains non-hex characters`)
    return false
  }
  // SHA-256 preimage must be exactly 32 bytes (64 hex chars)
  if (preimage.length !== 64) {
    console.error(`[402-mcp] Refusing to store credential for ${safeOrigin}: preimage length ${preimage.length} (expected 64 hex chars)`)
    return false
  }
  // Macaroon is also sent in Authorization headers — restrict to base64-safe characters
  if (!macaroon || !MACAROON_RE.test(macaroon)) {
    console.error(`[402-mcp] Refusing to store credential for ${safeOrigin}: macaroon contains invalid characters`)
    return false
  }
  credentialStore.set(origin, {
    macaroon,
    preimage,
    paymentHash,
    creditBalance: null,
    storedAt: new Date().toISOString(),
    lastUsed: new Date().toISOString(),
    server,
  })
  return true
}

// Create MCP server
const server = new McpServer({
  name: '402-mcp',
  version,
  description: 'Payment network for paid APIs and services. Discovers services via Nostr (kind 31402), handles Lightning payments automatically. When a user asks for something that might be a paid service — jokes, data, content, AI, weather — use l402-search to find it, then l402-fetch (autoPay: true) to access it. If human payment is needed, show the payment URL, call l402-pay to poll for confirmation, then retry. The user never needs to know about L402 or payment details.',
}, {
  instructions: 'Call l402-config first to check wallet capabilities and spend limits. Use l402-search to discover paid services on Nostr before calling l402-fetch. When l402-fetch returns payment_required, either set autoPay: true to pay automatically (if within budget) or show the payment URL to the user. Call l402-discover to probe pricing before committing to a paid request. Use l402-credentials to check stored credentials before re-paying for a service.',
})

// Register all tools
registerConfigTool(server, () => ({
  nwcConfigured: !!config.nwcUri,
  cashuConfigured: !!cashuTokenStore && cashuTokenStore.totalBalance() > 0,
  cashuBalanceSats: cashuTokenStore?.totalBalance() ?? 0,
  maxAutoPaySats: config.maxAutoPaySats,
  credentialCount: credentialStore.count(),
}))

registerDiscoverTool(server, {
  fetchFn: resilientFetch,
  cache: challengeCache,
  decodeBolt11,
})

registerFetchTool(server, {
  credentialStore,
  fetchFn: resilientFetch,
  transportFetch: (urls, init) =>
    withTransportFallback(
      selectTransports(urls, config.transportPreference, { hasTorProxy: !!config.torProxy }),
      init,
      resilientFetch,
    ),
  payInvoice,
  maxAutoPaySats: config.maxAutoPaySats,
  maxSpendPerMinuteSats: config.maxSpendPerMinuteSats,
  spendTracker,
  parseL402: parseL402Challenge,
  decodeBolt11,
  detectServer,
  challengeCache,
  generateQr,
  walletMethod: () => getWallet()?.method,
  isX402: isX402Challenge,
  parseX402: parseX402Challenge,
  formatX402: formatX402PaymentRequest,
  isXCashu: isXCashuChallenge,
  parseXCashu: parseXCashuChallenge,
  payXCashu: cashuTokenStore
    ? (challenge) => withCashuLock(() => attemptXCashuPayment({ challenge, tokenStore: cashuTokenStore }))
    : async () => null,
  isIETFPayment: isIETFPaymentChallenge,
  parseIETFPayment: parseIETFPaymentChallenge,
  buildIETFCredential: buildIETFPaymentCredential,
})

registerPayTool(server, {
  cache: challengeCache,
  resolveWallet: getWallet,
  storeCredential,
  maxAutoPaySats: config.maxAutoPaySats,
  maxSpendPerMinuteSats: config.maxSpendPerMinuteSats,
  spendTracker,
  decodeBolt11,
  fetchFn: resilientFetch,
})

registerCredentialsTool(server, credentialStore)
registerBalanceTool(server, credentialStore)
registerStoreTokenTool(server, {
  storeCredential,
})

registerBuyCreditsTool(server, {
  fetchFn: resilientFetch,
  payInvoice,
  storeCredential: (origin, macaroon, preimage, paymentHash) =>
    storeCredential(origin, macaroon, preimage, paymentHash, 'toll-booth'),
  decodeBolt11,
  maxAutoPaySats: config.maxAutoPaySats,
  maxSpendPerMinuteSats: config.maxSpendPerMinuteSats,
  spendTracker,
  generateQr,
  walletMethod: () => getWallet()?.method,
})

registerRedeemCashuTool(server, {
  fetchFn: resilientFetch,
  storeCredential: (origin, macaroon, preimage, paymentHash) =>
    storeCredential(origin, macaroon, preimage, paymentHash, 'toll-booth'),
  removeToken: (tokenStr) => cashuTokenStore?.remove(tokenStr),
  decodeToken: (token: string) => {
    // Lazy-import cashu-ts to avoid top-level await; decode is synchronous
    const { getDecodedToken } = require('@cashu/cashu-ts') as { getDecodedToken: (token: string) => { proofs: Array<{ amount: number }> } }
    return getDecodedToken(token)
  },
  maxAutoPaySats: config.maxAutoPaySats,
  maxSpendPerMinuteSats: config.maxSpendPerMinuteSats,
  spendTracker,
})

registerSearchTool(server, { subscribeEvents: createNostrSubscriber(config.ssrfAllowPrivate) })

// Register fetch-preview (read-only, no spend capability)
registerFetchPreviewTool(server, {
  fetchFn: resilientFetch,
  challengeCache,
  decodeBolt11,
  parseL402: parseL402Challenge,
  isX402: isX402Challenge,
  parseX402: parseX402Challenge,
  isXCashu: isXCashuChallenge,
  parseXCashu: parseXCashuChallenge,
  isIETFPayment: isIETFPaymentChallenge,
  parseIETFPayment: parseIETFPaymentChallenge,
  walletMethod: () => getWallet()?.method,
})

// Widget registration (graceful if widgets not built)
try {
  const { registerWidgets } = await import('./tools/register-widgets.js')
  registerWidgets(server)
} catch (e) {
  console.error('Widget registration skipped (build widgets first):', (e as Error).message)
}

// Start transport
if (config.transport === 'http') {
  const { default: express } = await import('express')
  const { default: cors } = await import('cors')
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  )

  const app = express()
  app.set('trust proxy', false) // Prevent X-Forwarded-For spoofing of rate limiter
  app.use(cors({ origin: config.corsOrigin }))
  app.use(express.json({ limit: '100kb' }))

  // Security headers — defence in depth for HTTP transport
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
    next()
  })

  // Simple sliding-window rate limiter (100 requests per 60s per IP)
  const RATE_WINDOW_MS = 60_000
  const RATE_MAX = 100
  const RATE_MAX_BUCKETS = 10_000
  const rateBuckets = new Map<string, number[]>()

  app.use((req, res, next) => {
    const ip = req.ip ?? 'unknown'
    const now = Date.now()
    const cutoff = now - RATE_WINDOW_MS
    const timestamps = (rateBuckets.get(ip) ?? []).filter(t => t > cutoff)
    if (timestamps.length >= RATE_MAX) {
      res.status(429).json({ error: 'Too many requests' })
      return
    }
    // Cap total tracked IPs to prevent memory exhaustion from IP cycling
    if (!rateBuckets.has(ip) && rateBuckets.size >= RATE_MAX_BUCKETS) {
      res.status(429).json({ error: 'Too many requests' })
      return
    }
    timestamps.push(now)
    rateBuckets.set(ip, timestamps)
    next()
  })

  // Evict stale rate-limit buckets every 60s to prevent memory leak
  const rateBucketCleanup = setInterval(() => {
    const cutoff = Date.now() - RATE_WINDOW_MS
    for (const [ip, timestamps] of rateBuckets) {
      if (timestamps.every(t => t <= cutoff)) {
        rateBuckets.delete(ip)
      }
    }
  }, RATE_WINDOW_MS)
  rateBucketCleanup.unref()

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      server: '402-mcp',
      version,
    })
  })

  const transport = new StreamableHTTPServerTransport({})

  await server.connect(transport)

  app.post('/mcp', async (req, res) => {
    await transport.handleRequest(req, res, req.body)
  })

  const httpServer = app.listen(config.port, config.bindAddress, () => {
    console.error(`402-mcp HTTP server listening on ${config.bindAddress}:${config.port}`)
    console.error('Warning: HTTP transport is intended for local/trusted networks only. For public exposure, use a reverse proxy with TLS, rate limiting, and authentication.')
  })

  const shutdown = async () => {
    clearInterval(rateBucketCleanup)
    console.error('Shutting down gracefully…')
    await server.close()
    httpServer.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 5000).unref()
  }
  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
} else {
  const { StdioServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/stdio.js'
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)

  console.error('402-mcp server running on stdio')
}
