export interface ResolvedAddress {
  address: string
  family: 4 | 6
}

// Strict IPv4: exactly four decimal octets 0-255 (rejects octal, hex, shorthand)
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
// IPv6: hex digits and colons only (simplified check — full validation happens in isBlockedIp)
const IPV6_RE = /^[0-9a-fA-F:]+$/

function isValidIpFormat(address: string, family: 4 | 6): boolean {
  if (family === 4) {
    const m = IPV4_RE.exec(address)
    if (!m) return false
    return [m[1], m[2], m[3], m[4]].every(octet => {
      const n = Number(octet)
      // Reject leading zeros (octal ambiguity: "0177" vs "177")
      return n >= 0 && n <= 255 && String(n) === octet
    })
  }
  // IPv6: basic format check — hex digits and colons only, at least one colon
  return IPV6_RE.test(address) && address.includes(':')
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
    redirect: 'error', // Prevent gateway redirects to internal services
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
      if (!isValidIpFormat(aRecord.data, 4)) {
        throw new Error(`HNS gateway returned invalid IPv4 address for ${hostname}`)
      }
      return { address: aRecord.data, family: 4 }
    }

    // Fall back to AAAA
    const aaaaAnswers = await queryDns(hostname, gatewayUrl, 'AAAA', controller.signal)
    const aaaaRecord = aaaaAnswers.find(a => a.type === 28)
    if (aaaaRecord) {
      if (!isValidIpFormat(aaaaRecord.data, 6)) {
        throw new Error(`HNS gateway returned invalid IPv6 address for ${hostname}`)
      }
      return { address: aaaaRecord.data, family: 6 }
    }

    throw new Error(`No DNS records found for ${hostname}`)
  } finally {
    clearTimeout(timeoutId)
  }
}
