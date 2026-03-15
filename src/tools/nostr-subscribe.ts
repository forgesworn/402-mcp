import type { NostrEvent } from 'nostr-tools/core'
import type { SearchDeps } from './search.js'
import { validateUrl } from '../fetch/ssrf-guard.js'

/**
 * Creates a Nostr relay subscriber that connects to relays,
 * subscribes to the given event kinds, and collects events
 * for a specified timeout period.
 */
const MAX_EVENTS = 1000

/** Optional tag filters to pass to relays, reducing bandwidth by filtering server-side. */
export interface SubscribeFilters {
  '#t'?: string[]
  '#pmi'?: string[]
}

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
        if (url.startsWith('ws://')) {
          console.error(`[402-mcp] Warning: connecting to unencrypted relay ${url} — subscription data may be visible to network observers. Use wss:// for production.`)
        }

        // SSRF check: validate relay hostname against blocked IPs before connecting.
        // Convert ws(s):// to http(s):// for validation since validateUrl expects HTTP.
        try {
          const httpUrl = url.replace(/^ws/, 'http')
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
