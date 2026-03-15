import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CredentialStore } from '../store/credentials.js'

/** Lists all stored L402 credentials with their cached balances, redacting secret material. */
export function handleCredentials(store: CredentialStore) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ credentials: store.listSafe() }, null, 2),
    }],
  }
}

/** Registers the l402_credentials tool with the MCP server. */
export function registerCredentialsTool(server: McpServer, store: CredentialStore): void {
  server.registerTool(
    'l402_credentials',
    {
      description: 'List all stored L402 credentials. Shows origin, cached credit balance, and server type. Balance values are cached and may be stale; check lastUsed timestamp.',
      inputSchema: {},
    },
    async () => handleCredentials(store),
  )
}
