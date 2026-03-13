import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CredentialStore } from '../store/credentials.js'
import type { L402Challenge } from '../l402/parse.js'
import type { DecodedInvoice } from '../l402/bolt11.js'
import type { ServerInfo } from '../l402/detect.js'
import type { ResilientFetchOptions } from '../fetch/resilient-fetch.js'
import type { SpendTracker } from '../spend-tracker.js'
import { safeErrorMessage } from './safe-error.js'
import { filterResponseHeaders } from './safe-headers.js'

export interface FetchDeps {
  credentialStore: CredentialStore
  fetchFn: (url: string | URL, init?: RequestInit, options?: ResilientFetchOptions) => Promise<Response>
  payInvoice: (invoice: string) => Promise<{ paid: boolean; preimage?: string; method: string }>
  maxAutoPaySats: number
  maxSpendPerMinuteSats: number
  spendTracker: SpendTracker
  parseL402: (header: string) => L402Challenge | null
  decodeBolt11: (invoice: string) => DecodedInvoice
  detectServer: (headers: Headers, body: unknown) => ServerInfo
}

function parseBalance(value: string | null): number | null {
  if (value === null) return null
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

export async function handleFetch(
  args: { url: string; method?: string; headers?: Record<string, string>; body?: string; autoPay?: boolean },
  deps: FetchDeps,
) {
  const origin = new URL(args.url).origin
  const cred = deps.credentialStore.get(origin)
  const reqHeaders: Record<string, string> = { ...args.headers }

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
    const spendLimitHit = decoded.costSats !== null && deps.spendTracker.wouldExceed(decoded.costSats, deps.maxSpendPerMinuteSats)
    if (!creditsExhausted && autoPay && challenge && decoded.costSats !== null && decoded.costSats <= deps.maxAutoPaySats && !spendLimitHit) {
      const payResult = await deps.payInvoice(challenge.invoice)

      if (payResult.paid && payResult.preimage) {
        // Record spend atomically for rate limiting
        deps.spendTracker.tryRecord(decoded.costSats!, deps.maxSpendPerMinuteSats)

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

        // Retry the request with new credentials
        const retryHeaders: Record<string, string> = { ...args.headers }
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
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 402,
          costSats: decoded.costSats,
          invoice: challenge?.invoice,
          paymentHash: decoded.paymentHash,
          creditsExhausted,
          message: creditsExhausted
            ? `Stored credentials for ${origin} have no remaining credits. New payment required.`
            : spendLimitHit
              ? 'Per-minute spend limit reached.'
              : `Payment of ${decoded.costSats} sats required. ${!autoPay ? 'autoPay disabled.' : `Exceeds MAX_AUTO_PAY_SATS (${deps.maxAutoPaySats}).`}`,
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
