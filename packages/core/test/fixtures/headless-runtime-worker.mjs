import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { startHeadlessAgentMux, AgentProviderRegistry, AgentMuxError, AgentMuxMemoryAgentSessionStore } from '../../dist/index.js'
const original = new AgentProviderRegistry().get('codex')
const fixture = { ...original,
  probeCapabilities: async (...args) => {
    if (existsSync(join(process.env.AGENTMUX_STATE_DIRECTORY, 'probe-failure'))) throw new Error('fixture Provider probe failed')
    return await original.probeCapabilities(...args)
  },
  readSessionHistoryPage: async context => ({ source: context.source,
    items: [{ id: 'fixture-native-record', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'native history fixture' }] }], nextCursor: null }),
  observeSessionHistory: async context => {
    const timer = setInterval(() => context.onChange({ kind: 'invalidated', source: context.source }), 50)
    return { source: context.source, dispose: () => clearInterval(timer) }
  }
}
const owner = await startHeadlessAgentMux({ ...(process.env.AGENTMUX_TEST_MEMORY_STORE === '1' ? { store: new AgentMuxMemoryAgentSessionStore() } : {}), providers: [fixture], socketPath: join(process.env.AGENTMUX_RUNTIME_DIRECTORY, 'headless.sock') })
// Inject an already-classified native failure at the real owner API boundary.
// The acknowledged prefix is physically written by the original Core/ctxmux path.
const originalWrite = owner.client.writeTerminal.bind(owner.client)
owner.client.writeTerminal = async (run, input) => {
  const path = join(process.env.AGENTMUX_STATE_DIRECTORY, 'input-failure')
  if (!existsSync(path)) return await originalWrite(run, input)
  const failure = JSON.parse(readFileSync(path, 'utf8'))
  appendFileSync(join(process.env.AGENTMUX_STATE_DIRECTORY, 'input-failure-calls'), input.operationId + '\n')
  if (failure.confirmedInputBytes > 0) await originalWrite(run, { ...input, operationId: input.operationId + '-prefix',
    data: Buffer.from(input.data).subarray(0, failure.confirmedInputBytes) })
  throw new AgentMuxError('Original native input failed after its confirmed prefix.', 'CTXMUX_io', failure.disposition, failure)
}
process.stdout.write(JSON.stringify({ owner: owner.ownerIdentity(), socketPath: owner.socketPath }) + '\n')
process.once('SIGTERM', () => { void owner.stop() })
process.once('SIGINT', () => { void owner.stop() })
