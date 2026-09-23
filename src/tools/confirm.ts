import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

/**
 * Outcome of asking the human directly. `unsupported` means the client cannot
 * show an elicitation form, so nobody was asked.
 */
export type HumanConfirmation = 'accepted' | 'declined' | 'unsupported'

export type ConfirmWithHuman = (message: string) => Promise<HumanConfirmation>

/**
 * Asks the human through MCP elicitation. The answer comes from the client's
 * own UI, not from the agent, so an agent cannot approve its own request.
 */
export function createElicitConfirm(server: McpServer): ConfirmWithHuman {
  return async (message: string) => {
    if (!server.server.getClientCapabilities()?.elicitation) return 'unsupported'
    try {
      const result = await server.server.elicitInput({
        message,
        requestedSchema: {
          type: 'object',
          properties: {
            confirm: { type: 'boolean', title: 'I approve', description: message },
          },
          required: ['confirm'],
        },
      })
      return result.action === 'accept' && result.content?.confirm === true ? 'accepted' : 'declined'
    } catch {
      return 'unsupported'
    }
  }
}
