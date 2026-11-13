import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

/** The official client owns and initializes the real adapter process. */
export async function openBrowserMcp(command: string, args: string[], env: Record<string, string>) {
  const client = new Client({ name: 'agentmux-browser-consumer-test', version: '0.1.0' })
  const transport = new StdioClientTransport({ command, args, env, stderr: 'pipe' })
  await client.connect(transport)
  return { client, transport, close: () => client.close() }
}
