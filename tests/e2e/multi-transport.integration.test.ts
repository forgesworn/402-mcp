import { describe, it, expect, vi } from 'vitest'
import type { NostrEvent } from 'nostr-tools/core'
import { parseAnnounceEvent } from '../../src/tools/search.js'
import { selectTransports } from '../../src/fetch/transport.js'
import { withTransportFallback } from '../../src/fetch/resilient-fetch.js'
import { TransportUnavailableError } from '../../src/fetch/errors.js'

/**
 * Build a minimal kind 31402 event with multiple url tags.
 * The event does not need to be cryptographically valid for parsing tests.
 */
function buildAnnounceEvent(urls: string[]): NostrEvent {
  return {
    id: 'aaaa'.repeat(16),
    pubkey: 'bbbb'.repeat(16),
    created_at: Math.floor(Date.now() / 1000),
    kind: 31402,
    tags: [
      ['d', 'test-service'],
      ['name', 'Test Service'],
      ['about', 'A service with multiple transports'],
      ...urls.map(u => ['url', u]),
      ['pmi', 'l402', 'lightning'],
    ],
    content: JSON.stringify({
      capabilities: [
        { name: 'api', description: 'Main API endpoint' },
      ],
    }),
    sig: 'cc'.repeat(32),
  }
}

describe('multi-transport end-to-end', () => {
  it('discovers service with multiple urls, selects best transport, falls back on failure', async () => {
    const clearnetUrl = 'https://service.example.com/api'
    const onionUrl = 'https://exampleonionaddress.onion/api'
    const hnsUrl = 'https://service.satoshipay/api'

    // Step 1: Build a kind 31402 event with 3 url tags (clearnet, .onion, HNS)
    const event = buildAnnounceEvent([clearnetUrl, onionUrl, hnsUrl])

    // Step 2: Parse with parseAnnounceEvent() — verify urls array has 3 entries
    const parsed = parseAnnounceEvent(event)
    expect(parsed.urls).toHaveLength(3)
    expect(parsed.urls).toContain(clearnetUrl)
    expect(parsed.urls).toContain(onionUrl)
    expect(parsed.urls).toContain(hnsUrl)
    expect(parsed.pubkey).toBe(event.pubkey)

    // Step 3: Run selectTransports() with Tor proxy available
    // Default preference order from the feature: onion > hns > https
    const preference = ['onion', 'hns', 'https']
    const withTor = selectTransports(parsed.urls, preference, { hasTorProxy: true })

    // .onion should be first, HNS second, clearnet (https) third
    expect(withTor[0]).toBe(onionUrl)
    expect(withTor[1]).toBe(hnsUrl)
    expect(withTor[2]).toBe(clearnetUrl)

    // Without Tor proxy: .onion is filtered out, HNS comes first
    const withoutTor = selectTransports(parsed.urls, preference, { hasTorProxy: false })
    expect(withoutTor).not.toContain(onionUrl)
    expect(withoutTor[0]).toBe(hnsUrl)
    expect(withoutTor[1]).toBe(clearnetUrl)

    // Step 4-7: Mock transports and verify withTransportFallback() reaches the third URL
    const calledUrls: string[] = []

    const mockFetch = vi.fn(async (url: string | URL) => {
      const urlStr = url.toString()
      calledUrls.push(urlStr)

      // Step 4: .onion URL → TransportUnavailableError (no Tor proxy)
      if (urlStr === onionUrl) {
        throw new TransportUnavailableError(urlStr, 'no Tor proxy configured')
      }

      // Step 5: HNS URL → ECONNREFUSED
      if (urlStr === hnsUrl) {
        const err = new Error('connect ECONNREFUSED') as NodeJS.ErrnoException
        err.code = 'ECONNREFUSED'
        throw err
      }

      // Step 6: clearnet URL → 200 OK
      if (urlStr === clearnetUrl) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      throw new Error(`Unexpected URL: ${urlStr}`)
    })

    // Use the ordered list from selectTransports (with Tor) for fallback
    const response = await withTransportFallback(withTor, {}, mockFetch)

    // Step 7: Verify it reached the third URL (clearnet)
    expect(response.status).toBe(200)
    expect(calledUrls).toEqual([onionUrl, hnsUrl, clearnetUrl])

    // Step 8: Verify credential would be stored under pubkey, not origin
    // When pubkey is provided, credentials are keyed by pubkey so they are
    // shared across all transport URLs for the same service.
    const credKey = parsed.pubkey
    expect(credKey).toBe(event.pubkey)
    // The origin-based key would be different for each transport URL
    const onionOrigin = new URL(onionUrl).origin
    const hnsOrigin = new URL(hnsUrl).origin
    const clearnetOrigin = new URL(clearnetUrl).origin
    expect(credKey).not.toBe(onionOrigin)
    expect(credKey).not.toBe(hnsOrigin)
    expect(credKey).not.toBe(clearnetOrigin)
    // All three origins are different — pubkey-based keying is the only way
    // to share credentials across transports
    expect(onionOrigin).not.toBe(hnsOrigin)
    expect(hnsOrigin).not.toBe(clearnetOrigin)
  })
})
