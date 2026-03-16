import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CredentialStore } from '../store/credentials.js'
import type { L402Challenge } from '../l402/parse.js'
import type { DecodedInvoice } from '../l402/bolt11.js'
import type { ServerInfo } from '../l402/detect.js'
import type { ResilientFetchOptions } from '../fetch/resilient-fetch.js'
import type { SpendTracker } from '../spend-tracker.js'
import type { ChallengeCache } from '../l402/challenge-cache.js'
import type { WalletMethod } from '../wallet/types.js'
import { safeErrorMessage } from './safe-error.js'
import { filterResponseHeaders } from './safe-headers.js'

const HEX_RE = /^[0-9a-fA-F]+$/
const MACAROON_RE = /^[A-Za-z0-9+/_\-=]+$/

/** Headers that must not be set by the caller (hop-by-hop). */
const BLOCKED_HEADERS = new Set([
  'host', 'transfer-encoding', 'connection', 'upgrade',
  'proxy-authorization', 'te', 'trailer',
])

export interface FetchDeps {
  credentialStore: CredentialStore
  fetchFn: (url: string | URL, init?: RequestInit, options?: ResilientFetchOptions) => Promise<Response>
  /** Fetch with transport selection and fallback. Called with multiple URLs (from search results). */
  transportFetch: (urls: string[], init: RequestInit) => Promise<Response>
  payInvoice: (invoice: string, options?: { serverOrigin?: string }) => Promise<{ paid: boolean; preimage?: string; method: string }>
  maxAutoPaySats: number
  maxSpendPerMinuteSats: number
  spendTracker: SpendTracker
  parseL402: (header: string) => L402Challenge | null
  decodeBolt11: (invoice: string) => DecodedInvoice
  detectServer: (headers: Headers, body: unknown) => ServerInfo
  challengeCache: ChallengeCache
  generateQr: (invoice: string) => Promise<{ png: string; text: string }>
  walletMethod: () => WalletMethod | undefined
}

function parseBalance(value: string | null): number | null {
  if (value === null) return null
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/** Makes an HTTP request with automatic L402 payment and credential reuse. Pays the invoice if within budget, stores the credential, and retries. */
export async function handleFetch(
  args: { url: string; urls?: string[]; method?: string; headers?: Record<string, string>; body?: string; autoPay?: boolean; pubkey?: string },
  deps: FetchDeps,
) {
  // When multiple URLs are provided (from l402_search results), use transport fallback.
  // The first URL in `urls` is also the primary URL for identity, origin, and payment.
  const primaryUrl = args.urls?.length ? args.urls[0] : args.url
  const origin = new URL(primaryUrl).origin
  // When a pubkey is provided (from search results) use it as the credential key so
  // credentials are shared across all transport URLs for the same service.
  // For direct URL calls without a pubkey, fall back to origin-based keying.
  const credKey = args.pubkey ?? origin
  const cred = deps.credentialStore.get(credKey)
  const reqHeaders: Record<string, string> = {}
  // Copy user headers, stripping dangerous hop-by-hop/security-sensitive ones
  if (args.headers) {
    for (const [k, v] of Object.entries(args.headers)) {
      if (!BLOCKED_HEADERS.has(k.toLowerCase())) {
        reqHeaders[k] = v
      }
    }
  }

  // Step 1-2: Use stored credentials if available
  if (cred) {
    reqHeaders['Authorization'] = `L402 ${cred.macaroon}:${cred.preimage}`
    deps.credentialStore.updateLastUsed(credKey)
  }

  // Build a unified fetch helper: multi-URL (transport fallback) or single-URL
  const doFetch = (url: string, init: RequestInit) => {
    const allUrls = args.urls?.length ? args.urls : [url]
    if (allUrls.length > 1) {
      return deps.transportFetch(allUrls, init)
    }
    return deps.fetchFn(url, init)
  }

  try {
    const response = await doFetch(primaryUrl, {
      method: args.method ?? 'GET',
      headers: reqHeaders,
      body: args.body,
    })

    // Success - update balance and return
    if (response.status !== 402) {
      const balance = parseBalance(response.headers.get('x-credit-balance'))
      if (balance !== null) {
        deps.credentialStore.updateBalance(credKey, balance)
      }

      const body = await response.text()
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: response.status,
            headers: filterResponseHeaders(response.headers),
            body,
            creditsRemaining: balance,
            satsPaid: 0,
          }, null, 2),
        }],
      }
    }

    // 402 response - parse the challenge
    const authHeader = response.headers.get('www-authenticate') ?? ''
    const challenge = deps.parseL402(authHeader)

    let challengeBody: Record<string, unknown> = {}
    try { challengeBody = await response.json() as Record<string, unknown> } catch {}

    const decoded = challenge ? deps.decodeBolt11(challenge.invoice) : { costSats: null, paymentHash: null, expiry: 3600 }
    const serverInfo = deps.detectServer(response.headers, challengeBody)

    // Extract payment page URL and pricing tiers from toll-booth response body
    const l402Body = challengeBody.l402 as Record<string, unknown> | undefined
    const paymentPath = typeof l402Body?.payment_url === 'string' ? l402Body.payment_url : undefined
    const tiers = challengeBody.tiers ?? challengeBody.credit_tiers ?? undefined

    // Step 3: Credits exhausted (had credentials but got 402)
    const creditsExhausted = !!cred

    // Delete stale credential so next request doesn't send it again
    if (creditsExhausted) {
      deps.credentialStore.delete(credKey)
    }

    // Step 4: Auto-pay if within budget
    const autoPay = args.autoPay ?? false
    const isHumanWallet = deps.walletMethod() === 'human'
    // Only attempt spend tracking when auto-pay would actually proceed,
    // otherwise tryRecord inflates the spend tracker and blocks legitimate payments.
    // For human wallets, allow re-purchase even when credits are exhausted —
    // the human decides whether to pay by scanning the QR code.
    const shouldAttemptPay = (!creditsExhausted || isHumanWallet) && autoPay && challenge && decoded.costSats !== null && decoded.costSats <= deps.maxAutoPaySats
    // Use tryRecord as the authoritative gate — atomically checks AND records
    // the spend before payment, closing the TOCTOU gap between check and pay.
    const withinSpendLimit = shouldAttemptPay && deps.spendTracker.tryRecord(decoded.costSats!, deps.maxSpendPerMinuteSats)
    if (shouldAttemptPay && withinSpendLimit) {
      // For human wallet, return QR immediately instead of blocking on poll
      if (deps.walletMethod() === 'human' && challenge && decoded.paymentHash) {
        // Roll back the spend tracking — human hasn't paid yet
        deps.spendTracker.unrecord(decoded.costSats!)

        const fullPaymentUrl = paymentPath ? `${origin}${paymentPath}` : undefined

        deps.challengeCache.set({
          invoice: challenge.invoice,
          macaroon: challenge.macaroon,
          paymentHash: decoded.paymentHash,
          costSats: decoded.costSats,
          expiresAt: Date.now() + decoded.expiry * 1000,
          url: args.url,
          paymentUrl: fullPaymentUrl,
        })

        // If toll-booth payment page is available, direct the user there
        // (better UX: proper QR, auto-polling, WebLN support, shows preimage when paid)
        if (fullPaymentUrl) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                status: 402,
                costSats: decoded.costSats,
                paymentHash: decoded.paymentHash,
                paymentUrl: fullPaymentUrl,
                ...(tiers ? { tiers } : {}),
                message: `Payment required: ${decoded.costSats} sats. Open the URL to pay, then call l402_pay with paymentHash "${decoded.paymentHash}" to confirm and retry.`,
              }, null, 2),
            }],
          }
        }

        // Fallback: no payment page — show QR in terminal
        let qrText: string | undefined
        let qrPngBase64: string | undefined
        try {
          const qr = await deps.generateQr(challenge.invoice)
          qrText = qr.text
          qrPngBase64 = qr.png.replace(/^data:image\/png;base64,/, '')
        } catch {
          // QR generation failed — text-only response still has the invoice
        }

        const json = JSON.stringify({
          status: 402,
          costSats: decoded.costSats,
          invoice: challenge.invoice,
          paymentHash: decoded.paymentHash,
          message: `Payment required: ${decoded.costSats} sats. Scan the QR to pay, then call l402_pay with paymentHash "${decoded.paymentHash}" to confirm and retry.`,
        }, null, 2)

        // Combine QR + JSON in one text block so terminals render the QR with newlines
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [{
          type: 'text' as const,
          text: qrText ? `${qrText}\n\n${json}` : json,
        }]

        if (qrPngBase64) {
          content.push({
            type: 'image' as const,
            data: qrPngBase64,
            mimeType: 'image/png',
          })
        }

        return { content }
      }

      const payResult = await deps.payInvoice(challenge.invoice, { serverOrigin: origin })

      // Roll back spend-limit reservation if payment failed
      if (!payResult.paid || !payResult.preimage) {
        deps.spendTracker.unrecord(decoded.costSats!)
      }

      if (payResult.paid && payResult.preimage) {
        // Validate preimage (hex) and macaroon (base64-safe) before storage
        // to prevent header injection via Authorization: L402 {macaroon}:{preimage}
        if (!HEX_RE.test(payResult.preimage) || payResult.preimage.length !== 64 || !MACAROON_RE.test(challenge.macaroon)) {
          deps.spendTracker.unrecord(decoded.costSats!)
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'Payment succeeded but credential contains invalid characters — refusing to store' }),
            }],
            isError: true as const,
          }
        }

        // Store credential and retry
        deps.credentialStore.set(credKey, {
          macaroon: challenge.macaroon,
          preimage: payResult.preimage,
          paymentHash: decoded.paymentHash ?? '',
          creditBalance: null,
          storedAt: new Date().toISOString(),
          lastUsed: new Date().toISOString(),
          server: serverInfo.type === 'toll-booth' ? 'toll-booth' : null,
        })

        // Retry the request with new credentials (reuse filtered headers)
        const retryHeaders: Record<string, string> = { ...reqHeaders }
        retryHeaders['Authorization'] = `L402 ${challenge.macaroon}:${payResult.preimage}`

        const retryResponse = await doFetch(primaryUrl, {
          method: args.method ?? 'GET',
          headers: retryHeaders,
          body: args.body,
        })

        const retryBalance = parseBalance(retryResponse.headers.get('x-credit-balance'))
        if (retryBalance !== null) {
          deps.credentialStore.updateBalance(credKey, retryBalance)
        }

        const retryBody = await retryResponse.text()
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: retryResponse.status,
              headers: filterResponseHeaders(retryResponse.headers),
              body: retryBody,
              creditsRemaining: retryBalance,
              satsPaid: decoded.costSats,
            }, null, 2),
          }],
        }
      }
    }

    // Step 5: Return 402 challenge for agent decision
    const message = creditsExhausted
      ? `Insufficient credits for ${origin}${decoded.costSats !== null ? ` (this endpoint costs ${decoded.costSats} sats)` : ''}. Use l402_buy_credits to purchase more credits${tiers ? ' — tier options are included below' : ''}.`
      : !autoPay
        ? `Payment of ${decoded.costSats} sats required. autoPay disabled.`
        : decoded.costSats !== null && decoded.costSats > deps.maxAutoPaySats
          ? `Payment of ${decoded.costSats} sats required. Exceeds MAX_AUTO_PAY_SATS (${deps.maxAutoPaySats}).`
          : !withinSpendLimit
            ? 'Per-minute spend limit reached.'
            : `Payment of ${decoded.costSats} sats required.`
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 402,
          costSats: decoded.costSats,
          invoice: challenge?.invoice,
          paymentHash: decoded.paymentHash,
          creditsExhausted,
          ...(tiers ? { tiers } : {}),
          message,
        }, null, 2),
      }],
    }
  } catch (err) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: safeErrorMessage(err) }),
      }],
      isError: true as const,
    }
  }
}

/** Registers the l402_fetch tool with the MCP server. */
export function registerFetchTool(server: McpServer, deps: FetchDeps): void {
  server.registerTool(
    'l402_fetch',
    {
      description: 'Fetch a URL with automatic payment handling. Use this to access any paid API or service. Manages credentials, pays automatically when autoPay is true and cost is within budget, and retries. For human wallets, returns a payment page URL or QR code. Set autoPay to true for seamless access. When a 402 is returned with tiers, present the pricing options to the user and use l402_buy_credits to purchase their chosen tier.',
      inputSchema: {
        url: z.url().describe('The primary URL to request. When using search results, pass the first URL here and all URLs in the urls field.'),
        urls: z.array(z.url()).max(10).optional().describe('All transport URLs from l402_search results (clearnet, onion, HNS). When present, transports are tried in preference order with automatic fallback on connection failure.'),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).optional().default('GET').describe('HTTP method'),
        headers: z.record(z.string().max(1000), z.string().max(8000)).optional().describe('Additional request headers'),
        body: z.string().max(1_000_000).optional().describe('Request body (for POST/PUT)'),
        autoPay: z.boolean().optional().default(false).describe('Automatically pay if within MAX_AUTO_PAY_SATS budget'),
        pubkey: z.string().max(128).optional().describe('Service pubkey from l402_search results — used to share credentials across all transport URLs for the same service'),
      },
    },
    async (args) => handleFetch(args, deps),
  )
}
