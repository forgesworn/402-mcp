import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { widgetDistDir } from './paths.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function load(name: string): string {
  return readFileSync(join(widgetDistDir(__dirname), `${name}.html`), 'utf8')
}

export const paymentConfirmationHtml = load('payment-confirmation')
export const serviceDirectoryHtml = load('service-directory')
export const walletDashboardHtml = load('wallet-dashboard')
