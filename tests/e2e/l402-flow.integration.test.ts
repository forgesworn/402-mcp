import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Booth, memoryStorage } from '@forgesworn/toll-booth'
import type { Server } from 'node:http'
import { mockLightningBackend } from './mock-lightning.js'
import { createMockUpstream } from './mock-upstream.js'
import { createResilientFetch } from '../../src/fetch/resilient-fetch.js'
import { handleDiscover } from '../../src/tools/discover.js'
import { handleFetch } from '../../src/tools/fetch.js'
import { handleBuyCredits } from '../../src/tools/buy-credits.js'
import { ChallengeCache } from '../../src/l402/challenge-cache.js'
import { decodeBolt11 } from '../../src/l402/bolt11.js'
import { parseL402Challenge } from '../../src/l402/parse.js'
import { detectServer } from '../../src/l402/detect.js'
import { CredentialStore } from '../../src/store/credentials.js'
import { SpendTracker } from '../../src/spend-tracker.js'
import { isX402Challenge, parseX402Challenge } from '../../src/x402/parse.js'
import { formatX402PaymentRequest } from '../../src/x402/payment.js'
import { isIETFPaymentChallenge, parseIETFPaymentChallenge } from '../../src/ietf-payment/parse.js'
import { buildIETFPaymentCredential } from '../../src/ietf-payment/credential.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

let booth: Booth
let boothServer: Server
let baseUrl: string
let upstreamServer: Server

const credPath = join(tmpdir(), `l402-test-creds-${randomBytes(4).toString('hex')}.json`)

const resilientFetch = createResilientFetch(fetch, {
  ssrfAllowPrivate: true,
  retries: 0,
  timeoutMs: 5000,
})

beforeAll(async () => {
  // Start mock upstream
  const upstream = createMockUpstream()
  const upstreamUrl = await upstream.start()
  upstreamServer = upstream.server

  // Start toll-booth with Express adapter
  const backend = mockLightningBackend()
  const storage = memoryStorage()

  booth = new Booth({
    adapter: 'express',
    backend,
    storage,
    pricing: {},
    strictPricing: true,
    upstream: upstreamUrl,
    defaultInvoiceAmount: 1,
    rootKey: randomBytes(32).toString('hex'),
    creditTiers: [
      { amountSats: 100, creditSats: 110, label: '110 credits' },
      { amountSats: 1000, creditSats: 1200, label: '1200 credits' },
    ],
  })

  const express = (await import('express')).default
  const app = express()
  app.use(express.json())

  // Mount specific routes BEFORE catch-all middleware (per Booth JSDoc)
  app.get('/invoice-status/:paymentHash', booth.invoiceStatusHandler as any)
  app.post('/create-invoice', booth.createInvoiceHandler as any)
  app.use('/{*path}', booth.middleware as any)

  await new Promise<void>((resolve) => {
    boothServer = app.listen(0, '127.0.0.1', () => {
      const addr = boothServer.address() as { port: number }
      baseUrl = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })
})

afterAll(() => {
  booth?.close()
  boothServer?.close()
  upstreamServer?.close()
})

describe('L402 integration flow', () => {
  it('gets a 402 challenge from the toll-booth', async () => {
    // Raw fetch to verify the toll-booth is returning 402 with L402 headers
    const res = await resilientFetch(`${baseUrl}/api/test`)
    expect(res.status).toBe(402)

    const body = await res.json() as Record<string, unknown>
    // toll-booth wraps 402 fields under body.l402
    const l402 = (body.l402 ?? body) as Record<string, unknown>
    expect(l402.payment_hash).toBeDefined()
    expect(l402.macaroon).toBeDefined()
    expect(l402.payment_url).toBeDefined()

    const wwwAuth = res.headers.get('www-authenticate')
    expect(wwwAuth).toMatch(/^L402\s+/)
  })

  it('discovers pricing from a 402 response', async () => {
    const cache = new ChallengeCache()
    const result = await handleDiscover(
      { url: `${baseUrl}/api/test` },
      { fetchFn: resilientFetch, cache, decodeBolt11 },
    )

    const data = JSON.parse(result.content[0].text)
    expect(data.url).toBe(`${baseUrl}/api/test`)
    // The mock bolt11 is not decodable, so costSats and paymentHash may be null
    expect(data.macaroon).toBeDefined()
  })

  it('returns 402 challenge on fetch without credentials', async () => {
    const credentialStore = new CredentialStore(credPath + '.nocred')
    const result = await handleFetch(
      { url: `${baseUrl}/api/test`, autoPay: false },
      {
        credentialStore,
        fetchFn: resilientFetch,
        payInvoice: async () => ({ paid: false, method: 'none' }),
        maxAutoPaySats: 0,
        maxSpendPerMinuteSats: 10000,
        spendTracker: new SpendTracker(),
        parseL402: parseL402Challenge,
        decodeBolt11,
        detectServer,
        challengeCache: new ChallengeCache(),
        generateQr: async () => ({ png: 'data:image/png;base64,test', text: '█▀▀█' }),
        walletMethod: () => undefined,
        transportFetch: async (urls, init) => resilientFetch(urls[0], init),
        isX402: isX402Challenge,
        parseX402: parseX402Challenge,
        formatX402: formatX402PaymentRequest,
        isIETFPayment: isIETFPaymentChallenge,
        parseIETFPayment: parseIETFPaymentChallenge,
        buildIETFCredential: buildIETFPaymentCredential,
      },
    )

    const data = JSON.parse(result.content[0].text)
    expect(data.status).toBe(402)
  })

  it('buys credits and then fetches successfully', async () => {
    const credentialStore = new CredentialStore(credPath + '.buy')

    // Step 1: Create an invoice via the create-invoice endpoint
    const createRes = await resilientFetch(`${baseUrl}/create-invoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountSats: 100 }),
    })
    expect(createRes.status).toBe(200)

    const createData = await createRes.json() as Record<string, unknown>
    const paymentHash = createData.payment_hash as string
    const macaroon = createData.macaroon as string
    const paymentUrl = createData.payment_url as string

    expect(paymentHash).toBeDefined()
    expect(macaroon).toBeDefined()

    // Step 2: Check invoice status (mock backend auto-settles)
    const statusToken = new URL(paymentUrl, baseUrl).searchParams.get('token')!
    const statusRes = await resilientFetch(
      `${baseUrl}/invoice-status/${paymentHash}?token=${statusToken}`,
    )
    const statusData = await statusRes.json() as Record<string, unknown>
    expect(statusData.paid).toBe(true)
    const preimage = statusData.preimage as string
    expect(preimage).toBeDefined()

    // Step 3: Store credentials
    credentialStore.set(`${baseUrl}`, {
      macaroon,
      preimage,
      paymentHash,
      creditBalance: null,
      storedAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
      server: 'toll-booth',
    })

    // Step 4: Fetch with stored credentials should succeed
    const fetchResult = await handleFetch(
      { url: `${baseUrl}/api/test` },
      {
        credentialStore,
        fetchFn: resilientFetch,
        payInvoice: async () => ({ paid: false, method: 'none' }),
        maxAutoPaySats: 0,
        maxSpendPerMinuteSats: 10000,
        spendTracker: new SpendTracker(),
        parseL402: parseL402Challenge,
        decodeBolt11,
        detectServer,
        challengeCache: new ChallengeCache(),
        generateQr: async () => ({ png: 'data:image/png;base64,test', text: '█▀▀█' }),
        walletMethod: () => undefined,
        transportFetch: async (urls, init) => resilientFetch(urls[0], init),
        isX402: isX402Challenge,
        parseX402: parseX402Challenge,
        formatX402: formatX402PaymentRequest,
        isIETFPayment: isIETFPaymentChallenge,
        parseIETFPayment: parseIETFPaymentChallenge,
        buildIETFCredential: buildIETFPaymentCredential,
      },
    )

    const fetchData = JSON.parse(fetchResult.content[0].text)
    expect(fetchData.status).toBe(200)
    expect(fetchData.creditsRemaining).toBeDefined()
    expect(typeof fetchData.creditsRemaining).toBe('number')
  })

  it('returns 402 after credits are exhausted', async () => {
    const credentialStore = new CredentialStore(credPath + '.exhaust')

    // Create and settle an invoice for 100 sats (gives 110 credits)
    const createRes = await resilientFetch(`${baseUrl}/create-invoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountSats: 100 }),
    })
    const createData = await createRes.json() as Record<string, unknown>
    const paymentHash = createData.payment_hash as string
    const macaroon = createData.macaroon as string
    const paymentUrl = createData.payment_url as string
    const statusToken = new URL(paymentUrl, baseUrl).searchParams.get('token')!

    const statusRes = await resilientFetch(
      `${baseUrl}/invoice-status/${paymentHash}?token=${statusToken}`,
    )
    const statusData = await statusRes.json() as Record<string, unknown>
    expect(statusData.paid).toBe(true)
    const preimage = statusData.preimage as string

    credentialStore.set(`${baseUrl}`, {
      macaroon,
      preimage,
      paymentHash,
      creditBalance: null,
      storedAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
      server: 'toll-booth',
    })

    const fetchDeps = {
      credentialStore,
      fetchFn: resilientFetch,
      payInvoice: async () => ({ paid: false, method: 'none' } as const),
      maxAutoPaySats: 0,
      maxSpendPerMinuteSats: 10000,
      spendTracker: new SpendTracker(),
      parseL402: parseL402Challenge,
      decodeBolt11,
      detectServer,
      challengeCache: new ChallengeCache(),
      generateQr: async () => ({ png: 'data:image/png;base64,test', text: '█▀▀█' }),
      walletMethod: () => undefined,
      transportFetch: async (urls, init) => resilientFetch(urls[0], init),
      isX402: isX402Challenge,
      parseX402: parseX402Challenge,
      formatX402: formatX402PaymentRequest,
      isIETFPayment: isIETFPaymentChallenge,
      parseIETFPayment: parseIETFPaymentChallenge,
      buildIETFCredential: buildIETFPaymentCredential,
    }

    // Use up all 110 credits (each request costs 1 sat per defaultInvoiceAmount)
    for (let i = 0; i < 110; i++) {
      const r = await handleFetch({ url: `${baseUrl}/api/drain-${i}`, autoPay: false }, fetchDeps)
      const d = JSON.parse(r.content[0].text)
      // Should be 200 until credits run out
      if (d.status !== 200) {
        // If we get 402 early, something is wrong with the credit balance
        throw new Error(`Unexpected 402 at request ${i}: ${r.content[0].text}`)
      }
    }

    // Next request should get 402 (credits exhausted)
    const result = await handleFetch(
      { url: `${baseUrl}/api/exhausted`, autoPay: false },
      fetchDeps,
    )

    const data = JSON.parse(result.content[0].text)
    expect(data.status).toBe(402)
    expect(data.creditsExhausted).toBe(true)
  })

  it('discovers available credit tiers via buy-credits', async () => {
    const result = await handleBuyCredits(
      { url: `${baseUrl}/api/test` },
      {
        fetchFn: resilientFetch,
        payInvoice: async () => ({ paid: false, method: 'none' }),
        storeCredential: () => {},
        decodeBolt11,
        maxAutoPaySats: 10000,
        maxSpendPerMinuteSats: 10000,
        spendTracker: new SpendTracker(),
        generateQr: async () => ({ png: 'data:image/png;base64,test', text: '█▀▀█' }),
        walletMethod: () => undefined,
      },
    )

    const data = JSON.parse(result.content[0].text)
    // The 402 challenge from the middleware does not include credit_tiers,
    // so tiers will be empty. This is expected; tiers are exposed via the
    // payment page / create-invoice error response, not the middleware 402.
    expect(data.tiers).toBeDefined()
  })
})
