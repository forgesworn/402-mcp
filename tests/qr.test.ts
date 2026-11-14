import { describe, it, expect } from 'vitest'
import { inflateSync } from 'node:zlib'
import { decode, encode } from '@forgesworn/qr'
import { renderInvoiceQr } from '../src/qr.js'

const INVOICE =
  'lnbc10u1p3q9xhppp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp'

function readPng(dataUrl: string): { width: number; height: number; pixels: Uint8Array } {
  expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true)
  const buf = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64')
  expect([...buf.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  expect(buf[24]).toBe(8)
  expect(buf[25]).toBe(0)
  const idatLength = buf.readUInt32BE(33)
  expect(buf.toString('latin1', 37, 41)).toBe('IDAT')
  const raw = inflateSync(buf.subarray(41, 41 + idatLength))
  expect(raw.length).toBe((width + 1) * height)
  const pixels = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    expect(raw[y * (width + 1)]).toBe(0)
    pixels.set(raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)), y * width)
  }
  return { width, height, pixels }
}

describe('renderInvoiceQr', () => {
  it('draws a PNG at four pixels a module with a two-module quiet zone, and it reads back', () => {
    const upper = INVOICE.toUpperCase()
    const qr = encode(upper, { ecc: 'M' })
    const { png } = renderInvoiceQr(INVOICE)
    const { width, height, pixels } = readPng(png)
    expect(width).toBe((qr.size + 4) * 4)
    expect(height).toBe(width)
    // quiet zone is white, finder corner is black
    expect(pixels[0]).toBe(255)
    expect(pixels[(2 * 4) * width + 2 * 4]).toBe(0)
    const rgba = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < pixels.length; i++) {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = pixels[i]
      rgba[i * 4 + 3] = 255
    }
    expect(decode({ data: rgba, width, height })?.text).toBe(upper)
  })

  it('returns half-block text without ANSI escapes, one line per two module rows', () => {
    const { text } = renderInvoiceQr(INVOICE)
    const qr = encode(INVOICE.toUpperCase(), { ecc: 'L' })
    expect(text).not.toContain('\u001b')
    expect(text.split('\n')).toHaveLength(Math.ceil((qr.size + 4) / 2))
    expect(text).toMatch(/[▀▄█]/)
  })
})
