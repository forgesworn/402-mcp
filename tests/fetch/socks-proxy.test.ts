import { describe, it, expect, afterEach } from 'vitest'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createNetServer, connect, type Server as NetServer, type AddressInfo } from 'node:net'
import { parseSocksProxyUrl, createSocksFetch, usesProxy } from '../../src/fetch/socks-proxy.js'
import { createResilientFetch } from '../../src/fetch/resilient-fetch.js'
import { SsrfError } from '../../src/fetch/errors.js'

describe('parseSocksProxyUrl', () => {
  it.each([
    ['socks5://127.0.0.1:9050', 'socks5://127.0.0.1:9050'],
    ['socks5h://127.0.0.1:9050', 'socks5://127.0.0.1:9050'],
    ['socks://tor:9050/', 'socks5://tor:9050'],
    ['socks5h://user:pass@127.0.0.1:1080', 'socks5://user:pass@127.0.0.1:1080'],
  ])('normalises %s', (raw, expected) => {
    expect(parseSocksProxyUrl('TOR_PROXY', raw)).toBe(expected)
  })

  it.each([
    ['http://127.0.0.1:8080', /socks5/],
    ['socks4://127.0.0.1:9050', /socks5/],
    ['socks5://127.0.0.1', /host and port/],
    ['socks5://127.0.0.1:9050/path', /path/],
    ['not a url', /unparseable/],
  ])('refuses %s', (raw, message) => {
    expect(() => parseSocksProxyUrl('SOCKS_PROXY', raw)).toThrow(message)
  })
})

describe('usesProxy', () => {
  const route = (scope: 'onion' | 'all') => ({ scope, fetchFn: fetch })
  it('sends only .onion hosts through an onion-scoped proxy', () => {
    expect(usesProxy(route('onion'), 'abc.onion')).toBe(true)
    expect(usesProxy(route('onion'), 'ABC.ONION.')).toBe(true)
    expect(usesProxy(route('onion'), 'example.com')).toBe(false)
  })
  it('sends everything through an all-scoped proxy', () => {
    expect(usesProxy(route('all'), 'example.com')).toBe(true)
  })
  it('sends nothing through a missing proxy', () => {
    expect(usesProxy(undefined, 'abc.onion')).toBe(false)
  })
})

/**
 * A minimal SOCKS5 server (no auth, CONNECT only) that records what it was
 * asked to connect to and sends every connection to one local target.
 */
function startSocks(targetPort: number): Promise<{ server: NetServer; port: number; requested: string[] }> {
  const requested: string[] = []
  const server = createNetServer((client) => {
    client.once('data', () => {
      client.write(Buffer.from([0x05, 0x00]))
      client.once('data', (req) => {
        const atyp = req[3]
        let host: string
        let offset: number
        if (atyp === 0x03) {
          const len = req[4]
          host = req.subarray(5, 5 + len).toString()
          offset = 5 + len
        } else if (atyp === 0x01) {
          host = Array.from(req.subarray(4, 8)).join('.')
          offset = 8
        } else {
          client.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          return
        }
        requested.push(`${host}:${req.readUInt16BE(offset)}`)
        const upstream = connect(targetPort, '127.0.0.1', () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]))
          client.pipe(upstream).pipe(client)
        })
        upstream.on('error', () => client.destroy())
      })
    })
    client.on('error', () => {})
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ server, port: (server.address() as AddressInfo).port, requested })
  }))
}

describe('SOCKS5 routing end to end', () => {
  const servers: Array<Server | NetServer> = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(undefined)))))
  })

  async function setup() {
    const http = createHttpServer((req, res) => res.end(`host=${req.headers.host}`))
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()))
    servers.push(http)
    const socks = await startSocks((http.address() as AddressInfo).port)
    servers.push(socks.server)
    return { socks, fetchFn: createSocksFetch(`socks5://127.0.0.1:${socks.port}`) }
  }

  it('reaches a .onion host through the proxy, which does the name resolution', async () => {
    const { socks, fetchFn } = await setup()
    const direct = async () => { throw new Error('direct fetch used for a proxied host') }
    const resilient = createResilientFetch(direct as unknown as typeof fetch, {
      retries: 0,
      proxy: { scope: 'onion', fetchFn },
    })

    const res = await resilient('http://exampleonionaddress.onion/data')
    expect(await res.text()).toBe('host=exampleonionaddress.onion')
    expect(socks.requested).toEqual(['exampleonionaddress.onion:80'])
  })

  it('sends clearnet names to the proxy unresolved when every request is proxied', async () => {
    const { socks, fetchFn } = await setup()
    const direct = async () => { throw new Error('direct fetch used for a proxied host') }
    const resilient = createResilientFetch(direct as unknown as typeof fetch, {
      retries: 0,
      proxy: { scope: 'all', fetchFn },
    })

    // .invalid never resolves: reaching the server proves no local lookup was needed.
    const res = await resilient('http://paid-api.invalid/data')
    expect(await res.text()).toBe('host=paid-api.invalid')
    expect(socks.requested).toEqual(['paid-api.invalid:80'])
  })

  it('still refuses private IP literals and local names when every request is proxied', async () => {
    const { socks, fetchFn } = await setup()
    const resilient = createResilientFetch(fetch, { retries: 0, proxy: { scope: 'all', fetchFn } })

    await expect(resilient('http://127.0.0.1/admin')).rejects.toBeInstanceOf(SsrfError)
    await expect(resilient('http://169.254.169.254/latest')).rejects.toBeInstanceOf(SsrfError)
    await expect(resilient('http://printer.local/')).rejects.toBeInstanceOf(SsrfError)
    await expect(resilient('http://localhost:8080/')).rejects.toBeInstanceOf(SsrfError)
    expect(socks.requested).toEqual([])
  })
})
