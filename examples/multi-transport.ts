/**
 * Multi-transport fallback demo.
 *
 * Demonstrates the onion → hns → https → http transport selection
 * and fallback chain. Run with:
 *
 *   npx tsx examples/multi-transport.ts          # mock demo (no network)
 *   npx tsx examples/multi-transport.ts --live    # also try real HNS + onion resolution
 */

import { selectTransports } from '402-mcp/fetch/transport'
import { withTransportFallback } from '402-mcp/fetch/resilient-fetch'
import { resolveHns } from '402-mcp/fetch/hns-resolve'
import { TransportUnavailableError } from '402-mcp/fetch/errors'

// ── 1. Transport classification & selection ─────────────────────────

const urls = [
  'https://api.example.com/weather',               // https (clearnet)
  'https://api.exampleonion.onion/weather',         // onion (Tor)
  'https://weather.satoshi/weather',                // hns  (Handshake TLD)
  'http://api.example.com/weather',                 // http (plain)
]

const preference = ['onion', 'hns', 'https', 'http']

console.log('=== Transport Selection ===\n')
console.log('URLs:', urls)
console.log('Preference:', preference.join(' > '))

// With Tor proxy available - .onion URLs are included
const withTor = selectTransports(urls, preference, { hasTorProxy: true })
console.log('\nWith Tor proxy:')
withTor.forEach((u: string, i: number) => console.log(`  ${i + 1}. ${u}`))

// Without Tor proxy - .onion URLs are filtered out
const withoutTor = selectTransports(urls, preference, { hasTorProxy: false })
console.log('\nWithout Tor proxy:')
withoutTor.forEach((u: string, i: number) => console.log(`  ${i + 1}. ${u}`))

// ── 2. Fallback chain ───────────────────────────────────────────────

console.log('\n=== Fallback Chain ===\n')
console.log('Simulating: onion fails (no proxy) -> HNS fails (ECONNREFUSED) -> clearnet succeeds\n')

const orderedUrls = [
  'https://api.exampleonion.onion/weather',    // will fail - no Tor
  'https://weather.satoshi/weather',            // will fail - ECONNREFUSED
  'https://api.example.com/weather',            // will succeed
]

const attempts: string[] = []

const mockFetch = async (url: string | URL): Promise<Response> => {
  const urlStr = url.toString()
  attempts.push(urlStr)

  if (urlStr.includes('.onion')) {
    console.log(`  [FAIL] ${urlStr}`)
    console.log('         TransportUnavailableError: no Tor proxy')
    throw new TransportUnavailableError(urlStr, 'no Tor proxy configured')
  }

  if (urlStr.includes('.satoshi')) {
    console.log(`  [FAIL] ${urlStr}`)
    console.log('         ECONNREFUSED: HNS host unreachable')
    const err = new Error('connect ECONNREFUSED') as NodeJS.ErrnoException
    err.code = 'ECONNREFUSED'
    throw err
  }

  console.log(`  [ OK ] ${urlStr}`)
  console.log('         200 - {"temp": 18, "unit": "celsius", "city": "London"}')
  return new Response(
    JSON.stringify({ temp: 18, unit: 'celsius', city: 'London' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

const response = await withTransportFallback(orderedUrls, {}, mockFetch)
const body = await response.json()

console.log(`\nResult: ${response.status} OK`)
console.log('Body:', body)
console.log(`Attempts: ${attempts.length} (${attempts.length - 1} transport failures before success)`)

// ── 3. Credential keying by pubkey ──────────────────────────────────

console.log('\n=== Credential Keying ===\n')

const servicePubkey = 'abcd1234'.repeat(8) // 64-char hex pubkey
const origins = orderedUrls.map(u => new URL(u).origin)

console.log('Service pubkey:', servicePubkey.slice(0, 16) + '...')
console.log('Transport origins:')
origins.forEach(o => console.log(`  - ${o}`))
console.log('\nAll three origins are different, but credentials are keyed by')
console.log('pubkey - so a macaroon obtained via onion works over clearnet.')

// ── 4. Live resolution (optional) ───────────────────────────────────

if (process.argv.includes('--live')) {
  // ── 4a. HNS resolution via HDNS gateway ─────────────────────────
  console.log('\n=== Live HNS Resolution (query.hdns.io) ===\n')

  const hnsNames = ['namebase', 'handshake', 'forever']
  const gateway = 'https://query.hdns.io/'

  for (const name of hnsNames) {
    try {
      const resolved = await resolveHns(name, gateway, 5000)
      console.log(`  ${name}/ -> ${resolved.address} (IPv${resolved.family})`)
    } catch (err) {
      console.log(`  ${name}/ -> ${(err as Error).message}`)
    }
  }

  // ── 4b. Onion connectivity check ─────────────────────────────────
  console.log('\n=== Onion Transport Check ===\n')

  const torProxy = process.env.TOR_PROXY || process.env.SOCKS_PROXY
  if (torProxy) {
    console.log(`  Tor SOCKS proxy configured: ${torProxy}`)
    console.log('  .onion URLs will be routed through the proxy.')

    // Test connectivity to Tor network via a known onion service
    const testOnion = 'http://2gzyxa5ihm7nsber64sieskb3r4zgbz2uho0vwqqmdxpcokbaurxuca.onion/'
    console.log(`\n  Testing: ${testOnion}`)
    try {
      const ctrl = new AbortController()
      setTimeout(() => ctrl.abort(), 10_000)
      const resp = await fetch(testOnion, { signal: ctrl.signal })
      console.log(`  Result: ${resp.status} ${resp.statusText}`)
    } catch (err) {
      console.log(`  Result: ${(err as Error).message}`)
      console.log('  (This is expected without a SOCKS-aware fetch implementation)')
    }
  } else {
    console.log('  No TOR_PROXY or SOCKS_PROXY configured.')
    console.log('  .onion URLs will be filtered out by selectTransports().')
    console.log('\n  To enable onion transport:')
    console.log('    1. Install Tor:  brew install tor && brew services start tor')
    console.log('    2. Set proxy:    export TOR_PROXY=socks5://127.0.0.1:9050')
    console.log('    3. Re-run:       npx tsx examples/multi-transport.ts --live')
  }
} else {
  console.log('\nRun with --live to test real HNS resolution and onion transport.')
}
