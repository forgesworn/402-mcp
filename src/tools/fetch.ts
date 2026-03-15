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
  payInvoice: (invoice: string, options?: { serverOrigin?: string }) => Promise<{ paid: boolean; preimage?: string; method: string }>
  maxAutoPaySats: number
  maxSpendPerMinuteSats: number
  spendTracker: SpendTracker
  parseL402: (header: string) => L402Challenge | null
  decodeBolt11: (invoice: string) => DecodedInvoice
  detectServer: (headers: Headers, body: unknown) => ServerInfo
  challengeCache: ChallengeCache
  generateQr: (invoice: string) => Promise<string>
  walletMethod: () => WalletMethod | undefined
}

function parseBalance(value: string | null): number | null {
  if (value === null) return null
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/** Makes an HTTP request with automatic L402 payment and credential reuse. Pays the invoice if within budget, stores the credential, and retries. */
export async function handleFetch(
  args: { url: string; method?: string; headers?: Record<string, string>; body?: string; autoPay?: boolean },
  deps: FetchDeps,
) {
  const origin = new URL(args.url).origin
  const cred = deps.credentialStore.get(origin)
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
    deps.credentialStore.updateLastUsed(origin)
  }

  try {
    const response = await deps.fetchFn(args.url, {
      method: args.method ?? 'GET',
      headers: reqHeaders,
      body: args.body,
    })

    // Success - update balance and return
    if (response.status !== 402) {
      const balance = parseBalance(response.headers.get('x-credit-balance'))
      if (balance !== null) {
        deps.credentialStore.updateBalance(origin, balance)
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

    let challengeBody: unknown = {}
    try { challengeBody = await response.json() } catch {}

    const decoded = challenge ? deps.decodeBolt11(challenge.invoice) : { costSats: null, paymentHash: null, expiry: 3600 }
    const serverInfo = deps.detectServer(response.headers, challengeBody)

    // Step 3: Credits exhausted (had credentials but got 402)
    const creditsExhausted = !!cred

    // Delete stale credential so next request doesn't send it again
    if (creditsExhausted) {
      deps.credentialStore.delete(origin)
    }

    // Step 4: Auto-pay if within budget
    const autoPay = args.autoPay ?? false
    // Only attempt spend tracking when auto-pay would actually proceed,
    // otherwise tryRecord inflates the spend tracker and blocks legitimate payments.
    const shouldAttemptPay = !creditsExhausted && autoPay && challenge && decoded.costSats !== null && decoded.costSats <= deps.maxAutoPaySats
    // Use tryRecord as the authoritative gate — atomically checks AND records
    // the spend before payment, closing the TOCTOU gap between check and pay.
    const withinSpendLimit = shouldAttemptPay && deps.spendTracker.tryRecord(decoded.costSats!, deps.maxSpendPerMinuteSats)
    if (shouldAttemptPay && withinSpendLimit) {
      // For human wallet, return QR immediately instead of blocking on poll
      if (deps.walletMethod() === 'human' && challenge && decoded.paymentHash) {
        // Roll back the spend tracking — human hasn't paid yet
        deps.spendTracker.unrecord(decoded.costSats!)

        deps.challengeCache.set({
          invoice: challenge.invoice,
          macaroon: challenge.macaroon,
          paymentHash: decoded.paymentHash,
          costSats: decoded.costSats,
          expiresAt: Date.now() + decoded.expiry * 1000,
          url: args.url,
        })

        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [{
          type: 'text' as const,
          text: JSON.stringify({
            status: 402,
            costSats: decoded.costSats,
            invoice: challenge.invoice,
            paymentHash: decoded.paymentHash,
            message: `Scan QR to pay ${decoded.costSats} sats. After payment, call l402_pay with paymentHash "${decoded.paymentHash}" to complete.`,
          }, null, 2),
        }]

        try {
          const qrDataUri = await deps.generateQr(challenge.invoice)
          const base64 = qrDataUri.replace(/^data:image\/png;base64,/, '')
          content.push({
            type: 'image' as const,
            data: base64,
            mimeType: 'image/png',
          })
        } catch {
          // QR generation failed — text-only response still has the invoice
        }

        return { content, isError: true as const }
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
        deps.credentialStore.set(origin, {
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

        const retryResponse = await deps.fetchFn(args.url, {
          method: args.method ?? 'GET',
          headers: retryHeaders,
          body: args.body,
        })

        const retryBalance = parseBalance(retryResponse.headers.get('x-credit-balance'))
        if (retryBalance !== null) {
          deps.credentialStore.updateBalance(origin, retryBalance)
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
      ? `Stored credentials for ${origin} have no remaining credits. New payment required.`
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
      description: 'Make an HTTP request with L402 payment support. Uses stored credentials if available. If a 402 challenge is received and autoPay is true and cost is within MAX_AUTO_PAY_SATS, pays automatically and retries. autoPay defaults to false — set to true to enable automatic payments.',
      inputSchema: {
        url: z.url().describe('The URL to request'),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).optional().default('GET').describe('HTTP method'),
        headers: z.record(z.string().max(1000), z.string().max(8000)).optional().describe('Additional request headers'),
        body: z.string().max(1_000_000).optional().describe('Request body (for POST/PUT)'),
        autoPay: z.boolean().optional().default(false).describe('Automatically pay if within MAX_AUTO_PAY_SATS budget'),
      },
    },
    async (args) => handleFetch(args, deps),
  )
}
