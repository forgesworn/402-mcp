import { describe, it, expect } from 'vitest'
import { parseAnnounceEvent, handleSearch, type SearchDeps } from '../../src/tools/search.js'
import type { NostrEvent } from 'nostr-tools/core'
import type { SubscribeFilters } from '../../src/tools/nostr-subscribe.js'

function makeEvent(overrides: Partial<NostrEvent> & { tags?: string[][] } = {}): NostrEvent {
  return {
    kind: 31402,
    pubkey: 'abc123pubkey',
    id: 'evt1',
    sig: 'sig1',
    created_at: Math.floor(Date.now() / 1000),
    content: JSON.stringify({
      capabilities: [{ name: 'chat', description: 'Chat completion' }],
    }),
    tags: [
      ['d', 'svc-alpha'],
      ['name', 'Alpha Service'],
      ['url', 'https://alpha.example.com'],
      ['about', 'An AI chat service'],
      ['pmi', 'bitcoin-lightning-bolt11'],
      ['pmi', 'bitcoin-cashu'],
      ['price', 'chat', '10', 'sats'],
      ['t', 'ai'],
      ['t', 'inference'],
    ],
    ...overrides,
  }
}

function mockDeps(events: NostrEvent[]): SearchDeps {
  return {
    subscribeEvents: async (_relays, _kinds, _timeout, _filters?: SubscribeFilters) => events,
  }
}

describe('parseAnnounceEvent', () => {
  it('extracts name, urls, about, pubkey, paymentMethods, pricing, and topics', () => {
    const event = makeEvent()
    const result = parseAnnounceEvent(event)

    expect(result.name).toBe('Alpha Service')
    expect(result.urls).toEqual(['https://alpha.example.com'])
    expect(result.about).toBe('An AI chat service')
    expect(result.pubkey).toBe('abc123pubkey')
    expect(result.paymentMethods).toEqual(['bitcoin-lightning-bolt11', 'bitcoin-cashu'])
    expect(result.pricing).toEqual([{ capability: 'chat', amount: '10', unit: 'sats' }])
    expect(result.topics).toEqual(['ai', 'inference'])
  })

  it('handles missing optional tags gracefully', () => {
    const event = makeEvent({
      tags: [
        ['d', 'minimal'],
        ['url', 'https://minimal.example.com'],
      ],
      content: '',
    })
    const result = parseAnnounceEvent(event)

    expect(result.name).toBeUndefined()
    expect(result.urls).toEqual(['https://minimal.example.com'])
    expect(result.about).toBeUndefined()
    expect(result.paymentMethods).toEqual([])
    expect(result.pricing).toEqual([])
    expect(result.topics).toEqual([])
  })

  it('collects multiple url tags into urls array', () => {
    const event = makeEvent({
      tags: [
        ['d', 'multi-transport'],
        ['name', 'Multi-Transport Service'],
        ['url', 'https://clear.example.com'],
        ['url', 'http://example.onion'],
        ['url', 'https://hnsname'],
      ],
      content: '',
    })
    const result = parseAnnounceEvent(event)

    expect(result.urls).toEqual([
      'https://clear.example.com',
      'http://example.onion',
      'https://hnsname',
    ])
  })

  it('returns empty urls array when no url tag is present', () => {
    const event = makeEvent({
      tags: [
        ['d', 'no-url'],
        ['name', 'No URL Service'],
      ],
      content: '',
    })
    const result = parseAnnounceEvent(event)

    expect(result.urls).toEqual([])
  })

  it('parses capabilities from content JSON', () => {
    const event = makeEvent()
    const result = parseAnnounceEvent(event)

    expect(result.capabilities).toEqual([
      { name: 'chat', description: 'Chat completion' },
    ])
  })

  it('returns empty capabilities for invalid content JSON', () => {
    const event = makeEvent({ content: 'not-json' })
    const result = parseAnnounceEvent(event)

    expect(result.capabilities).toEqual([])
  })

  it('includes endpoint in capabilities when present in content', () => {
    const event = makeEvent({
      content: JSON.stringify({
        capabilities: [
          { name: 'chat', description: 'Chat completion', endpoint: '/v1/chat' },
          { name: 'embed', description: 'Embeddings', endpoint: '/v1/embed' },
        ],
      }),
    })
    const result = parseAnnounceEvent(event)

    expect(result.capabilities).toEqual([
      { name: 'chat', description: 'Chat completion', endpoint: '/v1/chat' },
      { name: 'embed', description: 'Embeddings', endpoint: '/v1/embed' },
    ])
  })

  it('omits endpoint from capabilities when not present', () => {
    const event = makeEvent({
      content: JSON.stringify({
        capabilities: [{ name: 'chat', description: 'Chat completion' }],
      }),
    })
    const result = parseAnnounceEvent(event)

    expect(result.capabilities).toEqual([
      { name: 'chat', description: 'Chat completion' },
    ])
    expect(result.capabilities[0]).not.toHaveProperty('endpoint')
  })

  it('parses pricing, auth, and timeout from capabilities', () => {
    const event = makeEvent({
      content: JSON.stringify({
        capabilities: [
          { name: 'dynamic-api', description: 'Dynamically priced', pricing: 'dynamic' },
          { name: 'free-api', description: 'No auth needed', auth: 'none', endpoint: '/v1/free' },
          { name: 'timed-api', description: 'Expires', timeout: 3600, auth: 'freebie 5' },
        ],
      }),
    })
    const result = parseAnnounceEvent(event)

    expect(result.capabilities[0]).toEqual({
      name: 'dynamic-api', description: 'Dynamically priced', pricing: 'dynamic',
    })
    expect(result.capabilities[1]).toEqual({
      name: 'free-api', description: 'No auth needed', auth: 'none', endpoint: '/v1/free',
    })
    expect(result.capabilities[2]).toEqual({
      name: 'timed-api', description: 'Expires', timeout: 3600, auth: 'freebie 5',
    })
  })

  it('omits pricing, auth, and timeout when not present', () => {
    const event = makeEvent({
      content: JSON.stringify({
        capabilities: [{ name: 'basic', description: 'Basic API' }],
      }),
    })
    const result = parseAnnounceEvent(event)

    expect(result.capabilities[0]).not.toHaveProperty('pricing')
    expect(result.capabilities[0]).not.toHaveProperty('auth')
    expect(result.capabilities[0]).not.toHaveProperty('timeout')
  })

  it('ignores timeout when zero or negative', () => {
    const event = makeEvent({
      content: JSON.stringify({
        capabilities: [
          { name: 'zero', description: 'Zero timeout', timeout: 0 },
          { name: 'neg', description: 'Negative timeout', timeout: -1 },
        ],
      }),
    })
    const result = parseAnnounceEvent(event)

    expect(result.capabilities[0]).not.toHaveProperty('timeout')
    expect(result.capabilities[1]).not.toHaveProperty('timeout')
  })
})

describe('handleSearch', () => {
  it('returns matching services from mock events', async () => {
    const events = [makeEvent()]
    const result = await handleSearch({ query: 'chat' }, mockDeps(events))
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed).toHaveLength(1)
    expect(parsed[0].name).toBe('Alpha Service')
    expect(parsed[0].urls).toEqual(['https://alpha.example.com'])
    expect(parsed[0].paymentMethods).toEqual(['bitcoin-lightning-bolt11', 'bitcoin-cashu'])
  })

  it('passes payment method filter to subscribeEvents and returns relay-filtered results', async () => {
    const bolt11Event = makeEvent({
      id: 'evt-bolt11',
      tags: [
        ['d', 'bolt11-only'],
        ['name', 'Bolt11 Service'],
        ['url', 'https://bolt11.example.com'],
        ['pmi', 'bitcoin-lightning-bolt11'],
        ['t', 'ai'],
      ],
    })
    const cashuEvent = makeEvent({
      id: 'evt-cashu',
      pubkey: 'def456pubkey',
      tags: [
        ['d', 'cashu-only'],
        ['name', 'Cashu Service'],
        ['url', 'https://cashu.example.com'],
        ['pmi', 'bitcoin-cashu'],
        ['t', 'ai'],
      ],
    })
    const allEvents = [bolt11Event, cashuEvent]
    let capturedFilters: SubscribeFilters | undefined

    // Simulate relay-side filtering: relay returns only events matching the pmi filter
    const deps: SearchDeps = {
      subscribeEvents: async (_relays, _kinds, _timeout, filters?: SubscribeFilters) => {
        capturedFilters = filters
        return allEvents.filter(e =>
          !filters?.['#pmi']?.length ||
          e.tags.some(t => t[0] === 'pmi' && filters['#pmi']!.includes(t[1]))
        )
      },
    }

    const result = await handleSearch(
      { query: 'ai', paymentMethod: 'bitcoin-cashu' },
      deps,
    )
    const parsed = JSON.parse(result.content[0].text)

    expect(capturedFilters).toEqual({ '#pmi': ['bitcoin-cashu'] })
    expect(parsed).toHaveLength(1)
    expect(parsed[0].name).toBe('Cashu Service')
  })

  it('passes topic filter to subscribeEvents and returns relay-filtered results', async () => {
    const aiEvent = makeEvent({
      id: 'evt-ai',
      tags: [
        ['d', 'ai-svc'],
        ['name', 'AI Service'],
        ['url', 'https://ai.example.com'],
        ['pmi', 'bitcoin-lightning-bolt11'],
        ['t', 'ai'],
        ['t', 'inference'],
      ],
    })
    const weatherEvent = makeEvent({
      id: 'evt-weather',
      pubkey: 'weather-pubkey',
      tags: [
        ['d', 'weather-svc'],
        ['name', 'Weather Service'],
        ['url', 'https://weather.example.com'],
        ['pmi', 'bitcoin-lightning-bolt11'],
        ['t', 'weather'],
        ['t', 'data'],
      ],
    })
    const allEvents = [aiEvent, weatherEvent]
    let capturedFilters: SubscribeFilters | undefined

    // Simulate relay-side filtering: relay returns only events matching the topic filter
    const deps: SearchDeps = {
      subscribeEvents: async (_relays, _kinds, _timeout, filters?: SubscribeFilters) => {
        capturedFilters = filters
        return allEvents.filter(e =>
          !filters?.['#t']?.length ||
          e.tags.some(t => t[0] === 't' && filters['#t']!.includes(t[1]))
        )
      },
    }

    const result = await handleSearch(
      { query: '', topics: ['weather'] },
      deps,
    )
    const parsed = JSON.parse(result.content[0].text)

    expect(capturedFilters).toEqual({ '#t': ['weather'] })
    expect(parsed).toHaveLength(1)
    expect(parsed[0].name).toBe('Weather Service')
  })

  it('returns empty array when no matches', async () => {
    const events = [makeEvent()]
    const result = await handleSearch(
      { query: 'nonexistent-service-xyz' },
      mockDeps(events),
    )
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed).toEqual([])
  })

  it('respects maxResults', async () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      makeEvent({
        id: `evt-${i}`,
        pubkey: `pubkey-${i}`,
        tags: [
          ['d', `svc-${i}`],
          ['name', `Service ${i}`],
          ['url', `https://svc${i}.example.com`],
          ['pmi', 'bitcoin-lightning-bolt11'],
          ['t', 'ai'],
        ],
      }),
    )

    const result = await handleSearch(
      { query: 'ai', maxResults: 2 },
      mockDeps(events),
    )
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed).toHaveLength(2)
  })

  it('passes relays and timeout to subscribeEvents', async () => {
    const customRelays = ['wss://relay1.example.com', 'wss://relay2.example.com']
    const customTimeout = 8000
    let capturedRelays: string[] = []
    let capturedTimeout = 0

    const deps: SearchDeps = {
      subscribeEvents: async (relays, _kinds, timeout, _filters?: SubscribeFilters) => {
        capturedRelays = relays
        capturedTimeout = timeout
        return []
      },
    }

    await handleSearch(
      { query: 'test', relays: customRelays, timeout: customTimeout },
      deps,
    )

    expect(capturedRelays).toEqual(customRelays)
    expect(capturedTimeout).toBe(customTimeout)
  })

  it('uses default relays and timeout when not specified', async () => {
    let capturedRelays: string[] = []
    let capturedTimeout = 0

    const deps: SearchDeps = {
      subscribeEvents: async (relays, _kinds, timeout, _filters?: SubscribeFilters) => {
        capturedRelays = relays
        capturedTimeout = timeout
        return []
      },
    }

    await handleSearch({ query: 'test' }, deps)

    expect(capturedRelays.length).toBeGreaterThan(0)
    expect(capturedTimeout).toBe(5000)
  })

  it('returns safe error when subscribeEvents throws', async () => {
    const deps: SearchDeps = {
      subscribeEvents: async () => { throw new Error('relay connection failed: ws://internal.relay:7000') },
    }

    const result = await handleSearch({ query: 'test' }, deps)
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed.error).toBeDefined()
    expect(result.isError).toBe(true)
  })

  it('includes capability endpoints in search results', async () => {
    const event = makeEvent({
      content: JSON.stringify({
        capabilities: [
          { name: 'chat', description: 'Chat completion', endpoint: '/v1/chat' },
        ],
      }),
    })

    const result = await handleSearch({ query: 'chat' }, mockDeps([event]))
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed).toHaveLength(1)
    expect(parsed[0].capabilities).toEqual([
      { name: 'chat', description: 'Chat completion', endpoint: '/v1/chat' },
    ])
  })

  it('deduplicates events by pubkey + d tag, keeping newest', async () => {
    const now = Math.floor(Date.now() / 1000)
    const oldEvent = makeEvent({
      id: 'evt-old',
      created_at: now - 3600,
      content: JSON.stringify({
        capabilities: [{ name: 'chat', description: 'Old version' }],
      }),
    })
    const newEvent = makeEvent({
      id: 'evt-new',
      created_at: now,
      content: JSON.stringify({
        capabilities: [{ name: 'chat', description: 'New version', endpoint: '/v1/chat' }],
      }),
    })

    // Both events have same pubkey + d tag — should deduplicate to newest
    const result = await handleSearch({ query: 'chat' }, mockDeps([oldEvent, newEvent]))
    const parsed = JSON.parse(result.content[0].text)

    expect(parsed).toHaveLength(1)
    expect(parsed[0].capabilities[0].description).toBe('New version')
    expect(parsed[0].capabilities[0].endpoint).toBe('/v1/chat')
  })

  it('matches query against name, about, and capabilities', async () => {
    const event = makeEvent({
      tags: [
        ['d', 'svc-hidden'],
        ['name', 'Generic API'],
        ['url', 'https://generic.example.com'],
        ['about', 'Provides image generation'],
        ['pmi', 'bitcoin-lightning-bolt11'],
      ],
      content: JSON.stringify({
        capabilities: [{ name: 'generate', description: 'Generate images' }],
      }),
    })

    // Match on about
    const r1 = await handleSearch({ query: 'image' }, mockDeps([event]))
    expect(JSON.parse(r1.content[0].text)).toHaveLength(1)

    // Match on capability description
    const r2 = await handleSearch({ query: 'generate' }, mockDeps([event]))
    expect(JSON.parse(r2.content[0].text)).toHaveLength(1)

    // Match on name
    const r3 = await handleSearch({ query: 'Generic' }, mockDeps([event]))
    expect(JSON.parse(r3.content[0].text)).toHaveLength(1)
  })
})
