import { readFile } from 'node:fs/promises'
const input = JSON.parse(await readFile(process.argv[2], 'utf8'))
const ownerModule = process.env.AGENTMUX_HISTORY_CORE_MODULE ?? new URL('../../dist/client.js', import.meta.url).href
const { AgentMuxClient } = await import(ownerModule)
const { AgentMuxFileAgentSessionStore } = await import(new URL('./agent-session-store.js', ownerModule).href)
const client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(input.storePath) })
try {
  const result = await client.sessionHistoryResource(input.agentSessionId, input.request)
  process.stdout.write(JSON.stringify({ pid: process.pid, result }))
} finally { await client.dispose() }
