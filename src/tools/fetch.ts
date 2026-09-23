import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CredentialStore, StoredCredential } from '../store/credentials.js'
import type { L402Challenge } from '../l402/parse.js'
import type { DecodedInvoice } from '../l402/bolt11.js'
import type { ServerInfo } from '../l402/detect.js'
import type { ResilientFetchOptions } from '../fetch/resilient-fetch.js'
import type { SpendTracker } from '../spend-tracker.js'
import type { ChallengeCache } from '../l402/challenge-cache.js'
import type { WalletMethod } from '../wallet/types.js'
import type { X402Challenge } from '../x402/parse.js'
import type { XCashuChallenge } from '../xcashu/parse.js'
import type { LnurlcashChallenge } from '../xlnurlcash/parse.js'
import type { IETFPaymentChallenge } from '../ietf-payment/parse.js'
import type { PendingPayment } from '../store/pending-payments.js'
import { safeErrorMessage } from './safe-error.js'
import { filterResponseHeaders } from './safe-headers.js'
import { untrusted } from './untrusted.js'

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
  payInvoice: (invoice: string, options?: { serverOrigin?: string }) => Promise<{ paid: boolean; preimage?: string; method: string; outcome?: 'unknown'; reason?: string }>
  maxAutoPaySats: number
  maxSpendPerMinuteSats: number
  spendTracker: SpendTracker
  parseL402: (header: string) => L402Challenge | null
  decodeBolt11: (invoice: string) => DecodedInvoice
  detectServer: (headers: Headers, body: unknown) => ServerInfo
  challengeCache: ChallengeCache
  generateQr: (invoice: string) => Promise<{ png: string; text: string }>
  walletMethod: () => WalletMethod | undefined
  /** Detects x402 challenge from response headers. */
  isX402: (headers: Headers) => boolean
  /** Parses x402 challenge details from the response body. */
  parseX402: (body: unknown) => X402Challenge | null
  /** Formats x402 challenge as a payment request for the agent. */
  formatX402: (challenge: X402Challenge) => { json: Record<string, unknown>; message: string }
  /** Detects lnurlcash challenge from response headers. */
  isLnurlcash: (headers: Headers) => boolean
  /** Parses lnurlcash challenge from X-LNURLcash header value. */
  parseLnurlcash: (header: string) => LnurlcashChallenge | null
  /** Attempts lnurlcash payment. Returns a bearer note header or null. */
  payLnurlcash: (challenge: LnurlcashChallenge) => Promise<{ header: string; amountSats: number; settle: (granted: boolean) => void } | null>
  /** Detects xcashu challenge from response headers. */
  isXCashu: (headers: Headers) => boolean
  /** Parses xcashu challenge from X-Cashu header value. */
  parseXCashu: (header: string) => XCashuChallenge | null
  /** Attempts xcashu payment. Returns cashuB token header or null. */
  payXCashu: (challenge: XCashuChallenge) => Promise<{ header: string; amountSats: number } | null>
  /** Detects IETF Payment challenge from WWW-Authenticate header. */
  isIETFPayment: (headers: Headers) => boolean
  /** Parses IETF Payment challenge from WWW-Authenticate header value. */
  parseIETFPayment: (header: string) => IETFPaymentChallenge | null
  /** Builds base64url credential for Authorization: Payment header. */
  buildIETFCredential: (challenge: IETFPaymentChallenge, preimage: string) => string
  /** Ledger of unknown-outcome payments; any entry for a service pauses auto-pay to it. */
  pendingPayments: {
    add(entry: PendingPayment): void
    unresolvedFor(origins: string[], pubkey?: string): PendingPayment[]
  }
}

const RECONCILE_HINT = 'Call l402-reconcile with this paymentHash before paying this service again.'

function parseBalance(value: string | null): number | null {
  if (value === null) return null
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

type PayOutcome = { paid: boolean; preimage?: string; method: string; outcome?: 'unknown'; reason?: string }

/** A payment that may have executed. Always an error, so the agent does not pay again. */
function paymentUnknown(result: PayOutcome, costSats: number | null, paymentHash: string | null | undefined, protocol: string) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        status: 402,
        protocol,
        paymentState: 'unknown',
        costSats,
        paymentHash,
        method: result.method,
        message: result.outcome === 'unknown'
          ? (result.reason ?? `Payment may have executed. ${RECONCILE_HINT}`)
          : `The wallet reported payment without a settlement preimage. ${RECONCILE_HINT}`,
      }, null, 2),
    }],
    isError: true as const,
  }
}

/** A payment that definitely did not execute. */
function paymentFailed(result: PayOutcome, costSats: number | null, paymentHash: string | null | undefined, protocol: string) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        status: 402,
        protocol,
        paymentState: 'failed',
        costSats,
        paymentHash,
        method: result.method,
        message: `Payment failed and no money moved${result.reason ? `: ${result.reason}` : '.'}`,
      }, null, 2),
    }],
    isError: true as const,
  }
}

/**
 * Whether a stored credential may be sent to every one of `origins`. One
 * stored before origins were recorded is bound only to the origin it is keyed
 * by, if it is keyed by one.
 */
function isBoundTo(cred: StoredCredential, key: string, origins: string[]): boolean {
  const bound = cred.origins ?? (isOrigin(key) ? [key] : [])
  return origins.every(o => bound.includes(o))
}

function isOrigin(value: string): boolean {
  try { return new URL(value).origin === value } catch { return false }
}

/** Makes an HTTP request with automatic L402/x402 payment and credential reuse. Pays the invoice if within budget, stores the credential, and retries. */
export async function handleFetch(
  args: { url: string; urls?: string[]; method?: string; headers?: Record<string, string>; body?: string; autoPay?: boolean; pubkey?: string; txHash?: string; maxCostSats?: number },
  deps: FetchDeps,
) {
  // When multiple URLs are provided (from l402-search results), use transport fallback.
  // The first URL in `urls` is also the primary URL for identity, origin, and payment.
  const primaryUrl = args.urls?.length ? args.urls[0] : args.url
  const origin = new URL(primaryUrl).origin
  // Every origin this request may reach. A payment made here is recorded
  // against all of them, and an unresolved one for any of them blocks auto-pay.
  const candidateOrigins = [...new Set((args.urls?.length ? args.urls : [args.url]).map(u => new URL(u).origin))]
  const recordUnknown = (entry: Omit<PendingPayment, 'origins' | 'pubkey' | 'createdAt'>) => {
    deps.pendingPayments.add({
      ...entry,
      paymentHash: entry.paymentHash.toLowerCase(),
      origins: candidateOrigins,
      ...(args.pubkey ? { pubkey: args.pubkey } : {}),
      createdAt: new Date().toISOString(),
    })
  }
  // When a pubkey is provided (from search results) use it as the credential key so
  // credentials are shared across all transport URLs for the same service.
  // For direct URL calls without a pubkey, fall back to origin-based keying.
  //
  // The pubkey is only the agent's claim, so a credential is sent only to the
  // origins it was bought from: `url=https://evil pubkey=<X>` must not hand
  // X's credential to evil. A credential that is not bound to every origin
  // this request may reach is left alone, and anything bought here is kept
  // under the origin instead so it cannot overwrite X's.
  let credKey = args.pubkey ?? origin
  let cred = deps.credentialStore.get(credKey)
  if (cred && !isBoundTo(cred, credKey, candidateOrigins)) {
    cred = undefined
    if (args.pubkey) {
      credKey = origin
      cred = deps.credentialStore.get(credKey)
      if (cred && !isBoundTo(cred, credKey, candidateOrigins)) cred = undefined
    }
  }
  // The most this call may auto-pay. maxCostSats lets an agent hold the server
  // to the price it showed in a preview; it can only lower the configured cap.
  const autoPayCap = args.maxCostSats !== undefined ? Math.min(args.maxCostSats, deps.maxAutoPaySats) : deps.maxAutoPaySats
  const capLabel = args.maxCostSats !== undefined && args.maxCostSats < deps.maxAutoPaySats
    ? `maxCostSats (${args.maxCostSats})`
    : `MAX_AUTO_PAY_SATS (${deps.maxAutoPaySats})`
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

  // x402 retry: when the caller provides a transaction hash from a completed
  // on-chain payment, attach it as the X-Payment header so the server can
  // verify and grant access.
  if (args.txHash) {
    reqHeaders['X-Payment'] = args.txHash
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
            body: untrusted(body, origin),
            creditsRemaining: balance,
            satsPaid: 0,
          }, null, 2),
        }],
      }
    }

    // An earlier payment to this service may have gone through. Paying again
    // before that is settled could buy the same thing twice.
    if (args.autoPay) {
      const unresolved = deps.pendingPayments.unresolvedFor(candidateOrigins, args.pubkey)
      if (unresolved.length > 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 402,
              paymentState: 'blocked',
              unresolvedPayments: unresolved.map(p => p.paymentHash),
              message: `Auto-pay to this service is paused: ${unresolved.length} earlier payment(s) to it have an unknown outcome. Call l402-reconcile with each paymentHash before paying again.`,
            }, null, 2),
          }],
          isError: true as const,
        }
      }
    }

    // 402 response - parse the challenge body (shared by L402 and x402 paths)
    let challengeBody: Record<string, unknown> = {}
    try { challengeBody = await response.json() as Record<string, unknown> } catch { /* non-JSON 402 body */ }

    // lnurlcash challenge: a LUD-25 bearer note handed over in one header.
    // Tried first because it is the cheapest rail on the client side: no
    // Lightning hop, no mint swap, and the note is already money in hand.
    const lnurlcashHeader = response.headers.get('x-lnurlcash')
    if (lnurlcashHeader && deps.isLnurlcash(response.headers)) {
      const lnurlcashChallenge = deps.parseLnurlcash(lnurlcashHeader)
      if (lnurlcashChallenge) {
        const lnurlcashAutoPay = args.autoPay ?? false
        if (lnurlcashAutoPay && lnurlcashChallenge.amount <= autoPayCap) {
          const lnurlcashWithinLimit = deps.spendTracker.tryRecord(lnurlcashChallenge.amount, deps.maxSpendPerMinuteSats)
          if (lnurlcashWithinLimit) {
            const lnurlcashResult = await deps.payLnurlcash(lnurlcashChallenge)
            if (lnurlcashResult) {
              const retryHeaders: Record<string, string> = { ...reqHeaders }
              retryHeaders['X-LNURLcash'] = lnurlcashResult.header

              const retryResponse = await doFetch(primaryUrl, {
                method: args.method ?? 'GET',
                headers: retryHeaders,
                body: args.body,
              })

              // A granted request means the server settled the note by
              // rotating it, so our copy is dead. A refusal leaves it held
              // pending for the mint to rule on.
              lnurlcashResult.settle(retryResponse.status !== 402)

              const retryBalance = parseBalance(retryResponse.headers.get('x-credit-balance'))
              const retryBody = await retryResponse.text()
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({
                    status: retryResponse.status,
                    headers: filterResponseHeaders(retryResponse.headers),
                    body: untrusted(retryBody, origin),
                    creditsRemaining: retryBalance,
                    satsPaid: lnurlcashResult.amountSats,
                    paymentMethod: 'lnurlcash',
                  }, null, 2),
                }],
              }
            }
            // No note could cover it, so release the reservation and let
            // the other rails have a go.
            deps.spendTracker.unrecord(lnurlcashChallenge.amount)
          }
        }
      }
    }

    // xcashu challenge: direct Cashu ecash payment (no Lightning hop)
    const xcashuHeader = response.headers.get('x-cashu')
    if (xcashuHeader && deps.isXCashu(response.headers)) {
      const xcashuChallenge = deps.parseXCashu(xcashuHeader)
      if (xcashuChallenge) {
        const xcashuAutoPay = args.autoPay ?? false
        if (xcashuAutoPay && xcashuChallenge.amount <= autoPayCap) {
          const xcashuWithinLimit = deps.spendTracker.tryRecord(xcashuChallenge.amount, deps.maxSpendPerMinuteSats)
          if (xcashuWithinLimit) {
            const xcashuResult = await deps.payXCashu(xcashuChallenge)
            if (xcashuResult) {
              const retryHeaders: Record<string, string> = { ...reqHeaders }
              retryHeaders['X-Cashu'] = xcashuResult.header

              const retryResponse = await doFetch(primaryUrl, {
                method: args.method ?? 'GET',
                headers: retryHeaders,
                body: args.body,
              })

              const retryBalance = parseBalance(retryResponse.headers.get('x-credit-balance'))
              const retryBody = await retryResponse.text()
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({
                    status: retryResponse.status,
                    headers: filterResponseHeaders(retryResponse.headers),
                    body: untrusted(retryBody, origin),
                    creditsRemaining: retryBalance,
                    satsPaid: xcashuResult.amountSats,
                    paymentMethod: 'xcashu',
                  }, null, 2),
                }],
              }
            }
            // xcashu payment failed — unrecord spend, fall through to L402
            deps.spendTracker.unrecord(xcashuChallenge.amount)
          }
        }
      }
    }

    // x402 challenge: on-chain stablecoin payment (human-in-the-loop)
    if (deps.isX402(response.headers)) {
      const x402 = deps.parseX402(challengeBody)
      if (x402) {
        const { json } = deps.formatX402(x402)
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(json, null, 2),
          }],
        }
      }
      // Header said x402 but body was unparseable — fall through to generic 402
    }

    // IETF Payment challenge: Lightning via draft-ryan-httpauth-payment-01
    const wwwAuth = response.headers.get('www-authenticate') ?? ''
    if (deps.isIETFPayment(response.headers)) {
      const ietfChallenge = deps.parseIETFPayment(wwwAuth)
      if (ietfChallenge?.invoice && ietfChallenge.amountSats) {
        // The request's `amount` is only the server's claim; the invoice is
        // what gets paid. Price every check on the invoice itself, and refuse
        // a challenge whose claim and invoice disagree rather than pick one.
        const ietfInvoice = deps.decodeBolt11(ietfChallenge.invoice)
        const claimedHash = ietfChallenge.paymentHash?.toLowerCase()
        if (
          ietfInvoice.costSats === null ||
          ietfInvoice.costSats !== ietfChallenge.amountSats ||
          (claimedHash !== undefined && claimedHash !== ietfInvoice.paymentHash)
        ) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                status: 402,
                protocol: 'ietf-payment',
                error: 'Challenge does not match its invoice — refusing to pay',
                claimedSats: ietfChallenge.amountSats,
                invoiceSats: ietfInvoice.costSats,
                message: ietfInvoice.costSats === null
                  ? 'The invoice has no amount or could not be decoded.'
                  : 'The amount or payment hash the server states differs from the invoice it asks you to pay.',
              }, null, 2),
            }],
            isError: true as const,
          }
        }
        ietfChallenge.paymentHash = ietfInvoice.paymentHash ?? undefined
        const ietfAutoPay = args.autoPay ?? false
        if (ietfAutoPay && ietfChallenge.amountSats <= autoPayCap) {
          const ietfWithinLimit = deps.spendTracker.tryRecord(ietfChallenge.amountSats, deps.maxSpendPerMinuteSats)
          if (ietfWithinLimit) {
            const ietfPayResult = await deps.payInvoice(ietfChallenge.invoice, { serverOrigin: origin })
            // A payment attempt ends here whatever happens: falling through to
            // the L402 rail after this would pay a second invoice.
            if (!ietfPayResult.paid && ietfPayResult.outcome !== 'unknown') {
              deps.spendTracker.unrecord(ietfChallenge.amountSats)
              return paymentFailed(ietfPayResult, ietfChallenge.amountSats, ietfChallenge.paymentHash, 'ietf-payment')
            }
            if (ietfPayResult.outcome === 'unknown' || !ietfPayResult.preimage) {
              if (ietfChallenge.paymentHash) {
                recordUnknown({ paymentHash: ietfChallenge.paymentHash, invoice: ietfChallenge.invoice, costSats: ietfChallenge.amountSats, protocol: 'ietf-payment', method: ietfPayResult.method })
              }
              return paymentUnknown(ietfPayResult, ietfChallenge.amountSats, ietfChallenge.paymentHash, 'ietf-payment')
            }
            if (!HEX_RE.test(ietfPayResult.preimage) || ietfPayResult.preimage.length !== 64) {
              if (ietfChallenge.paymentHash) {
                recordUnknown({ paymentHash: ietfChallenge.paymentHash, invoice: ietfChallenge.invoice, costSats: ietfChallenge.amountSats, protocol: 'ietf-payment', method: ietfPayResult.method })
              }
              return {
                content: [{ type: 'text' as const, text: JSON.stringify({
                  error: 'Payment was reported but the settlement preimage contains invalid characters; refusing to send it',
                  paymentState: 'unknown',
                  paymentHash: ietfChallenge.paymentHash,
                  message: RECONCILE_HINT,
                }) }],
                isError: true as const,
              }
            }
            const credential = deps.buildIETFCredential(ietfChallenge, ietfPayResult.preimage)
            const retryHeaders: Record<string, string> = { ...reqHeaders }
            retryHeaders['Authorization'] = `Payment ${credential}`

            const retryResponse = await doFetch(primaryUrl, {
              method: args.method ?? 'GET',
              headers: retryHeaders,
              body: args.body,
            })

            const retryBody = await retryResponse.text()
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  status: retryResponse.status,
                  headers: filterResponseHeaders(retryResponse.headers),
                  body: untrusted(retryBody, origin),
                  satsPaid: ietfChallenge.amountSats,
                  paymentMethod: 'ietf-payment',
                }, null, 2),
              }],
            }
          }
        }
        // IETF Payment detected but not auto-paid: return challenge details.
        // Never fall through to another rail for the same request.
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 402,
              protocol: 'ietf-payment',
              costSats: ietfChallenge.amountSats,
              paymentHash: ietfChallenge.paymentHash,
              realm: ietfChallenge.realm,
              intent: ietfChallenge.intent,
              message: !ietfAutoPay
                ? `Payment of ${ietfChallenge.amountSats} sats required (IETF Payment). autoPay disabled.`
                : ietfChallenge.amountSats > autoPayCap
                  ? `Payment of ${ietfChallenge.amountSats} sats required. Exceeds ${capLabel}.`
                  : `Payment of ${ietfChallenge.amountSats} sats required. ${deps.spendTracker.refusal(ietfChallenge.amountSats, deps.maxSpendPerMinuteSats) ?? 'Spend limit reached.'}`,
            }, null, 2),
          }],
        }
      }
    }

    // L402 challenge: Lightning payment
    const authHeader = wwwAuth
    const challenge = deps.parseL402(authHeader)

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
    const shouldAttemptPay = (!creditsExhausted || isHumanWallet) && autoPay && challenge && decoded.costSats !== null && decoded.costSats <= autoPayCap
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
                message: `Payment required: ${decoded.costSats} sats. Open the URL to pay, then call l402-pay with paymentHash "${decoded.paymentHash}" to confirm and retry.`,
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
          message: `Payment required: ${decoded.costSats} sats. Scan the QR to pay, then call l402-pay with paymentHash "${decoded.paymentHash}" to confirm and retry.`,
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

      // Roll back the spend-limit reservation only for a definite failure,
      // and report it as one rather than as a fresh challenge to pay.
      if (!payResult.paid && payResult.outcome !== 'unknown') {
        deps.spendTracker.unrecord(decoded.costSats!)
        return paymentFailed(payResult, decoded.costSats, decoded.paymentHash, 'l402')
      }

      // Unknown, or reported paid with no preimage: the money may have moved.
      if (payResult.outcome === 'unknown' || !payResult.preimage) {
        if (decoded.paymentHash) {
          recordUnknown({ paymentHash: decoded.paymentHash, invoice: challenge.invoice, costSats: decoded.costSats, protocol: 'l402', method: payResult.method, macaroon: challenge.macaroon })
        }
        return paymentUnknown(payResult, decoded.costSats, decoded.paymentHash, 'l402')
      }

      // Validate preimage (hex) and macaroon (base64-safe) before storage
      // to prevent header injection via Authorization: L402 {macaroon}:{preimage}
      if (!HEX_RE.test(payResult.preimage) || payResult.preimage.length !== 64 || !MACAROON_RE.test(challenge.macaroon)) {
        if (decoded.paymentHash) {
          recordUnknown({ paymentHash: decoded.paymentHash, invoice: challenge.invoice, costSats: decoded.costSats, protocol: 'l402', method: payResult.method })
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'Payment was reported but the credential contains invalid characters; refusing to store it',
              paymentState: 'unknown',
              paymentHash: decoded.paymentHash,
              message: RECONCILE_HINT,
            }),
          }],
          isError: true as const,
        }
      }

      // Store credential and retry
      deps.credentialStore.set(credKey, {
        origins: candidateOrigins,
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
            body: untrusted(retryBody, origin),
            creditsRemaining: retryBalance,
            satsPaid: decoded.costSats,
          }, null, 2),
        }],
      }
    }

    // Step 5: Return 402 challenge for agent decision. Cache it, so that
    // l402-pay can pay exactly this invoice by its paymentHash.
    if (challenge && decoded.paymentHash) {
      deps.challengeCache.set({
        invoice: challenge.invoice,
        macaroon: challenge.macaroon,
        paymentHash: decoded.paymentHash,
        costSats: decoded.costSats,
        expiresAt: Date.now() + decoded.expiry * 1000,
        url: primaryUrl,
      })
    }
    const message = creditsExhausted
      ? `Insufficient credits for ${origin}${decoded.costSats !== null ? ` (this endpoint costs ${decoded.costSats} sats)` : ''}. Use l402-buy-credits to purchase more credits${tiers ? ' — tier options are included below' : ''}.`
      : decoded.costSats === null
        ? challenge
          ? 'Payment required, but the invoice states no amount, so it cannot be checked against the spending limits and will not be paid automatically.'
          : 'Payment required, but the response carries no payment challenge this client can read.'
      : !autoPay
        ? `Payment of ${decoded.costSats} sats required. autoPay disabled.`
        : decoded.costSats > autoPayCap
          ? `Payment of ${decoded.costSats} sats required. Exceeds ${capLabel}.`
          : !withinSpendLimit
            ? (deps.spendTracker.refusal(decoded.costSats ?? 0, deps.maxSpendPerMinuteSats) ?? 'Spend limit reached.')
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

/** Registers the l402-fetch tool with the MCP server. */
export function registerFetchTool(server: McpServer, deps: FetchDeps): void {
  server.registerTool(
    'l402-fetch',
    {
      description: 'Fetch a URL, paying its HTTP 402 challenge (L402, IETF Payment, Cashu or LNURLcash) when autoPay is true and the price is within MAX_AUTO_PAY_SATS, maxCostSats and the spend limits. Reuses stored credentials. Without autoPay, a 402 comes back with its price and paymentHash so the user can decide; l402-pay can then pay it. For x402 services, which this server supports only in an experimental custom format, returns the payment details for the user to pay in their own wallet. Response bodies are marked as untrusted content. With widget hosts, call l402-fetch-preview first to show the price.',
      annotations: { destructiveHint: true, openWorldHint: true },
      inputSchema: {
        url: z.url().describe('The primary URL to request. When using search results, pass the first URL here and all URLs in the urls field.'),
        urls: z.array(z.url()).max(10).optional().describe('All transport URLs from l402-search results (clearnet, onion, HNS). When present, transports are tried in preference order with automatic fallback on connection failure.'),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).optional().default('GET').describe('HTTP method'),
        headers: z.record(z.string().max(1000), z.string().max(8000)).optional().describe('Additional request headers'),
        body: z.string().max(1_000_000).optional().describe('Request body (for POST/PUT)'),
        autoPay: z.boolean().optional().default(false).describe('Automatically pay if within MAX_AUTO_PAY_SATS budget'),
        pubkey: z.string().max(128).optional().describe('Service pubkey from l402-search results — used to share credentials across all transport URLs for the same service'),
        txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional().describe('Transaction hash from a completed x402 on-chain payment. When provided, retries the request with X-Payment header for server verification.'),
        maxCostSats: z.number().int().nonnegative().optional().describe('Most this call may pay, in sats. Pass the price the user saw in l402-fetch-preview so a server cannot charge more than it showed. Lowers MAX_AUTO_PAY_SATS for this call; never raises it.'),
      },
    },
    async (args) => handleFetch(args, deps),
  )
}
