import { readFileSync } from 'node:fs'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { handleSearch, type SearchDeps } from '../../src/tools/search.js'
import { handleFetch, type FetchDeps } from '../../src/tools/fetch.js'
import { handlePay, type PayDeps } from '../../src/tools/pay.js'
import { unwrapUntrusted } from '../../src/tools/untrusted.js'
const now = 1800000300
function event(name: string) { return JSON.parse(readFileSync(`node_modules/402-announce/fixtures/storage-v1/${name}.json`,'utf8')).signed_event }
afterEach(() => vi.restoreAllMocks())
const read = (result: Awaited<ReturnType<typeof handleSearch>>) => JSON.parse(result.content[0].text)
describe('storage discovery remains descriptive', () => {
  it('describes paid checkout and free mirror shelter without a node or wallet request', async () => {
    vi.spyOn(Date,'now').mockReturnValue(now*1000)
    const paid = read(await handleSearch({query:''},{subscribeEvents:async () => [event('paid')]}))[0]
    expect(paid.paymentMethods).toEqual(['wildbloom-checkout','wildbloom-checkout'])
    expect(paid.storage.paymentFlow).toBe('wildbloom-checkout-v1')
    expect(paid.storage.autoPaySupported).toBe(false)
    expect(unwrapUntrusted(paid.storage.description)).toContain('price_msat')
    const free = read(await handleSearch({query:''},{subscribeEvents:async () => [event('free')]}))[0]
    expect(free.paymentMethods).toEqual([])
    expect(free.storage.services[0].type).toBe('free-mirror')
  })
  it('selects latest before filtering and keeps expiry/withdrawal watermarks across calls', async () => {
    vi.spyOn(Date,'now').mockReturnValue(now*1000)
    let events = [event('paid'),event('withdrawn')]
    const deps: SearchDeps = {subscribeEvents:async () => events}
    expect(read(await handleSearch({query:''},deps))).toEqual([])
    events = [event('paid')]
    expect(read(await handleSearch({query:''},deps))).toEqual([])
    expect(read(await handleSearch({query:''},{subscribeEvents:async () => [event('paid'),event('expired')]}))).toEqual([])
    expect(read(await handleSearch({query:''},{subscribeEvents:async () => [event('reject-fake-l402')]}))).toEqual([])
  })
  it('keeps full storage visible as an unavailable claim', async () => {
    vi.spyOn(Date,'now').mockReturnValue(now*1000)
    const full = read(await handleSearch({query:''},{subscribeEvents:async () => [event('paid'),event('full')]}))[0]
    expect(full.storage.services.every((s: {availability:string}) => s.availability === 'full')).toBe(true)
  })
  it('does not leak a cached result into an unrelated topic search',async () => {
    vi.spyOn(Date,'now').mockReturnValue(now*1000)
    let events = [event('paid')]
    const deps: SearchDeps = {subscribeEvents:async () => events}
    expect(read(await handleSearch({query:'',topics:['storage']},deps))).toHaveLength(1)
    events = []
    expect(read(await handleSearch({query:'',topics:['unrelated']},deps))).toEqual([])
  })
  it('refuses unsupported checkout before credential, network, wallet or ledger access', async () => {
    const deps = new Proxy({}, {get() { throw Error('Unexpected dependency access') }})
    expect((await handleFetch({url:'https://storage.example/',autoPay:true,paymentFlow:'wildbloom-checkout-v1'},deps as FetchDeps)).isError).toBe(true)
    expect((await handleFetch({url:'https://storage.example/checkout/v1/orders',method:'POST'},deps as FetchDeps)).isError).toBe(true)
    expect((await handlePay({invoice:'lnbc...',paymentFlow:'wildbloom-checkout-v1'},deps as PayDeps)).isError).toBe(true)
  })
})
