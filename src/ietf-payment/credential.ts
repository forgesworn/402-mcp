/**
 * IETF Payment credential builder (draft-ryan-httpauth-payment-01).
 *
 * After paying the Lightning invoice from a Payment challenge, builds the
 * `Authorization: Payment <base64url credential>` header for server verification.
 */

import type { IETFPaymentChallenge } from './parse.js'

/**
 * Builds a base64url-encoded IETF Payment credential for the Authorization header.
 *
 * Wire format matches what toll-booth's verify() expects:
 * ```json
 * {
 *   "challenge": { "id", "realm", "method", "intent", "request", "expires"? },
 *   "payload": { "preimage": "<64-char hex>" }
 * }
 * ```
 */
export function buildIETFPaymentCredential(challenge: IETFPaymentChallenge, preimage: string): string {
  const credential = {
    challenge: {
      id: challenge.id,
      realm: challenge.realm,
      method: challenge.method,
      intent: challenge.intent,
      request: challenge.request,
      ...(challenge.expires && { expires: challenge.expires }),
      ...(challenge.description && { description: challenge.description }),
    },
    payload: { preimage },
  }
  return Buffer.from(JSON.stringify(credential)).toString('base64url')
}
