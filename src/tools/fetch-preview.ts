import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import type { ChallengeCache } from '../l402/challenge-cache.js'
import type { L402Challenge } from '../l402/parse.js'
import type { X402Challenge } from '../x402/parse.js'
import type { XCashuChallenge } from '../xcashu/parse.js'
import type { IETFPaymentChallenge } from '../ietf-payment/parse.js'
import type { ResilientFetchOptions } from '../fetch/resilient-fetch.js'
import type { WalletMethod } from '../wallet/types.js'
import { safeErrorMessage } from './safe-error.js'

/**
 * SAFETY INVARIANT: This deps interface intentionally omits spendTracker,
 * payInvoice, credentialStore, and all spending capabilities.
 * It is architecturally impossible for the preview handler to spend money.
 */
export interface FetchPreviewDeps {
  fetchFn: (url: string | URL, init?: RequestInit, options?: ResilientFetchOptions) => Promise<Response>
  challengeCache: ChallengeCache
  decodeBolt11: (invoice: string) => { paymentHash: string | null; costSats: number | null; expiry: number }
  parseL402: (header: string) => L402Challenge | null
  isX402: (headers: Headers) => boolean
  parseX402: (body: unknown) => X402Challenge | null
  isXCashu: (headers: Headers) => boolean
  parseXCashu: (header: string) => XCashuChallenge | null
  isIETFPayment: (headers: Headers) => boolean
  parseIETFPayment: (header: string) => IETFPaymentChallenge | null
  walletMethod: () => WalletMethod | undefined
}

/** Blocked hop-by-hop headers that must not be forwarded. */
const BLOCKED_HEADERS = new Set([
  'host', 'transfer-encoding', 'connection', 'upgrade',
  'proxy-authorization', 'te', 'trailer',
])

/**
 * Sends an unauthenticated request to preview payment requirements.
 * Returns structured data suitable for a payment confirmation widget.
 *
 * NEVER pays or spends anything -- read-only by construction.
 */
export async function handleFetchPreview(
  args: { url: string; urls?: string[]; method?: string; headers?: Record<string, string>; pubkey?: string },
  deps: FetchPreviewDeps,
) {
  const urls = args.urls?.length ? args.urls : [args.url]

  try {
    const results = await Promise.all(urls.map(async (url) => {
      const reqHeaders: Record<string, string> = {}
      if (args.headers) {
        for (const [k, v] of Object.entries(args.headers)) {
          if (!BLOCKED_HEADERS.has(k.toLowerCase())) {
            reqHeaders[k] = v
          }
        }
      }

      const response = await deps.fetchFn(url, {
        method: args.method ?? 'GET',
        headers: reqHeaders,
      })

      // No payment required -- freely accessible
      if (response.status !== 402) {
        return {
          status: 'free' as const,
          endpoint: url,
          statusCode: response.status,
          message: 'No payment required.',
        }
      }

      // 402 response -- determine the challenge type
      let challengeBody: Record<string, unknown> = {}
      try { challengeBody = await response.json() as Record<string, unknown> } catch { /* non-JSON 402 body */ }

      const wwwAuth = response.headers.get('www-authenticate') ?? ''

      // Priority: L402 > IETF Payment > xcashu > x402
      // (L402 is the most common in our ecosystem)

      // Try IETF Payment first (newer standard)
      if (deps.isIETFPayment(response.headers)) {
        const ietf = deps.parseIETFPayment(wwwAuth)
        if (ietf?.invoice && ietf.amountSats && ietf.paymentHash) {
          const expiresAt = ietf.expires
            ? new Date(ietf.expires).getTime()
            : Date.now() + 3600_000

          return {
            status: 'preview' as const,
            endpoint: url,
            protocol: 'ietf-payment',
            costSats: ietf.amountSats,
            paymentMethod: deps.walletMethod() ?? 'none',
            paymentHash: ietf.paymentHash,
            expiresAt,
            realm: ietf.realm,
            intent: ietf.intent,
            widgetHint: 'payment-confirmation',
            message: `Payment of ${ietf.amountSats} sats required to access ${new URL(url).hostname}. Confirm to proceed.`,
          }
        }
      }

      // Try L402
      const l402 = deps.parseL402(wwwAuth)
      if (l402) {
        const decoded = deps.decodeBolt11(l402.invoice)

        // Cache challenge for the confirm step (l402-fetch reuses this)
        if (decoded.paymentHash) {
          deps.challengeCache.set({
            invoice: l402.invoice,
            macaroon: l402.macaroon,
            paymentHash: decoded.paymentHash,
            costSats: decoded.costSats,
            expiresAt: Date.now() + decoded.expiry * 1000,
            url,
          })
        }

        return {
          status: 'preview' as const,
          endpoint: url,
          protocol: 'l402',
          costSats: decoded.costSats,
          paymentMethod: deps.walletMethod() ?? 'none',
          paymentHash: decoded.paymentHash,
          expiresAt: decoded.paymentHash ? Date.now() + decoded.expiry * 1000 : undefined,
          widgetHint: 'payment-confirmation',
          message: decoded.costSats !== null
            ? `Payment of ${decoded.costSats} sats required to access ${new URL(url).hostname}. Confirm to proceed.`
            : `Payment required to access ${new URL(url).hostname}. Amount unknown.`,
        }
      }

      // Try xcashu
      const xcashuHeader = response.headers.get('x-cashu')
      if (xcashuHeader && deps.isXCashu(response.headers)) {
        const xcashu = deps.parseXCashu(xcashuHeader)
        if (xcashu) {
          return {
            status: 'preview' as const,
            endpoint: url,
            protocol: 'xcashu',
            costSats: xcashu.amount,
            paymentMethod: deps.walletMethod() ?? 'none',
            widgetHint: 'payment-confirmation',
            message: `Payment of ${xcashu.amount} sats required to access ${new URL(url).hostname}. Confirm to proceed.`,
          }
        }
      }

      // Try x402
      if (deps.isX402(response.headers)) {
        const x402 = deps.parseX402(challengeBody)
        if (x402) {
          return {
            status: 'preview' as const,
            endpoint: url,
            protocol: 'x402',
            costUsd: x402.amountUsd,
            receiver: x402.receiver,
            network: x402.network,
            asset: x402.asset,
            widgetHint: 'payment-confirmation',
            message: `Payment of $${x402.amountUsd.toFixed(2)} ${x402.asset.toUpperCase()} required on ${x402.network}. Confirm to proceed.`,
          }
        }
      }

      // 402 but no recognised challenge
      return {
        status: 'error' as const,
        endpoint: url,
        statusCode: 402,
        message: 'Server returned 402 but no recognised payment challenge was found.',
      }
    }))

    // Single URL: return flat object. Batch: return array.
    const output = results.length === 1 ? results[0] : results

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(output, null, 2),
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

/** Registers the l402-fetch-preview tool with the MCP server. */
export function registerFetchPreviewTool(server: McpServer, deps: FetchPreviewDeps): void {
  registerAppTool(
    server,
    'l402-fetch-preview',
    {
      description: 'Preview payment requirements for a URL without spending any sats. Returns cost, protocol, and payment method so a confirmation dialog can be shown. Use this before l402-fetch to give the user a chance to approve or cancel payment. For widget hosts, the result drives a payment confirmation dialog.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        url: z.url().describe('URL to preview payment requirements for'),
        urls: z.array(z.url()).max(10).optional().describe('Batch: multiple URLs to preview'),
        method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']).optional().default('GET').describe('HTTP method'),
        headers: z.record(z.string().max(1000), z.string().max(8000)).optional().describe('Additional request headers'),
        pubkey: z.string().max(128).optional().describe('Nostr pubkey for xcashu auth'),
      },
      _meta: {
        ui: { resourceUri: 'ui://402-mcp/payment-confirmation.html' },
      },
    },
    async (args) => handleFetchPreview(args, deps),
  )
}
