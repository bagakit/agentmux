import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startHeadlessAgentMux, AgentMuxClient, AgentMuxFileAgentSessionStore, AgentProviderRegistry } from '../../dist/index.js'
import { CtxmuxRunAdapter } from '../../dist/ctxmux-run-adapter.js'
import { AsyncLocalStorage } from 'node:async_hooks'
const root = process.env.AGENTMUX_STATE_DIRECTORY
const consumer = new AsyncLocalStorage()
const journal = (file, value) => appendFileSync(join(root, file), JSON.stringify({ pid: process.pid, consumer: consumer.getStore(), ...value }) + '\n')
for (const method of ['statusAgent', 'ensureAgentContinuity', 'resumeAgent']) {
  const original = AgentMuxClient.prototype[method]
  AgentMuxClient.prototype[method] = function (...args) { return consumer.run(method, () => original.apply(this, args)) }
}
const connect = AgentMuxClient.prototype.connect
AgentMuxClient.prototype.connect = async function () {
  if (!this.hookServer.isRunning()) Object.defineProperty(this.hookServer, 'port', { value: 0 })
  await this.connectRuntime()
  journal('connect-attempts', { pid: process.pid })
  while (existsSync(join(root, 'hold-full-observation'))) await new Promise(resolve => setTimeout(resolve, 10))
  return await connect.call(this)
}
for (const method of ['loadMetadata', 'loadRetiredAgentSessions', 'readMetadata', 'readRetiredAgentSession']) {
  const original = AgentMuxFileAgentSessionStore.prototype[method]
  AgentMuxFileAgentSessionStore.prototype[method] = async function (...args) {
    journal('metadata-reads', { method, id: args[0] })
    return await original.apply(this, args)
  }
}
for (const method of ['start', 'input']) {
  const original = CtxmuxRunAdapter.prototype[method]
  CtxmuxRunAdapter.prototype[method] = async function (...args) {
    journal('native-operations', { method, runId: method === 'input' ? args[0] : undefined })
    return await original.apply(this, args)
  }
}
const provider = new AgentProviderRegistry().get('codex')
const owner = await startHeadlessAgentMux({ socketPath: join(process.env.AGENTMUX_RUNTIME_DIRECTORY, 'headless.sock'),
  providers: [{ ...provider, observeSessionStatus: async context => {
    if (existsSync(join(root, 'hold-native-observation')) &&
      readFileSync(join(root, 'hold-native-observation'), 'utf8') === context.nativeHandle.sessionId) {
      writeFileSync(join(root, 'native-observation-entered'), JSON.stringify({ pid: process.pid }))
      while (!context.signal.aborted && existsSync(join(root, 'hold-native-observation'))) await new Promise(resolve => setTimeout(resolve, 10))
    }
    return await provider.observeSessionStatus(context)
  } }] })
process.stdout.write(JSON.stringify({ owner: owner.ownerIdentity(), socketPath: owner.socketPath }) + '\n')
process.once('SIGTERM', () => { void owner.stop() })
process.once('SIGINT', () => { void owner.stop() })
