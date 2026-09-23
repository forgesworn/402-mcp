/** Chain IDs for supported EVM networks. */
const CHAIN_IDS: Record<string, number> = {
  base: 8453,
  'base-sepolia': 84532,
  ethereum: 1,
  optimism: 10,
  arbitrum: 42161,
  polygon: 137,
}

/**
 * Decimal places for USD stablecoins, where a USD amount is also the token
 * amount. Assets priced in anything else (ETH, for one) are left out: turning
 * a USD figure into their smallest unit would need an exchange rate, and
 * treating dollars as ether would ask for thousands of times the price.
 */
const ASSET_DECIMALS: Record<string, number> = {
  usdc: 6,
  usdt: 6,
  dai: 18,
}

/** Whether an asset's amount can be read straight from a USD price. */
export function isUsdStablecoin(asset: string): boolean {
  return asset.toLowerCase() in ASSET_DECIMALS
}

export interface X402Challenge {
  receiver: string
  network: string
  asset: string
  amountUsd: number
  /** EVM chain ID for the network (e.g. 8453 for Base). */
  chainId: number | null
  /** Amount in smallest asset unit (e.g. 1000000 for 1 USDC); null unless the asset is a USD stablecoin. */
  amountSmallestUnit: bigint | null
}

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/** Detects whether a 402 response contains an x402 challenge via the X-Payment-Required header. */
export function isX402Challenge(headers: Headers): boolean {
  const value = headers.get('x-payment-required')
  return value?.toLowerCase() === 'x402'
}

/**
 * Parses an x402 challenge from the response body.
 * Expected shape: `{ x402: { receiver, network, asset, amount_usd } }`.
 *
 * Experimental: this is a custom format, not the x402 specification, whose
 * servers send a base64 `PAYMENT-REQUIRED` header. Real x402 services are not
 * understood here.
 */
export function parseX402Challenge(body: unknown): X402Challenge | null {
  if (body === null || typeof body !== 'object') return null

  const root = body as Record<string, unknown>
  const x402 = root.x402
  if (x402 === null || typeof x402 !== 'object') return null

  const data = x402 as Record<string, unknown>

  const receiver = typeof data.receiver === 'string' ? data.receiver.trim() : null
  const network = typeof data.network === 'string' ? data.network.trim().toLowerCase() : null
  const asset = typeof data.asset === 'string' ? data.asset.trim().toLowerCase() : null

  // Accept both amount_usd and amountUsd
  const rawAmount = data.amount_usd ?? data.amountUsd
  const amountUsd = typeof rawAmount === 'number' && Number.isFinite(rawAmount) && rawAmount > 0
    ? rawAmount
    : null

  if (!receiver || !network || !asset || amountUsd === null) return null

  // Validate Ethereum address format
  if (!ETH_ADDRESS_RE.test(receiver)) return null

  const chainId = CHAIN_IDS[network] ?? null
  const decimals = ASSET_DECIMALS[asset]
  const amountSmallestUnit = decimals !== undefined
    ? BigInt(Math.round(amountUsd * 10 ** decimals))
    : null

  return {
    receiver,
    network,
    asset,
    amountUsd,
    chainId,
    amountSmallestUnit,
  }
}

/**
 * Formerly built an EIP-681 link, but one with no token contract or amount
 * sends the wrong asset or nothing at all. Kept so existing imports resolve.
 *
 * @deprecated Returns null. A correct link needs the token contract address,
 * which the challenge does not carry.
 */
export function buildPaymentDeeplink(_challenge: X402Challenge): string | null {
  return null
}
