import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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

  it('accepts valid defaults (no env vars set)', async () => {
    const { loadConfig } = await import('../src/config.js')
    expect(() => loadConfig()).not.toThrow()
  })

  // Issue #2: NWC_URI scrubbed from process.env
  it('deletes NWC_URI from process.env after reading', async () => {
    vi.stubEnv('NWC_URI', 'nostr+walletconnect://pubkey?secret=deadbeef')
    const { loadConfig } = await import('../src/config.js')
    const config = loadConfig()
    expect(config.nwcUri).toBe('nostr+walletconnect://pubkey?secret=deadbeef')
    expect(process.env.NWC_URI).toBeUndefined()
  })

  it('leaves process.env unchanged when NWC_URI is not set', async () => {
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

  it('accepts TRANSPORT=http', async () => {
    vi.stubEnv('TRANSPORT', 'http')
    const { loadConfig } = await import('../src/config.js')
    expect(loadConfig().transport).toBe('http')
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
    vi.stubEnv('CREDENTIAL_STORE', `${homedir()}/.l402-mcp/test-creds.json`)
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

  it('warns on non-loopback BIND_ADDRESS with HTTP transport', async () => {
    vi.stubEnv('TRANSPORT', 'http')
    vi.stubEnv('BIND_ADDRESS', '0.0.0.0')
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { loadConfig } = await import('../src/config.js')
    loadConfig()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('network-accessible without authentication'),
    )
    warnSpy.mockRestore()
  })

  it('warns when NODE_TLS_REJECT_UNAUTHORIZED is 0', async () => {
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0')
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { loadConfig } = await import('../src/config.js')
    loadConfig()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('TLS certificate validation is disabled'),
    )
    warnSpy.mockRestore()
  })
})
