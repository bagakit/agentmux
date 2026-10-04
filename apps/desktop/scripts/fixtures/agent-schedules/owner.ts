import { join } from 'node:path'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { AgentMuxFileAgentSessionStore, AgentProviderRegistry, defineAgentProvider, startHeadlessAgentMux, connectAgentMuxRpc, connectHostedAgentMux, type AgentMuxHostedRpcPort, type AgentMuxHostedRuntimeParameterMap } from '../../../../../packages/core/src/index.js'
import { AgentMuxControlServer } from '../../../../../packages/core/src/public-rpc-server.js'
import { ContinuousProgressLoopManager } from '../../../src/main/continuous-progress-loop-manager.js'
import { ContinuousProgressLoopStore } from '../../../src/main/continuous-progress-loop-store.js'
import { RuntimeController } from '../../../src/main/runtime-controller.js'
import { deliverContinuousProgress } from '../../../src/main/continuous-progress-delivery.js'
const state = process.env.AGENTMUX_STATE_DIRECTORY!, workspace = process.env.SCHEDULE_PROBE_WORKSPACE!
const original = new AgentProviderRegistry().get('codex')
const provider = defineAgentProvider({ catalog: { ...original.catalog, id: 'schedule-test', label: 'Schedule private test', executable: process.execPath, expectedProcess: 'node', hookStrategy: { kind: 'native', installation: 'unmanaged' } }, hook: original.hook,
  buildArgs: (_prompt, _args) => [process.env.SCHEDULE_PROBE_AGENT!] })
const store = new AgentMuxFileAgentSessionStore(join(state, 'sessions.json'))
// The same production semantic Host and finite borrowed SDK used by Desktop.
// Only one Core owns this Store/Run; Main is its ordinary transport consumer.
const host = await startHeadlessAgentMux({ providers: [provider], store, stateDirectory: state, socketPath: join(process.env.AGENTMUX_RUNTIME_DIRECTORY!, 'host.sock') })
const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: host.socketPath } })
const transport = rpc as unknown as AgentMuxHostedRpcPort
const port: AgentMuxHostedRpcPort = {
  call: async (method, params, options) => {
    if (method === 'runtime.invoke') {
      const { invocation } = params as AgentMuxHostedRuntimeParameterMap['runtime.invoke']
      await appendFile(join(state, 'hosted-invocations.ndjson'), JSON.stringify({ method: invocation.method, args: invocation.args.map(arg => arg && typeof arg === 'object' && 'caller' in arg ? { ...arg, caller: { ...(arg.caller as object), capability: '[redacted]' } } : arg) }) + '\n')
    }
    return await transport.call(method, params, options)
  },
  subscribe: transport.subscribe.bind(transport)
}
const client = await connectHostedAgentMux({ rpc: port, expectedStorePath: store.path })
let target: { hostId: string; agentSessionId: string; providerId: string; workspacePath: string }
try { target = JSON.parse(await readFile(join(state, 'target.json'), 'utf8')) }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  const session = await client.createAgent({ providerId: provider.id, executorId: provider.id, workspacePath: workspace, env: { SCHEDULE_PROBE_LOG: join(state, 'native-input.ndjson'),
    SCHEDULE_PROBE_COMMAND_DIR: join(state, 'actions'), SCHEDULE_PROBE_CLI: process.env.SCHEDULE_PROBE_CLI!, SCHEDULE_PROBE_ENDPOINT: 'unix:' + join(process.env.AGENTMUX_RUNTIME_DIRECTORY!, 'schedule.sock') }, createOperationId: 'private-create-agent', injectAgentMuxGuide: false })
  const deadline = Date.now() + 10000
  while ((await client.statusAgent(session.agentSessionId)).session.semanticStatus?.state !== 'done') { if (Date.now() > deadline) throw new Error('Private native Stop unavailable'); await new Promise(r => setTimeout(r, 20)) }
  target = { hostId: 'local', agentSessionId: session.agentSessionId, providerId: provider.id, workspacePath: workspace }
  await writeFile(join(state, 'target.json'), JSON.stringify(target))
}
// Inject only Host routing/input-observation dependencies. All Runtime business methods are the real prototype.
const runtime = Object.assign(Object.create(RuntimeController.prototype), { hosts: new Map([['local', { client }]]), progressInputObserver: async () => false,
  connectedClient: async () => client, trackHostLifecycleOperation: async (_host: string, work: () => Promise<unknown>) => work() }) as RuntimeController
const loops = new ContinuousProgressLoopManager(new ContinuousProgressLoopStore(join(state, 'loops.json')), async (...args) => {
  const outcome = await deliverContinuousProgress(runtime, ...args)
  if (process.env.SCHEDULE_PROBE_DROP_RECEIPT === '1') return 'unknown'
  return outcome
}, () => Number(process.env.SCHEDULE_PROBE_NOW), (loop, tickId, now, signal) => runtime.observeContinuousProgress(loop, tickId, now, signal), { saveFutureIntent: (loop, active, context) => runtime.saveFutureIntent(loop, active, context), authorizeFutureIntent: (target, context) => runtime.authorizeFutureIntent(target, context) })
await loops.start()
const server = new AgentMuxControlServer({ socketPath: join(process.env.AGENTMUX_RUNTIME_DIRECTORY!, 'schedule.sock'), schedules: loops, coreClients: () => [{ hostId: 'local', client }] })
await server.start()
process.stdout.write(JSON.stringify({ pid: process.pid, target, socketPath: server.path, hostedOwner: client.runtimeOwnerIdentity(), borrowed: (client as object) !== host.client }) + '\n')
const shutdown = async () => { await loops.stop(); await server.stop(); await client.dispose(); await rpc.dispose(); await host.stop(); process.exit(0) }
process.once('SIGTERM', () => { void shutdown() }); process.once('SIGINT', () => { void shutdown() })
process.on('message', async message => { if (message === 'check') { await loops.check(Number(process.env.SCHEDULE_PROBE_NOW)); process.send?.({ checked: true, schedules: loops.list() }) } })
