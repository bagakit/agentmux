import { tmpdir as fixtureTmpdir } from 'node:os'
import { join as fixtureJoin, sep as fixtureSep } from 'node:path'
const fixturePath = relative => { const temporary = relative.replace(/^(?:private\/)?tmp\//u, ''); return (temporary === relative ? fixtureJoin(fixtureTmpdir(), 'agentmux-fixtures') : fixtureTmpdir()) + fixtureSep + temporary.replaceAll('/', fixtureSep) }
import fs, { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import childProcess from 'node:child_process'
const originalFork = childProcess.fork
childProcess.fork = (entry, args, options) => originalFork(entry, args, {
  ...options,
  ...(existsSync(join(process.env.AGENTMUX_STATE_DIRECTORY, 'listener-spawn-failure')) ? { execPath: join(process.env.AGENTMUX_STATE_DIRECTORY, 'missing-node') } : {})
})
const originalLink = fs.promises.link
const originalRm = fs.promises.rm
fs.promises.rm = async (path, ...args) => {
  if (existsSync(join(process.env.AGENTMUX_STATE_DIRECTORY, 'publication-cleanup-failure')) && String(path).includes('/c/') && !String(path).endsWith("/headless.sock")) {
    throw Object.assign(new Error('Private fixture candidate cleanup failed.'), { code: 'EIO' })
  }
  return await originalRm(path, ...args)
}
fs.promises.link = async (...args) => {
  if (existsSync(join(process.env.AGENTMUX_STATE_DIRECTORY, 'publication-pressure'))) {
    appendFileSync(join(process.env.AGENTMUX_STATE_DIRECTORY, 'publication-pressure-attempts'), 'link\n')
    throw Object.assign(new Error('Private fixture filesystem cannot publish while resource pressure persists.'), { code: 'ENOSPC' })
  }
  return await originalLink(...args)
}
syncBuiltinESMExports()
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
const owner = await startHeadlessAgentMux({ ...(process.env.AGENTMUX_TEST_MEMORY_STORE === '1' ? { store: new AgentMuxMemoryAgentSessionStore() } : {}), providers: [fixture], socketPath: join(process.env.AGENTMUX_STATE_DIRECTORY, '../c', 'headless.sock') })
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
