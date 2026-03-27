import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

const bundle = readFileSync(
  require.resolve('@modelcontextprotocol/ext-apps/app-with-deps'), 'utf8',
).replace(/export\{([^}]+)\};?\s*$/, (_, body) =>
  'globalThis.ExtApps={' +
  body.split(',').map((p) => {
    const [local, exported] = p.split(' as ').map((s) => s.trim())
    return `${exported ?? local}:${local}`
  }).join(',') + '};',
)

const srcDir = join(__dirname, 'src')
const outDir = join(__dirname, 'dist')
mkdirSync(outDir, { recursive: true })

for (const name of ['payment-confirmation', 'service-directory', 'wallet-dashboard']) {
  const html = readFileSync(join(srcDir, `${name}.html`), 'utf8')
    .replace('/*__EXT_APPS_BUNDLE__*/', () => bundle)
  writeFileSync(join(outDir, `${name}.html`), html)
}
console.error('Built 3 widgets to', outDir)
