import type { X402Challenge } from './parse.js'
import { isUsdStablecoin } from './parse.js'

/** Format the x402 challenge as a human-readable payment request for the agent to present. */
export function formatX402PaymentRequest(challenge: X402Challenge): {
  /** Structured JSON for the agent to parse. */
  json: Record<string, unknown>
  /** Human-readable summary. */
  message: string
} {
  const asset = challenge.asset.toUpperCase()
  // A USD price is a token amount only for a USD stablecoin. For anything
  // else say it is a dollar value, not a quantity of the asset.
  const price = isUsdStablecoin(challenge.asset)
    ? `${challenge.amountUsd} ${asset}`
    : `$${challenge.amountUsd} (a USD value, payable in ${asset} at the current rate)`

  const json: Record<string, unknown> = {
    status: 402,
    protocol: 'x402',
    receiver: challenge.receiver,
    network: challenge.network,
    asset,
    amountUsd: challenge.amountUsd,
    ...(challenge.chainId !== null ? { chainId: challenge.chainId } : {}),
    experimental: 'x402 support is experimental and uses a custom format, not the x402 specification. Check the details with the service before paying.',
    message: `Payment required: ${price} on ${challenge.network}. `
      + `Send to ${challenge.receiver} from your own wallet. `
      + `After payment, provide the transaction hash to retry the request.`,
  }

  return {
    json,
    message: json.message as string,
  }
}

/** Validate a transaction hash format (0x-prefixed hex, 32 bytes). */
export function isValidTxHash(hash: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(hash)
}
