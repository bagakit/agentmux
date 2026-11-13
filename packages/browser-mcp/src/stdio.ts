#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { agentMuxRpcEndpoint, agentMuxRpcEnvironmentCredentials, AgentMuxError } from '@agentmux/core'
import { createBrowserMcpServer } from './index.js'

const args = process.argv.slice(2)
if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
  process.stdout.write('agentmux-browser-mcp --endpoint RPC_URI\n\nServes the original Browser RPC owner over MCP stdio. Endpoint is explicit; managed Session/capability credentials come from the original AgentMux environment. Tools require exact Browser or operation IDs.\n')
} else if (args.length !== 2 || args[0] !== '--endpoint' || !args[1]) {
  process.stderr.write('Usage: agentmux-browser-mcp --endpoint RPC_URI\n'); process.exitCode = 1
} else {
  try {
    const endpoint = agentMuxRpcEndpoint(args[1]), credentials = agentMuxRpcEnvironmentCredentials()
    serveStdio(() => createBrowserMcpServer({ endpoint, ...(credentials ? { credentials } : {}) }), { onerror: () => { process.stderr.write('MCP transport is unavailable; inspect the original Browser operation before another action.\n') } })
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: { code: error instanceof AgentMuxError ? error.code : 'BROWSER_ADAPTER_UNAVAILABLE', message: error instanceof Error ? error.message : 'Browser adapter could not connect.' } }) + '\n')
    process.exitCode = 1
  }
}
