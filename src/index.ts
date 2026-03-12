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
import { registerBalanceTool } from './tools/balance.js'
import { registerBuyCreditsTool } from './tools/buy-credits.js'
import { registerRedeemCashuTool } from './tools/redeem-cashu.js'
import { createResilientFetch } from './fetch/resilient-fetch.js'
import { SpendTracker } from './spend-tracker.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

const config = loadConfig()

const resilientFetch = createResilientFetch(fetch, {
  timeoutMs: config.fetchTimeoutMs,
  retries: config.fetchMaxRetries,
  maxResponseBytes: config.fetchMaxResponseBytes,
  ssrfAllowPrivate: config.ssrfAllowPrivate,
})

// Shared state
const credentialStore = new CredentialStore(config.credentialStorePath)
await credentialStore.init()
const cashuTokenStore = config.cashuTokensPath ? new CashuTokenStore(config.cashuTokensPath) : undefined
if (cashuTokenStore) await cashuTokenStore.init()
const challengeCache = new ChallengeCache()
const spendTracker = new SpendTracker()

// Wallet providers (priority order: NWC > Cashu > human)
const walletProviders: WalletProvider[] = []

if (config.nwcUri) {
  walletProviders.push(createNwcWallet(config.nwcUri))
}

if (cashuTokenStore) {
  walletProviders.push(createCashuWallet(cashuTokenStore))
}

// QR generation for human-in-the-loop
async function generateQr(invoice: string): Promise<string> {
  const QRCode = await import('qrcode')
  return QRCode.toDataURL(invoice.toUpperCase(), { type: 'image/png', margin: 2 })
}

walletProviders.push(createHumanWallet({
  initialIntervalS: config.humanPayPollS,
  maxIntervalS: 30,
  timeoutS: config.humanPayTimeoutS,
  generateQr,
  fetchFn: resilientFetch,
}))

// Helper: resolve wallet with optional method override
function getWallet(method?: WalletMethod): WalletProvider | undefined {
  return resolveWallet(walletProviders, method)
}

// Helper: pay an invoice using wallet priority
async function payInvoice(invoice: string, method?: WalletMethod): Promise<{ paid: boolean; preimage?: string; method: string }> {
  const wallet = getWallet(method)
  if (!wallet) return { paid: false, method: 'none' }
  const result = await wallet.payInvoice(invoice)
  return { paid: result.paid, preimage: result.preimage, method: result.method }
}

// Helper: store credential
function storeCredential(origin: string, macaroon: string, preimage: string, paymentHash: string, server: 'toll-booth' | null = null): void {
  credentialStore.set(origin, {
    macaroon,
    preimage,
    paymentHash,
    creditBalance: null,
    storedAt: new Date().toISOString(),
    lastUsed: new Date().toISOString(),
    server,
  })
}

// Create MCP server
const server = new McpServer({
  name: 'l402-mcp',
  version,
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
  payInvoice,
  maxAutoPaySats: config.maxAutoPaySats,
  maxSpendPerMinuteSats: config.maxSpendPerMinuteSats,
  spendTracker,
  parseL402: parseL402Challenge,
  decodeBolt11,
  detectServer,
})

registerPayTool(server, {
  cache: challengeCache,
  resolveWallet: getWallet,
  storeCredential,
  maxAutoPaySats: config.maxAutoPaySats,
  fetchFn: resilientFetch,
})

registerCredentialsTool(server, credentialStore)
registerBalanceTool(server, credentialStore)

registerBuyCreditsTool(server, {
  fetchFn: resilientFetch,
  payInvoice,
  storeCredential: (origin, macaroon, preimage, paymentHash) =>
    storeCredential(origin, macaroon, preimage, paymentHash, 'toll-booth'),
  decodeBolt11,
  maxSpendPerMinuteSats: config.maxSpendPerMinuteSats,
  spendTracker,
})

registerRedeemCashuTool(server, {
  fetchFn: resilientFetch,
  storeCredential: (origin, macaroon, preimage, paymentHash) =>
    storeCredential(origin, macaroon, preimage, paymentHash, 'toll-booth'),
  removeToken: (tokenStr) => cashuTokenStore?.remove(tokenStr),
})

// Start transport
if (config.transport === 'http') {
  const { default: express } = await import('express')
  const { default: cors } = await import('cors')
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  )

  const app = express()
  app.use(cors({ origin: config.corsOrigin }))
  app.use(express.json({ limit: '100kb' }))

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      server: 'l402-mcp',
      version,
      credentialCount: credentialStore.count(),
      cashuBalanceSats: cashuTokenStore?.totalBalance() ?? 0,
      nwcConfigured: !!config.nwcUri,
      uptime: process.uptime(),
    })
  })

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  })

  await server.connect(transport)

  app.post('/mcp', async (req, res) => {
    await transport.handleRequest(req, res, req.body)
  })

  const httpServer = app.listen(config.port, config.bindAddress, () => {
    console.error(`l402-mcp HTTP server listening on ${config.bindAddress}:${config.port}`)
    console.error('Warning: HTTP transport is intended for local/trusted networks only. For public exposure, use a reverse proxy with TLS, rate limiting, and authentication.')
  })

  const shutdown = async () => {
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

  console.error('l402-mcp server running on stdio')
}
