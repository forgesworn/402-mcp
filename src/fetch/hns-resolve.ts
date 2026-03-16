export interface ResolvedAddress {
  address: string
  family: 4 | 6
}

// Strict IPv4: exactly four decimal octets 0-255 (rejects octal, hex, shorthand)
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
// IPv6: hex digits, colons, and dots (dots appear in mixed notation like ::ffff:93.184.216.34)
const IPV6_RE = /^[0-9a-fA-F:.]+$/

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

// ── DNS wire format helpers (RFC 1035 / RFC 8484) ───────────────────

const DNS_HEADER_SIZE = 12
const DNS_TYPE_A = 1
const DNS_TYPE_AAAA = 28
const DNS_CLASS_IN = 1
const DNS_POINTER_MASK = 0xc0

/** Encode a hostname as DNS wire-format labels (length-prefixed, null-terminated). */
function encodeLabels(hostname: string): Uint8Array {
  const labels = hostname.split('.')
  let totalLen = 1 // null terminator
  for (const label of labels) totalLen += 1 + label.length

  const buf = new Uint8Array(totalLen)
  let offset = 0
  for (const label of labels) {
    buf[offset++] = label.length
    for (let i = 0; i < label.length; i++) {
      buf[offset++] = label.charCodeAt(i)
    }
  }
  buf[offset] = 0 // root label
  return buf
}

/** Build a minimal DNS query packet for the given hostname and record type. */
function buildQuery(hostname: string, qtype: number): Uint8Array {
  const labels = encodeLabels(hostname)
  const packet = new Uint8Array(DNS_HEADER_SIZE + labels.length + 4)
  const view = new DataView(packet.buffer)

  // Header: ID=0, flags=0x0100 (RD=1), QDCOUNT=1
  view.setUint16(0, 0)       // ID
  view.setUint16(2, 0x0100)  // Flags: recursion desired
  view.setUint16(4, 1)       // QDCOUNT
  view.setUint16(6, 0)       // ANCOUNT
  view.setUint16(8, 0)       // NSCOUNT
  view.setUint16(10, 0)      // ARCOUNT

  // Question section
  packet.set(labels, DNS_HEADER_SIZE)
  const typeOffset = DNS_HEADER_SIZE + labels.length
  view.setUint16(typeOffset, qtype)
  view.setUint16(typeOffset + 2, DNS_CLASS_IN)

  return packet
}

/** Skip a DNS name in wire format (handles compression pointers). */
function skipName(data: Uint8Array, offset: number): number {
  while (offset < data.length) {
    const len = data[offset]
    if (len === 0) return offset + 1
    if ((len & DNS_POINTER_MASK) === DNS_POINTER_MASK) return offset + 2
    offset += len + 1
  }
  throw new Error('Malformed DNS name')
}

interface ParsedRecord {
  type: number
  data: string
}

/** Parse a wire-format DNS response, extracting A and AAAA records. */
function parseResponse(data: Uint8Array): ParsedRecord[] {
  if (data.length < DNS_HEADER_SIZE) throw new Error('DNS response too short')

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const flags = view.getUint16(2)
  const rcode = flags & 0xf

  if (rcode !== 0) {
    const label = rcode === 3 ? 'NXDOMAIN' : rcode === 2 ? 'SERVFAIL' : `RCODE_${rcode}`
    throw new Error(`DNS resolution failed: ${label}`)
  }

  const ancount = view.getUint16(6)
  if (ancount === 0) return []

  // Skip question section
  let offset = DNS_HEADER_SIZE
  const qdcount = view.getUint16(4)
  for (let i = 0; i < qdcount; i++) {
    offset = skipName(data, offset)
    offset += 4 // QTYPE + QCLASS
  }

  // Parse answer section
  const records: ParsedRecord[] = []
  for (let i = 0; i < ancount && offset < data.length; i++) {
    offset = skipName(data, offset)
    if (offset + 10 > data.length) break

    const rtype = view.getUint16(offset)
    offset += 4 // TYPE + CLASS
    offset += 4 // TTL
    const rdlen = view.getUint16(offset)
    offset += 2

    if (offset + rdlen > data.length) break

    if (rtype === DNS_TYPE_A && rdlen === 4) {
      const ip = `${data[offset]}.${data[offset + 1]}.${data[offset + 2]}.${data[offset + 3]}`
      records.push({ type: DNS_TYPE_A, data: ip })
    } else if (rtype === DNS_TYPE_AAAA && rdlen === 16) {
      const groups: string[] = []
      for (let g = 0; g < 16; g += 2) {
        groups.push(view.getUint16(offset + g).toString(16))
      }
      records.push({ type: DNS_TYPE_AAAA, data: groups.join(':') })
    }

    offset += rdlen
  }

  return records
}

// ── Base64url encoding ──────────────────────────────────────────────

function toBase64url(data: Uint8Array): string {
  const base64 = Buffer.from(data).toString('base64')
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ── Public API ──────────────────────────────────────────────────────

async function queryDns(
  hostname: string,
  gatewayUrl: string,
  qtype: number,
  signal: AbortSignal,
): Promise<ParsedRecord[]> {
  const wire = buildQuery(hostname, qtype)
  const encoded = toBase64url(wire)
  const url = `${gatewayUrl}dns-query?dns=${encoded}`
  const response = await fetch(url, {
    headers: { Accept: 'application/dns-message' },
    signal,
    redirect: 'error',
  })
  if (!response.ok) {
    throw new Error(`DNS query failed: HTTP ${response.status} for ${hostname}`)
  }
  const buf = await response.arrayBuffer()
  return parseResponse(new Uint8Array(buf))
}

/**
 * Resolve a Handshake (HNS) hostname via a DNS-over-HTTPS gateway.
 *
 * Uses RFC 8484 wire-format DoH (GET with ?dns= parameter), which is
 * supported by the default HDNS gateway (query.hdns.io).
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
    const aRecords = await queryDns(hostname, gatewayUrl, DNS_TYPE_A, controller.signal)
    const aRecord = aRecords.find(r => r.type === DNS_TYPE_A)
    if (aRecord) {
      if (!isValidIpFormat(aRecord.data, 4)) {
        throw new Error(`HNS gateway returned invalid IPv4 address for ${hostname}`)
      }
      return { address: aRecord.data, family: 4 }
    }

    // Fall back to AAAA
    const aaaaRecords = await queryDns(hostname, gatewayUrl, DNS_TYPE_AAAA, controller.signal)
    const aaaaRecord = aaaaRecords.find(r => r.type === DNS_TYPE_AAAA)
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
