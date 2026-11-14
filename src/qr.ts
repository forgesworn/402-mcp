import { crc32, deflateSync } from 'node:zlib'
import { encode, toTerminal, type QrCode } from '@forgesworn/qr'

/** Quiet zone in modules, for both renderings. */
const MARGIN = 2
/** Pixels per module in the PNG. */
const SCALE = 4

function chunk(type: string, body: Buffer): Buffer {
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body])
  const out = Buffer.alloc(typed.length + 8)
  out.writeUInt32BE(body.length, 0)
  typed.copy(out, 4)
  out.writeUInt32BE(crc32(typed), typed.length + 4)
  return out
}

/** Draws a code as an 8-bit greyscale PNG, black on white, with a quiet zone. */
export function qrPng(qr: QrCode, margin = MARGIN, scale = SCALE): Buffer {
  const side = (qr.size + margin * 2) * scale
  const raw = Buffer.alloc((side + 1) * side, 255) // each row starts with filter type 0
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y * qr.size + x] !== 1) continue
      for (let dy = 0; dy < scale; dy++) {
        const row = (y + margin) * scale + dy
        const start = row * (side + 1) + 1 + (x + margin) * scale
        raw.fill(0, start, start + scale)
      }
    }
  }
  for (let row = 0; row < side; row++) raw[row * (side + 1)] = 0
  const header = Buffer.alloc(13)
  header.writeUInt32BE(side, 0)
  header.writeUInt32BE(side, 4)
  header[8] = 8 // bit depth
  header[9] = 0 // greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * A payment request as a PNG data URL (for graphical clients) and as
 * half-block text (for terminals). The request is upper-cased so it fits
 * alphanumeric mode, which keeps the code small.
 */
export function renderInvoiceQr(invoice: string): { png: string; text: string } {
  const upper = invoice.toUpperCase()
  const png = qrPng(encode(upper, { ecc: 'M' }))
  const text = toTerminal(encode(upper, { ecc: 'L' }), { margin: MARGIN })
  return { png: `data:image/png;base64,${png.toString('base64')}`, text }
}
