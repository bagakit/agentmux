import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { defineRun } from '@ctxmux/sdk'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentMuxControlServer, AgentMuxHostedRuntimeService } from '../../dist/index.js'
const root = process.env.AGENTMUX_STATE_DIRECTORY, mode = process.env.AMUX_HANDOFF_CARRIER
const store = new AgentMuxFileAgentSessionStore(process.env.AGENTMUX_AGENT_SESSION_STORE)
// Seed only the initial private protocol fixture. Restarts consume these exact original records.
if (!await store.readMetadata('recipient')) await store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'recipient', providerId: 'grok', executorId: 'grok', hostId: 'local',
  workspacePath: root, run: { runId: 'original-run' }, retiredRuns: [], nativeHandle: { kind: 'provider', providerId: 'grok', sessionId: 'original-native' },
  hookBindingId: 'private-hook', hookToken: 'private-token', createdAt: 1, updatedAt: 1 })
const client = new AgentMuxClient({ store }), registry = Reflect.get(client, 'registry'), kernel = Reflect.get(client, 'kernel')
await registry.load('local'); Reflect.set(client, 'connected', true)
client.onEvent(event => { if (event.type === 'agent-error') process.stderr.write(JSON.stringify({ code: event.code, message: event.message }) + '\n') }, { observeMessages: false })
const effects = join(root, 'carrier-effects.jsonl')
const list = () => existsSync(effects) ? readFileSync(effects, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
let startedArgs = []
const run = (id, state = 'running') => ({ runId: id, lifecycleOperationId: id === 'resumed-run' ? list()[0]?.operationId ?? null : null,
  program: id === 'resumed-run' ? list()[0]?.program ?? 'grok' : 'grok', args: id === 'resumed-run' ? startedArgs : [], workspacePath: root, pid: 1234,
  state: state === 'running' ? { type: 'running' } : { type: 'exited', code: 0, signal: null }, cols: 80, rows: 24, acceptedInputBytes: 0,
  latestOutputBytes: 0, firstAvailableByte: 0, nativeService: null })
kernel.isConnected = () => true
kernel.identity = () => ({ daemonInstanceId: 'private-carrier-runtime', protocolVersion: 1, buildIdentity: 'private-protocol-port' })
kernel.status = async id => run(id, mode === 'launch' && id === 'original-run' ? 'exited' : 'running')
kernel.list = async () => list().length && mode === 'launch' ? [run('resumed-run')] : [run('original-run', mode === 'launch' ? 'exited' : 'running')]
kernel.input = async () => { throw Error('A retained native/launch carrier must never become terminal input') }
const builtin = client.providers.get('grok')
client.providers.replace({ ...builtin, prepareManagedLaunch: async plan => ({ plan }),
  planPromptInput: existsSync(join(root, 'hold-after-gate')) ? builtin.planPromptInput : () => { throw Error('Original carrier must be consumed without Provider re-selection') },
  ...(mode === 'native' ? { prepareNativeInput: async (_context, target) => ({ plan: { kind: 'native-rpc', protocolId: 'private-native-protocol',
    sourceId: JSON.stringify([target.providerId, target.nativeSessionId]), actorId: 'original-actor', threadId: target.nativeSessionId, operation: 'start-or-steer' },
    assertCurrent: async () => {}, dispose: async () => {}, send: async (prompt, plan) => {
      appendFileSync(effects, JSON.stringify({ kind: 'native', prompt, plan }) + '\n'); return { outcome: 'admitted', turnId: 'original-turn' }
    } }) } : {}) })
kernel.creationRuntimeIdentity = () => ({ runtimeId: 'private-carrier-runtime', instanceId: 'private-instance', buildIdentity: 'private-protocol-port', protocolVersion: 1 })
kernel.prepareStart = spec => defineRun(spec.program, { args: spec.args, cwd: spec.cwd, env: spec.env, initialSize: { cols: spec.cols ?? 80, rows: spec.rows ?? 24 } })
const digest = request => createHash('sha256').update(JSON.stringify(request.args)).digest('base64url')
kernel.startPrepared = async (request, operationId) => { startedArgs = [...request.args]; appendFileSync(effects, JSON.stringify({ kind: 'launch', operationId, program: request.program, argsDigest: digest(request) }) + '\n'); return run('resumed-run') }
kernel.inspectPreparedStart = async (request, operationId) => {
  const observed = list()[0]
  if (!observed) return null
  if (observed.operationId !== operationId || observed.program !== request.program || observed.argsDigest !== digest(request)) throw Error('Different original prepared Start')
  startedArgs = [...request.args]
  return run('resumed-run')
}
kernel.inspectCreation = async operationId => list()[0]?.operationId === operationId ? run('resumed-run') : null
Reflect.set(client, 'probePreparedAgent', async () => ({ providerId: 'grok', executable: 'grok', installed: true, capabilities: builtin.catalog.capabilities }))
Reflect.set(client, 'ensureTerminalHandshakeOrDegrade', async session => session)
Reflect.get(client, 'hookServer').isRunning = () => true
Reflect.get(client, 'hookServer').createBinding = (_session, _provider, bindingId) => ({ bindingId,
  endpoint: { url: 'http://127.0.0.1:0', token: 'T'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
Reflect.get(client, 'screenEvidence').wait = async () => 1
const queue = Reflect.get(client, 'messageQueue'), gate = queue.authorizeInputDispatch.bind(queue)
queue.authorizeInputDispatch = async (...args) => { const link = await gate(...args)
  if (link && existsSync(join(root, 'hold-after-gate'))) { writeFileSync(join(root, 'gate-witness.json'), JSON.stringify(link)); await new Promise(() => {}) }
  return link
}
const identity = { runtimeId: 'private-carrier-owner', ownerInstanceId: randomUUID(), protocolVersion: 2, processId: process.pid, ctxmux: client.runtimeIdentity(), availability: 'connected' }
const hosted = new AgentMuxHostedRuntimeService(client, store.path, () => identity, undefined, { assertCurrent(author, intent) {
  if (author.connectionId !== 'private-connection' || author.bindingId !== 'private-binding' || author.grantId !== 'private-grant' ||
      intent.agentSessionId !== 'recipient' || intent.expectedRun.runId !== 'original-run' || intent.operationId !== 'carrier-control' ||
      intent.messageId !== 'carrier-message' || intent.body !== 'Original process carrier 原文') throw Error('Wrong private original external authority')
} })
const server = new AgentMuxControlServer({ socketPath: join(process.env.AGENTMUX_RUNTIME_DIRECTORY, 'carrier.sock'), coreClients: () => [{ hostId: 'local', client }], hostedRuntime: () => hosted })
await server.start()
process.stdout.write(JSON.stringify({ owner: identity, socketPath: server.path }) + '\n')
