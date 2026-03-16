import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { NostrEvent } from 'nostr-tools/core'
import type { SubscribeFilters } from './nostr-subscribe.js'
import { safeErrorMessage } from './safe-error.js'

const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
]

const KIND_L402_ANNOUNCE = 31402

export interface SearchDeps {
  subscribeEvents: (relays: string[], kinds: number[], timeout: number, filters?: SubscribeFilters) => Promise<NostrEvent[]>
}

export interface ParsedService {
  name: string | undefined
  urls: string[]
  about: string | undefined
  pubkey: string
  paymentMethods: string[]
  pricing: { capability: string; amount: string; unit: string }[]
  topics: string[]
  capabilities: { name: string; description: string; endpoint?: string; pricing?: string; auth?: string; timeout?: number }[]
}

/** Extracts service metadata (name, URLs, pricing, capabilities) from a kind 31402 Nostr event. */
export function parseAnnounceEvent(event: NostrEvent): ParsedService {
  const getTag = (key: string): string | undefined =>
    event.tags.find(t => t[0] === key)?.[1]

  const getAllTags = (key: string): string[][] =>
    event.tags.filter(t => t[0] === key)

  const getAllTagValues = (key: string): string[] =>
    event.tags.filter(t => t[0] === key).map(t => t[1]).filter(Boolean)

  const paymentMethods = getAllTagValues('pmi')
  const topics = getAllTagValues('t')

  const pricing = getAllTags('price').map(t => ({
    capability: t[1] ?? '',
    amount: t[2] ?? '',
    unit: t[3] ?? '',
  }))

  let capabilities: ParsedService['capabilities'] = []
  try {
    const parsed: unknown = JSON.parse(event.content)
    const parsedObj = parsed as Record<string, unknown> | null
    if (parsedObj && Array.isArray(parsedObj.capabilities)) {
      // Cap at 100 to prevent CPU exhaustion from malicious events with huge arrays
      capabilities = (parsedObj.capabilities as unknown[]).slice(0, 100)
        .filter((c: unknown): c is Record<string, unknown> =>
          typeof c === 'object' && c !== null &&
          typeof (c as Record<string, unknown>).name === 'string' &&
          typeof (c as Record<string, unknown>).description === 'string'
        )
        .map((c: Record<string, unknown>) => ({
          name: (c.name as string).slice(0, 500),
          description: (c.description as string).slice(0, 2000),
          ...(typeof c.endpoint === 'string' ? { endpoint: c.endpoint.slice(0, 2048) } : {}),
          ...(typeof c.pricing === 'string' ? { pricing: c.pricing } : {}),
          ...(typeof c.auth === 'string' ? { auth: c.auth } : {}),
          ...(typeof c.timeout === 'number' && c.timeout > 0 ? { timeout: c.timeout } : {}),
        }))
    }
  } catch {
    // Invalid JSON — capabilities remain empty
  }

  return {
    name: getTag('name'),
    urls: getAllTagValues('url'),
    about: getTag('about'),
    pubkey: event.pubkey,
    paymentMethods,
    pricing,
    topics,
    capabilities,
  }
}

/** Searches Nostr relays for L402 service announcements matching a query, topic, or payment method. */
export async function handleSearch(
  args: { query: string; relays?: string[]; topics?: string[]; paymentMethod?: string; maxResults?: number; timeout?: number },
  deps: SearchDeps,
) {
  try {
    const relays = args.relays ?? DEFAULT_RELAYS
    const timeout = args.timeout ?? 5000
    const maxResults = args.maxResults ?? 20
    const queryLower = args.query.toLowerCase()

    // Build relay-side tag filters — relays handle topic and payment method filtering
    const relayFilters: SubscribeFilters = {}
    if (args.topics?.length) relayFilters['#t'] = args.topics
    if (args.paymentMethod) relayFilters['#pmi'] = [args.paymentMethod]

    const rawEvents = await deps.subscribeEvents(relays, [KIND_L402_ANNOUNCE], timeout, relayFilters)

    // NIP-33 dedup: keep only the newest event per pubkey + d tag
    const replaceableMap = new Map<string, NostrEvent>()
    for (const e of rawEvents) {
      const dTag = e.tags.find(t => t[0] === 'd')?.[1] ?? ''
      const key = `${e.pubkey}:${dTag}`
      const existing = replaceableMap.get(key)
      if (!existing || e.created_at > existing.created_at) {
        replaceableMap.set(key, e)
      }
    }

    let services = [...replaceableMap.values()].map(parseAnnounceEvent)

    // Filter by query text — relays cannot do substring search so this remains client-side
    if (queryLower) {
      services = services.filter(svc => {
        const searchable = [
          svc.name ?? '',
          svc.about ?? '',
          ...svc.topics,
          ...svc.capabilities.map(c => `${c.name} ${c.description}`),
        ].join(' ').toLowerCase()

        return searchable.includes(queryLower)
      })
    }

    // Limit results
    const results = services.slice(0, maxResults)

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
    }
  } catch (err) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: safeErrorMessage(err) }),
      }],
      isError: true as const,
    }
  }
}

/** Registers the l402_search tool with the MCP server. */
export function registerSearchTool(server: McpServer, deps: SearchDeps): void {
  server.registerTool(
    'l402_search',
    {
      description: 'Search for paid APIs and services. Use this when the user wants something that might be available as a paid service — jokes, data, AI, content, etc. Discovers services announced on Nostr and returns their URLs, pricing, and capabilities. Then use l402_fetch with the URL to access the service.',
      inputSchema: {
        query: z.string().max(200).describe('Search query to match against service names, descriptions, and capabilities'),
        relays: z.array(z.url()).max(10).optional().describe('Nostr relay URLs to query (defaults to popular public relays)'),
        topics: z.array(z.string().max(50)).max(10).optional().describe('Filter by topic tags (e.g. ["ai", "data"])'),
        paymentMethod: z.string().max(100).optional().describe('Filter by payment method (e.g. "bitcoin-lightning-bolt11", "bitcoin-cashu")'),
        maxResults: z.int().min(1).max(100).optional().describe('Maximum number of results to return (default 20)'),
        timeout: z.int().min(1000).max(30000).optional().describe('Relay subscription timeout in milliseconds (default 5000)'),
      },
    },
    async (args) => handleSearch(args, deps),
  )
}
