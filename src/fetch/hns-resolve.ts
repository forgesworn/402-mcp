export interface ResolvedAddress {
  address: string
  family: 4 | 6
}

interface DnsAnswer {
  type: number
  data: string
}

interface DnsResponse {
  Answer?: DnsAnswer[]
}

async function queryDns(
  hostname: string,
  gatewayUrl: string,
  type: 'A' | 'AAAA',
  signal: AbortSignal,
): Promise<DnsAnswer[]> {
  const url = `${gatewayUrl}dns-query?name=${encodeURIComponent(hostname)}&type=${type}`
  const response = await fetch(url, {
    headers: { Accept: 'application/dns-json' },
    signal,
  })
  if (!response.ok) {
    throw new Error(`DNS query failed: HTTP ${response.status} for ${hostname} (${type})`)
  }
  const data = (await response.json()) as DnsResponse
  return data.Answer ?? []
}

/**
 * Resolve a Handshake (HNS) hostname via a DNS-over-HTTPS gateway.
 *
 * Tries an A record first; falls back to AAAA if no A records are returned.
 * Throws if neither resolves, the gateway returns an error, or the request
 * times out.
 */
export async function resolveHns(
  hostname: string,
  gatewayUrl: string,
  timeoutMs = 5000,
): Promise<ResolvedAddress> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    // Try A record first
    const aAnswers = await queryDns(hostname, gatewayUrl, 'A', controller.signal)
    const aRecord = aAnswers.find(a => a.type === 1)
    if (aRecord) {
      return { address: aRecord.data, family: 4 }
    }

    // Fall back to AAAA
    const aaaaAnswers = await queryDns(hostname, gatewayUrl, 'AAAA', controller.signal)
    const aaaaRecord = aaaaAnswers.find(a => a.type === 28)
    if (aaaaRecord) {
      return { address: aaaaRecord.data, family: 6 }
    }

    throw new Error(`No DNS records found for ${hostname}`)
  } finally {
    clearTimeout(timeoutId)
  }
}
