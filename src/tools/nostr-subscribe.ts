import type { NostrEvent } from 'nostr-tools/core'
import type { SearchDeps } from './search.js'
import { validateUrl } from '../fetch/ssrf-guard.js'

const MAX_EVENTS = 1000

/** Optional tag filters to pass to relays, reducing bandwidth by filtering server-side. */
export interface SubscribeFilters {
  '#t'?: string[]
  '#pmi'?: string[]
}

/** Creates a Nostr relay subscriber that connects, subscribes to event kinds, and collects events within a timeout. */
export function createNostrSubscriber(ssrfAllowPrivate = false): SearchDeps['subscribeEvents'] {
  return async (relays: string[], kinds: number[], timeout: number, filters?: SubscribeFilters): Promise<NostrEvent[]> => {
    const { Relay } = await import('nostr-tools/relay')
    const { verifyEvent } = await import('nostr-tools/pure')
    const events: NostrEvent[] = []
    const connections: Array<{ close(): void }> = []

    await Promise.allSettled(
      relays.map(async (url) => {
        if (!url.startsWith('wss://') && !url.startsWith('ws://')) {
          return
        }
        // Reject plain ws:// in production: Relay.connect() does its own DNS
        // lookup, so we cannot pin the validated IP. TLS on wss:// prevents DNS
        // rebinding (same reasoning as HTTPS). Only allow ws:// in local dev.
        if (url.startsWith('ws://') && !ssrfAllowPrivate) {
          console.error(`[402-mcp] Rejected unencrypted relay ${url} — ws:// is vulnerable to DNS rebinding. Use wss:// or set SSRF_ALLOW_PRIVATE=true for local dev.`)
          return
        }
        if (url.startsWith('ws://')) {
          console.error(`[402-mcp] Warning: connecting to unencrypted relay ${url} — subscription data may be visible to network observers. Use wss:// for production.`)
        }

        // SSRF check: validate relay hostname against blocked IPs before connecting.
        // For wss://, TLS certificate validation prevents DNS rebinding (attacker
        // cannot present a valid cert from a private IP). This check catches
        // relays pointing directly at private/reserved IPs.
        try {
          const httpUrl = url.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://')
          await validateUrl(httpUrl, ssrfAllowPrivate)
        } catch {
          console.error(`[402-mcp] SSRF: blocked relay connection to ${url}`)
          return
        }

        try {
          const relay = await Promise.race([
            Relay.connect(url),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('timeout')), 10_000)
            ),
          ])
          connections.push(relay)

          return new Promise<void>((resolve) => {
            const filter: Record<string, unknown> = { kinds }
            if (filters?.['#t']?.length) filter['#t'] = filters['#t']
            if (filters?.['#pmi']?.length) filter['#pmi'] = filters['#pmi']

            const sub = relay.subscribe(
              [filter as Parameters<typeof relay.subscribe>[0][0]],
              {
                onevent: (event) => {
                  if (events.length < MAX_EVENTS && verifyEvent(event)) {
                    events.push(event as NostrEvent)
                  }
                },
                oneose: () => {
                  sub.close()
                  resolve()
                },
              },
            )

            // Ensure we resolve even if EOSE never arrives
            setTimeout(() => {
              sub.close()
              resolve()
            }, timeout)
          })
        } catch {
          // Skip unreachable relays silently
        }
      }),
    )

    // Close all relay connections
    for (const conn of connections) {
      try {
        conn.close()
      } catch {
        // Ignore close errors
      }
    }

    // Deduplicate by event id
    const seen = new Set<string>()
    return events.filter((e) => {
      if (seen.has(e.id)) return false
      seen.add(e.id)
      return true
    })
  }
}
