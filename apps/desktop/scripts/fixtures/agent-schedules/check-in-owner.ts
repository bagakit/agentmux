import { join } from 'node:path'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { AgentMuxFileAgentSessionStore, startHeadlessAgentMux, connectAgentMuxRpc, connectHostedAgentMux, type AgentMuxHostedRpcPort, type AgentMuxHostedRuntimeParameterMap } from '../../../../../packages/core/src/index.js'
import { agentPromptCondition } from '../../../../../packages/core/src/agent-prompt-condition.js'
import { AgentMuxControlServer } from '../../../../../packages/core/src/public-rpc-server.js'
import { ContinuousProgressLoopManager } from '../../../src/main/continuous-progress-loop-manager.js'
import { ContinuousProgressLoopStore } from '../../../src/main/continuous-progress-loop-store.js'
import { RuntimeController } from '../../../src/main/runtime-controller.js'
import { deliverContinuousProgress } from '../../../src/main/continuous-progress-delivery.js'
import type { AppConfig } from '../../../src/shared/contracts.js'
import { checkInProvider as provider } from './check-in-provider.js'

const state = process.env.AGENTMUX_STATE_DIRECTORY!, workspace = process.env.SCHEDULE_PROBE_WORKSPACE!, store = new AgentMuxFileAgentSessionStore(join(state, 'sessions.json'))
const host = await startHeadlessAgentMux({ providers: [provider], store, stateDirectory: state, socketPath: join(process.env.AGENTMUX_RUNTIME_DIRECTORY!, 'host.sock') })
const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: host.socketPath } }), transport = rpc as unknown as AgentMuxHostedRpcPort
const client = await connectHostedAgentMux({ rpc: {
  call: async (method, params, options) => {
    if (method === 'runtime.invoke') { const { invocation } = params as AgentMuxHostedRuntimeParameterMap['runtime.invoke']; await appendFile(join(state, 'hosted-invocations.ndjson'), JSON.stringify({ method: invocation.method, args: invocation.args }) + '\n') }
    return await transport.call(method, params, options)
  }, subscribe: transport.subscribe.bind(transport)
}, expectedStorePath: store.path })
let target: { hostId: string; agentSessionId: string; providerId: string; workspacePath: string }
try { target = JSON.parse(await readFile(join(state, 'target.json'), 'utf8')) }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  const session = await client.createAgent({ providerId: provider.id, executorId: provider.id, workspacePath: workspace, createOperationId: 'private-checkin-agent', injectAgentMuxGuide: false,
    env: { SCHEDULE_PROBE_TRANSCRIPT: join(state, 'check-in-native.ndjson'), SCHEDULE_PROBE_LOG: join(state, 'native-input.ndjson'), SCHEDULE_PROBE_COMMAND_DIR: join(state, 'actions'), SCHEDULE_PROBE_CLI: process.env.SCHEDULE_PROBE_CLI!, SCHEDULE_PROBE_ENDPOINT: 'unix:' + join(process.env.AGENTMUX_RUNTIME_DIRECTORY!, 'schedule.sock') } })
  const deadline = Date.now() + 10000
  while ((await client.statusAgent(session.agentSessionId)).session.semanticStatus?.state !== 'done') { if (Date.now() > deadline) throw new Error('Private native Stop unavailable'); await new Promise(r => setTimeout(r, 20)) }
  target = { hostId: 'local', agentSessionId: session.agentSessionId, providerId: provider.id, workspacePath: workspace }
  await writeFile(join(state, 'target.json'), JSON.stringify(target))
}
// Only the original configured Executor fields are consumed by this read.
const config = { executors: { [provider.id]: { providerId: provider.id, label: provider.label, command: process.execPath, args: [], env: {} } } } as unknown as AppConfig
const runtime = Object.assign(Object.create(RuntimeController.prototype), { hosts: new Map([['local', { client }]]), progressInputObserver: async () => false,
  connectedClient: async () => client, trackHostLifecycleOperation: async (_host: string, work: () => Promise<unknown>) => work() }) as RuntimeController
let now = Number(process.env.SCHEDULE_PROBE_NOW)
const loops = new ContinuousProgressLoopManager(new ContinuousProgressLoopStore(join(state, 'loops.json')), async (...args) => {
  const outcome = await deliverContinuousProgress(runtime, ...args)
  return process.env.SCHEDULE_PROBE_DROP_RECEIPT === '1' ? 'unknown' : outcome
}, () => now, (loop, tickId, at, signal) => runtime.observeContinuousProgress(loop, tickId, at, signal), {
  saveFutureIntent: (loop, active, context) => runtime.saveFutureIntent(loop, active, context), authorizeFutureIntent: (target, context) => runtime.authorizeFutureIntent(target, context),
  observeCheckIn: (target, at, signal) => runtime.observeCheckIn(target, at, signal, config)
})
await loops.start()
const server = new AgentMuxControlServer({ socketPath: join(process.env.AGENTMUX_RUNTIME_DIRECTORY!, 'schedule.sock'), schedules: loops, coreClients: () => [{ hostId: 'local', client }] }); await server.start()
process.stdout.write(JSON.stringify({ pid: process.pid, target, hostedOwner: client.runtimeOwnerIdentity(), borrowed: (client as object) !== host.client }) + '\n')
const shutdown = async () => { await loops.stop(); await server.stop(); await client.dispose(); await rpc.dispose(); await host.stop(); process.exit(0) }
process.once('SIGTERM', () => { void shutdown() }); process.once('SIGINT', () => { void shutdown() })
process.on('message', async (message: { id: number; action: string; now?: number; operationId?: string }) => {
  try {
    if (message.action === 'check' && message.now !== undefined) now = message.now
    let result: unknown
    if (message.action === 'human') {
      const status = await client.statusAgent(target.agentSessionId)
      await client.submitAgentPrompt({ agentSessionId: target.agentSessionId, ...agentPromptCondition(status.session), prompt: 'Help me finish the confirmed design decision.', authorHuman: true, operationId: message.operationId! })
      result = await client.sessionTimeline(target.agentSessionId)
    } else if (message.action === 'facts') {
      const page = await client.sessionHistoryPage(target.agentSessionId, { refreshNativeSource: true, requireCurrentSource: true, limit: 100, commandOverride: process.execPath })
      result = { timeline: await client.sessionTimeline(target.agentSessionId), page, observation: await runtime.observeCheckIn(target, message.now ?? now, new AbortController().signal, config), status: await client.statusAgent(target.agentSessionId) }
    } else if (message.action === 'check') { await loops.check(now); result = loops.list() }
    else if (message.action === 'cancel-read') { const abort = new AbortController(); const pending = client.sessionHistoryPage(target.agentSessionId, { refreshNativeSource: true, requireCurrentSource: true, limit: 100, commandOverride: process.execPath, signal: abort.signal }); abort.abort(); result = await pending.then(() => ({ rejected: false }), error => ({ rejected: true, code: error.code, name: error.name })) }
    else throw new Error('Unknown private command')
    process.send?.({ id: message.id, result })
  } catch (error) { process.send?.({ id: message.id, error: { code: (error as { code?: string }).code, message: (error as Error).message, stack: (error as Error).stack } }) }
})
