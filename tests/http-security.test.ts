import { describe, it, expect, vi } from 'vitest'
import type { Request, Response } from 'express'
import { allowedHostsFor, bearerAuth } from '../src/http-security.js'

describe('allowedHostsFor', () => {
  it('accepts only loopback names, with the port, on a loopback bind', () => {
    expect(allowedHostsFor('127.0.0.1', 3402)).toEqual(['localhost:3402', '127.0.0.1:3402', '[::1]:3402'])
  })

  it('accepts the bound address and any listed extra hosts', () => {
    expect(allowedHostsFor('10.0.0.5', 3402, ['mcp.example.com'])).toEqual(['10.0.0.5:3402', 'mcp.example.com'])
  })

  it('accepts nothing implicit on a wildcard bind', () => {
    expect(allowedHostsFor('0.0.0.0', 3402)).toEqual([])
  })
})

describe('bearerAuth', () => {
  const TOKEN = 'ab'.repeat(32)

  function run(authorization?: string) {
    const next = vi.fn()
    const res = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() }
    bearerAuth(TOKEN)({ headers: { authorization } } as unknown as Request, res as unknown as Response, next)
    return { next, res }
  }

  it('lets the right token through', () => {
    expect(run(`Bearer ${TOKEN}`).next).toHaveBeenCalled()
  })

  it.each([undefined, '', `Bearer ${'cd'.repeat(32)}`, TOKEN, `Basic ${TOKEN}`])('refuses %s with 401', (header) => {
    const { next, res } = run(header)
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
  })
})
