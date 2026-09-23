import { createHash, timingSafeEqual } from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

function hostWithPort(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
}

/**
 * Host header values the HTTP transport accepts. The MCP SDK compares the
 * whole header, port included, so a DNS-rebinding page served from another
 * name cannot reach the server even from the user's own browser.
 *
 * A loopback bind accepts the usual loopback names. Any other bind accepts
 * its own address. `extra` (HTTP_ALLOWED_HOSTS) adds names such as the one a
 * reverse proxy forwards, written exactly as clients send them.
 */
export function allowedHostsFor(bindAddress: string, port: number, extra: string[] = []): string[] {
  const hosts = LOOPBACK.has(bindAddress)
    ? ['localhost', '127.0.0.1', '::1'].map(h => hostWithPort(h, port))
    : bindAddress === '0.0.0.0' || bindAddress === '::'
      ? []
      : [hostWithPort(bindAddress, port)]
  return [...new Set([...hosts, ...extra])]
}

/** Express middleware requiring `Authorization: Bearer <token>`, compared in constant time. */
export function bearerAuth(token: string) {
  const expected = createHash('sha256').update(token).digest()
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization ?? ''
    const match = /^Bearer (.+)$/.exec(header)
    const presented = createHash('sha256').update(match ? match[1] : '').digest()
    if (!match || !timingSafeEqual(presented, expected)) {
      res.setHeader('WWW-Authenticate', 'Bearer')
      res.status(401).json({ error: 'Unauthorised' })
      return
    }
    next()
  }
}
