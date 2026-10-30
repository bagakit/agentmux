import { join } from 'node:path'
import { AgentMuxControlServer, AgentMuxHostedRuntimeService } from '@agentmux/core'
import { ConnectionHost } from '@agentmux/connectors'
// This process tests the real durable management owner, without borrowing any
// Agent/runtime I/O or claiming that a native receiver is installed here.
const [directory, runtimeId] = process.argv.slice(2)
const connections = new ConnectionHost({ databasePath: join(directory, 'connections.sqlite'), adapters: [], secrets: { resolve: async () => { throw Error('Journal reads never resolve credentials') } } })
const runtime = new AgentMuxHostedRuntimeService({ onEvent: () => () => {} }, null, () => ({
  runtimeId, ownerInstanceId: 'journal-owner-' + process.pid, protocolVersion: 2, processId: process.pid, ctxmux: null, availability: 'connected'
}))
const server = new AgentMuxControlServer({ socketPath: join(directory, 'journal-process.sock'), connections, coreClients: () => [], hostedRuntime: () => runtime })
await server.start()
process.on('message', async message => { if (message === 'close') { await server.stop(); await runtime.dispose(); connections.close(); process.exit(0) } })
process.send({ kind: 'ready', socketPath: server.path })
