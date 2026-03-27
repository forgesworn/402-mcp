import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server'
import {
  paymentConfirmationHtml,
  serviceDirectoryHtml,
  walletDashboardHtml,
} from '../widgets/index.js'

/**
 * Registers MCP App widgets (tools + resources) for interactive UIs.
 * All three widgets gracefully degrade: the tool response is always meaningful
 * JSON, so non-widget hosts still get structured data.
 */
export function registerWidgets(server: McpServer): void {
  // ── Payment Confirmation ──────────────────────────────────────────
  // Paired with l402-fetch-preview: the widget renders a confirm/cancel
  // dialog driven by the preview result.

  registerAppResource(
    server,
    'Payment Confirmation',
    'ui://402-mcp/payment-confirmation.html',
    { description: 'Payment confirmation dialog for L402/x402/xcashu services' },
    async () => ({
      contents: [{
        uri: 'ui://402-mcp/payment-confirmation.html',
        mimeType: RESOURCE_MIME_TYPE,
        text: paymentConfirmationHtml,
      }],
    }),
  )

  // Note: l402-fetch-preview is registered separately (in index.ts) because
  // it needs FetchPreviewDeps injection. This resource just provides the HTML.

  // ── Service Directory ─────────────────────────────────────────────
  // Calls l402-search on mount and renders a searchable card list.

  registerAppTool(
    server,
    'l402-service-directory',
    {
      title: 'Service Directory',
      description: 'Browse and search paid API services. Opens an interactive directory of L402/x402 services discovered on Nostr. Calls l402-search internally.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {},
      _meta: {
        ui: { resourceUri: 'ui://402-mcp/service-directory.html' },
      },
    },
    async () => ({
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          widgetHint: 'service-directory',
          message: 'Service directory widget loaded. Use l402-search for text-based results.',
        }),
      }],
    }),
  )

  registerAppResource(
    server,
    'Service Directory',
    'ui://402-mcp/service-directory.html',
    { description: 'Searchable directory of paid API services' },
    async () => ({
      contents: [{
        uri: 'ui://402-mcp/service-directory.html',
        mimeType: RESOURCE_MIME_TYPE,
        text: serviceDirectoryHtml,
      }],
    }),
  )

  // ── Wallet Dashboard ──────────────────────────────────────────────
  // Calls l402-config and l402-credentials on mount, shows wallet state.

  registerAppTool(
    server,
    'l402-wallet-dashboard',
    {
      title: 'Wallet Dashboard',
      description: 'View wallet status, balances, and stored credentials. Opens an interactive dashboard showing NWC connection, Cashu balance, auto-pay limit, and credential list.',
      annotations: { readOnlyHint: true },
      inputSchema: {},
      _meta: {
        ui: { resourceUri: 'ui://402-mcp/wallet-dashboard.html' },
      },
    },
    async () => ({
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          widgetHint: 'wallet-dashboard',
          message: 'Wallet dashboard widget loaded. Use l402-config and l402-credentials for text-based data.',
        }),
      }],
    }),
  )

  registerAppResource(
    server,
    'Wallet Dashboard',
    'ui://402-mcp/wallet-dashboard.html',
    { description: 'Wallet status dashboard with credentials and balances' },
    async () => ({
      contents: [{
        uri: 'ui://402-mcp/wallet-dashboard.html',
        mimeType: RESOURCE_MIME_TYPE,
        text: walletDashboardHtml,
      }],
    }),
  )
}
