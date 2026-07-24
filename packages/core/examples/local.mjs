import {
  AgentMuxClient,
  activateAgentMuxLocalDaemon
} from '@agentmux/core'

await activateAgentMuxLocalDaemon()
const client = new AgentMuxClient()
await client.connect()
const output = new Promise((resolve) => {
  const unsubscribe = client.onEvent((event) => {
    if (event.type !== 'terminal-output' || !event.data.includes('agentmux-local-ready')) return
    unsubscribe()
    resolve()
  })
})
const terminal = await client.createTerminal({
  sessionId: crypto.randomUUID(),
  createOperationId: crypto.randomUUID(),
  cwd: process.cwd()
})
await client.writeTerminal(terminal, "printf 'agentmux-local-ready\\n'\n")
await output
await client.stopTerminal(terminal)
await client.dispose()
