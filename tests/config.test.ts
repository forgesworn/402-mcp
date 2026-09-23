import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const VALID_NWC_URI = `nostr+walletconnect://${'01'.padStart(64, '0')}?relay=wss%3A%2F%2Frelay.example.com&secret=${'02'.padStart(64, '0')}`

describe('config validation', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('throws on negative MAX_AUTO_PAY_SATS', async () => {
    vi.stubEnv('MAX_AUTO_PAY_SATS', '-100')
    const { loadConfig } = await import('../src/config.js')
    expect(() => loadConfig()).toThrow('MAX_AUTO_PAY_SATS')
    expect(() => loadConfig()).toThrow('positive integer')
  })

  it('throws on non-numeric MAX_AUTO_PAY_SATS', async () => {
    vi.stubEnv('MAX_AUTO_PAY_SATS', 'abc')
    const { loadConfig } = await import('../src/config.js')
    expect(() => loadConfig()).toThrow('MAX_AUTO_PAY_SATS')
  })

  it('throws on PORT out of range', async () => {
    vi.stubEnv('PORT', '99999')
    const { loadConfig } = await import('../src/config.js')
    expect(() => loadConfig()).toThrow('PORT')
  })

  it('throws on PORT = 0', async () => {
    vi.stubEnv('PORT', '0')
    const { loadConfig } = await import('../src/config.js')
    expect(() => loadConfig()).toThrow('PORT')
  })

  it('throws on negative FETCH_TIMEOUT_MS', async () => {
    vi.stubEnv('FETCH_TIMEOUT_MS', '-1')
    const { loadConfig } = await import('../src/config.js')
    expect(() => loadConfig()).toThrow('FETCH_TIMEOUT_MS')
  })

  it('accepts FETCH_MAX_RETRIES = 0', async () => {
    vi.stubEnv('FETCH_MAX_RETRIES', '0')
    const { loadConfig } = await import('../src/config.js')
    expect(() => loadConfig()).not.toThrow()
  })

  it('throws on negative FETCH_MAX_RETRIES', async () => {
    vi.stubEnv('FETCH_MAX_RETRIES', '-1')
    const { loadConfig } = await import('../src/config.js')
    expect(() => loadConfig()).toThrow('FETCH_MAX_RETRIES')
  })

  it('defaults MAX_SPEND_PER_DAY_SATS to 5000 and rejects a negative one', async () => {
    const { loadConfig } = await import('../src/config.js')
    expect(loadConfig().maxSpendPerDaySats).toBe(5000)
    vi.stubEnv('MAX_SPEND_PER_DAY_SATS', '-1')
    expect(() => loadConfig()).toThrow('MAX_SPEND_PER_DAY_SATS')
  })

  it('accepts valid defaults (no env vars set)', async () => {
    const { loadConfig } = await import('../src/config.js')
    expect(() => loadConfig()).not.toThrow()
  })

  it('deletes and refuses a raw NWC_URI', async () => {
    vi.stubEnv('NWC_URI', 'nostr+walletconnect://pubkey?secret=deadbeef')
    const { loadConfig } = await import('../src/config.js')
    expect(() => loadConfig()).toThrow('NWC_URI is disabled')
    expect(process.env.NWC_URI).toBeUndefined()
  })

  it('loads NWC only from a private bounded file and deletes its env path', async () => {
    const directory = mkdtempSync(join(tmpdir(), '402-mcp-nwc-'))
    try {
      const secretFile = join(directory, 'wallet.nwc')
      writeFileSync(secretFile, `${VALID_NWC_URI}\n`, { mode: 0o600 })
      vi.stubEnv('NWC_URI_FILE', secretFile)
      const { loadConfig } = await import('../src/config.js')
      expect(loadConfig().nwcUri).toBe(VALID_NWC_URI)
      expect(process.env.NWC_URI_FILE).toBeUndefined()

      if (process.platform !== 'win32') {
        chmodSync(secretFile, 0o644)
        vi.stubEnv('NWC_URI_FILE', secretFile)
        expect(() => loadConfig()).toThrow('chmod 600')
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('leaves the NWC connection unset when NWC_URI_FILE is not set', async () => {
    const { loadConfig } = await import('../src/config.js')
    const config = loadConfig()
    expect(config.nwcUri).toBeUndefined()
  })

  // Issue #3: TRANSPORT validation
  it('accepts TRANSPORT=stdio', async () => {
    vi.stubEnv('TRANSPORT', 'stdio')
    const { loadConfig } = await import('../src/config.js')
    expect(loadConfig().transport).toBe('stdio')
  })

  describe('HTTP transport', () => {
    let directory: string
    let tokenFile: string
    const TOKEN = 'ab'.repeat(32)

    beforeEach(() => {
      directory = mkdtempSync(join(tmpdir(), '402-mcp-http-'))
      tokenFile = join(directory, 'http.token')
      writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 })
    })

    afterEach(() => {
      rmSync(directory, { recursive: true, force: true })
    })

    it('accepts TRANSPORT=http with a private token file', async () => {
      vi.stubEnv('TRANSPORT', 'http')
      vi.stubEnv('HTTP_AUTH_TOKEN_FILE', tokenFile)
      const { loadConfig } = await import('../src/config.js')
      const config = loadConfig()
      expect(config.transport).toBe('http')
      expect(config.httpAuthToken).toBe(TOKEN)
      expect(process.env.HTTP_AUTH_TOKEN_FILE).toBeUndefined()
    })

    it('refuses to start without a token file', async () => {
      vi.stubEnv('TRANSPORT', 'http')
      const { loadConfig } = await import('../src/config.js')
      expect(() => loadConfig()).toThrow('HTTP_AUTH_TOKEN_FILE')
    })

    it('refuses a token in the environment, a short token and a world-readable file', async () => {
      const { loadConfig } = await import('../src/config.js')
      vi.stubEnv('TRANSPORT', 'http')
      vi.stubEnv('HTTP_AUTH_TOKEN', TOKEN)
      expect(() => loadConfig()).toThrow('HTTP_AUTH_TOKEN is disabled')

      writeFileSync(tokenFile, 'short', { mode: 0o600 })
      vi.stubEnv('HTTP_AUTH_TOKEN_FILE', tokenFile)
      expect(() => loadConfig()).toThrow('at least 32 characters')

      if (process.platform !== 'win32') {
        writeFileSync(tokenFile, TOKEN, { mode: 0o600 })
        chmodSync(tokenFile, 0o644)
        vi.stubEnv('HTTP_AUTH_TOKEN_FILE', tokenFile)
        expect(() => loadConfig()).toThrow('chmod 600')
      }
    })

    it('warns on non-loopback BIND_ADDRESS', async () => {
      vi.stubEnv('TRANSPORT', 'http')
      vi.stubEnv('HTTP_AUTH_TOKEN_FILE', tokenFile)
      vi.stubEnv('BIND_ADDRESS', '0.0.0.0')
      const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { loadConfig } = await import('../src/config.js')
      loadConfig()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('reachable from the network'))
      warnSpy.mockRestore()
    })
  })

  it('throws on invalid TRANSPORT value', async () => {
    vi.stubEnv('TRANSPORT', 'htpp')
    const { loadConfig } = await import('../src/config.js')
    expect(() => loadConfig()).toThrow("TRANSPORT must be 'stdio' or 'http'")
  })

  // Issue #4: Zero values rejected for timeout/interval configs
  it('throws on HUMAN_PAY_TIMEOUT_S = 0', async () => {
    vi.stubEnv('HUMAN_PAY_TIMEOUT_S', '0')
    const { loadConfig } = await import('../src/config.js')
    expect(() => loadConfig()).toThrow('HUMAN_PAY_TIMEOUT_S')
    expect(() => loadConfig()).toThrow('positive integer (> 0)')
  })

  it('throws on HUMAN_PAY_POLL_S = 0', async () => {
    vi.stubEnv('HUMAN_PAY_POLL_S', '0')
    const { loadConfig } = await import('../src/config.js')
    expect(() => loadConfig()).toThrow('HUMAN_PAY_POLL_S')
  })

  it('throws on FETCH_TIMEOUT_MS = 0', async () => {
    vi.stubEnv('FETCH_TIMEOUT_MS', '0')
    const { loadConfig } = await import('../src/config.js')
    expect(() => loadConfig()).toThrow('FETCH_TIMEOUT_MS')
  })

  it('throws on FETCH_MAX_RESPONSE_BYTES = 0', async () => {
    vi.stubEnv('FETCH_MAX_RESPONSE_BYTES', '0')
    const { loadConfig } = await import('../src/config.js')
    expect(() => loadConfig()).toThrow('FETCH_MAX_RESPONSE_BYTES')
  })

  it('throws when CREDENTIAL_STORE escapes home directory', async () => {
    vi.stubEnv('CREDENTIAL_STORE', '/tmp/evil/credentials.json')
    const { loadConfig } = await import('../src/config.js')
    expect(() => loadConfig()).toThrow('CREDENTIAL_STORE must be within the home directory')
  })

  it('accepts CREDENTIAL_STORE within home directory', async () => {
    const { homedir } = await import('node:os')
    vi.stubEnv('CREDENTIAL_STORE', `${homedir()}/.402-mcp/test-creds.json`)
    const { loadConfig } = await import('../src/config.js')
    expect(() => loadConfig()).not.toThrow()
  })

  it('accepts MAX_AUTO_PAY_SATS = 0 (disables auto-pay)', async () => {
    vi.stubEnv('MAX_AUTO_PAY_SATS', '0')
    const { loadConfig } = await import('../src/config.js')
    expect(loadConfig().maxAutoPaySats).toBe(0)
  })

  it('accepts FETCH_MAX_RETRIES = 0 (no retries)', async () => {
    vi.stubEnv('FETCH_MAX_RETRIES', '0')
    const { loadConfig } = await import('../src/config.js')
    expect(loadConfig().fetchMaxRetries).toBe(0)
  })

  it('throws when CASHU_TOKENS is outside home directory', async () => {
    vi.stubEnv('CASHU_TOKENS', '/etc/shadow')
    const { loadConfig } = await import('../src/config.js')
    expect(() => loadConfig()).toThrow('CASHU_TOKENS')
    expect(() => loadConfig()).toThrow('home directory')
  })

  it('throws when NODE_TLS_REJECT_UNAUTHORIZED=0 without opt-in', async () => {
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0')
    const { loadConfig } = await import('../src/config.js')
    expect(() => loadConfig()).toThrow('NODE_TLS_REJECT_UNAUTHORIZED')
    expect(() => loadConfig()).toThrow('ALLOW_INSECURE_TLS')
  })

  it('warns but allows NODE_TLS_REJECT_UNAUTHORIZED=0 with SSRF_ALLOW_PRIVATE=true', async () => {
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0')
    vi.stubEnv('SSRF_ALLOW_PRIVATE', 'true')
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { loadConfig } = await import('../src/config.js')
    loadConfig()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('TLS certificate validation is disabled'),
    )
    warnSpy.mockRestore()
  })

  it('warns but allows NODE_TLS_REJECT_UNAUTHORIZED=0 with ALLOW_INSECURE_TLS=true', async () => {
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0')
    vi.stubEnv('ALLOW_INSECURE_TLS', 'true')
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { loadConfig } = await import('../src/config.js')
    const config = loadConfig()
    expect(config.ssrfAllowPrivate).toBe(false) // TLS opt-in should NOT widen SSRF surface
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('TLS certificate validation is disabled'),
    )
    warnSpy.mockRestore()
  })

  // Transport preference
  it('defaults transportPreference to [onion, hns, https, http]', async () => {
    const { loadConfig } = await import('../src/config.js')
    expect(loadConfig().transportPreference).toEqual(['onion', 'hns', 'https', 'http'])
  })

  it('parses TRANSPORT_PREFERENCE env var into array', async () => {
    vi.stubEnv('TRANSPORT_PREFERENCE', 'https,http')
    const { loadConfig } = await import('../src/config.js')
    expect(loadConfig().transportPreference).toEqual(['https', 'http'])
  })

  it('trims whitespace in TRANSPORT_PREFERENCE entries', async () => {
    vi.stubEnv('TRANSPORT_PREFERENCE', ' https , http ')
    const { loadConfig } = await import('../src/config.js')
    expect(loadConfig().transportPreference).toEqual(['https', 'http'])
  })

  it('filters empty entries from TRANSPORT_PREFERENCE', async () => {
    vi.stubEnv('TRANSPORT_PREFERENCE', 'https,,http,')
    const { loadConfig } = await import('../src/config.js')
    expect(loadConfig().transportPreference).toEqual(['https', 'http'])
  })

  // SOCKS proxy
  it('has no proxy when neither TOR_PROXY nor SOCKS_PROXY is set', async () => {
    const { loadConfig } = await import('../src/config.js')
    expect(loadConfig().proxy).toBeUndefined()
  })

  it('routes only .onion through TOR_PROXY', async () => {
    vi.stubEnv('TOR_PROXY', 'socks5h://127.0.0.1:9050')
    const { loadConfig } = await import('../src/config.js')
    expect(loadConfig().proxy).toEqual({ url: 'socks5://127.0.0.1:9050', scope: 'onion' })
  })

  it('routes everything through SOCKS_PROXY', async () => {
    vi.stubEnv('SOCKS_PROXY', 'socks5://127.0.0.1:9150')
    const { loadConfig } = await import('../src/config.js')
    expect(loadConfig().proxy).toEqual({ url: 'socks5://127.0.0.1:9150', scope: 'all' })
  })

  it('refuses TOR_PROXY and SOCKS_PROXY together', async () => {
    vi.stubEnv('TOR_PROXY', 'socks5://127.0.0.1:9050')
    vi.stubEnv('SOCKS_PROXY', 'socks5://127.0.0.1:9150')
    const { loadConfig } = await import('../src/config.js')
    expect(() => loadConfig()).toThrow(/not both/)
  })

  it('refuses a proxy URL that is not SOCKS5', async () => {
    vi.stubEnv('SOCKS_PROXY', 'http://127.0.0.1:8080')
    const { loadConfig } = await import('../src/config.js')
    expect(() => loadConfig()).toThrow(/socks5/)
  })

  // HNS gateway URL
  it('defaults hnsGatewayUrl to https://query.hdns.io/', async () => {
    const { loadConfig } = await import('../src/config.js')
    expect(loadConfig().hnsGatewayUrl).toBe('https://query.hdns.io/')
  })

  it('reads hnsGatewayUrl from HNS_GATEWAY_URL env var', async () => {
    vi.stubEnv('HNS_GATEWAY_URL', 'https://my-hns-gateway.example.com/')
    const { loadConfig } = await import('../src/config.js')
    expect(loadConfig().hnsGatewayUrl).toBe('https://my-hns-gateway.example.com/')
  })
})
