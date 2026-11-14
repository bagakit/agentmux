import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentMuxSpatialStateStore, AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { AgentMuxHostedRuntimeService } from '../../src/hosted-runtime-service.js'
import { AgentMuxHostExecutorOwner } from '../../src/executor-owner.js'
import { AgentMuxCreationAuthority } from '../../src/agent-creation-authority.js'
import { spatialAgentOpenRecord } from '../../src/spatial-agent-open-contract.js'
import { createHostSpatialAgentControl } from '../../../../apps/host/src/spatial-agent-control.js'

// Only Native execution and Provider readiness are deterministic leaves. The
// restarted Host, configured creation, Registry and original files are real.
const [root, runtimeId, requestFile] = process.argv.slice(2), request = JSON.parse(await readFile(requestFile, 'utf8'))
const client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')) })
client.creationAuthority = new AgentMuxCreationAuthority({ stateDirectory: join(root, 'creation-authority'), runtimeId })
client.hostExecutorOwner = new AgentMuxHostExecutorOwner({ path: join(root, 'executors.json'), runtimeId, catalog: () => client.catalog() })
await client.registry.load('local'); client.connected = true
const provider = client.providers.get('codex')
client.providers.replace({ ...provider, prepareManagedLaunch: async plan => ({ plan }) })
const starts = [], run = (runId, spec) => ({ runId, lifecycleOperationId: spec?.operationKey ?? null, workspacePath: spec?.cwd ?? root,
  program: spec?.program ?? 'codex', args: spec?.args ?? [], pid: null, state: { type: 'running' }, cols: 80, rows: 24,
  latestOutputBytes: 3, firstAvailableByte: 0, acceptedInputBytes: 0, nativeService: null })
let inputs = 0, stops = 0
Object.assign(client.kernel, { isConnected: () => true, connect: async () => {}, identity: () => ({ daemonInstanceId: 'fixture-runtime', protocolVersion: 1, buildIdentity: 'fixture' }),
  start: async spec => { const runId = 'restarted-takeover-run'; starts.push(spec); return run(runId, spec) },
  list: async () => starts.map(spec => run('restarted-takeover-run', spec)), status: async id => run(id, starts[0]),
  input: async () => { inputs++; throw Error('Continuation cannot replay input.') }, stop: async () => { stops++; throw Error('Continuation cannot stop an Agent.') } })
client.hookServer.isRunning = () => true
client.hookServer.createBinding = () => ({ bindingId: 'b'.repeat(43), endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
client.ensureManagedHooks = async () => {}; client.ensureTerminalHandshakeOrDegrade = async value => value
client.screenEvidence.wait = async () => 0
client.probePreparedAgent = async () => ({ providerId: 'codex', executable: 'codex', installed: true, capabilities: provider.catalog.capabilities })
client.promptSubmission.submitInputPlan = async () => { inputs++; throw Error('The positional initial prompt must not be resubmitted.') }
const owner = { runtimeId, ownerInstanceId: 'private-continuation-owner', protocolVersion: 2, processId: process.pid, ctxmux: null, availability: 'connected' }
const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json')), hosted = new AgentMuxHostedRuntimeService(client, null, () => owner)
let server, rpc
const runtime = { client, ownerIdentity: () => owner, get server() { return server } }
server = new AgentMuxControlServer({ socketPath: join(root, 'continuation.sock'), spatialState: spatial, coreClients: () => [{ hostId: 'local', client }], hostedRuntime: () => hosted,
  spatialAgentControl: createHostSpatialAgentControl({ configurationPath: join(root, 'config.json'), spatial, runtime: () => runtime }) })
try {
  await server.start(); rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const originalGraph = await readFile(spatial.path, 'utf8'), source = await client.readAgentSession(request.content.source.agentSessionId)
  await rpc.call('space.inspect', { target: { operationId: request.operationId } })
  const before = { controls: starts.length + inputs + stops, sameGraph: originalGraph === await readFile(spatial.path, 'utf8'), sameSource: JSON.stringify(source) === JSON.stringify(await client.readAgentSession(source.agentSessionId)) }
  const open = await rpc.call('agent.open', request), operation = spatialAgentOpenRecord((await spatial.read()).graph, request.operationId)
  const creation = (await client.readAgentSession(operation.agentSessionId))?.creation
  console.log(JSON.stringify({ pid: process.pid, before, open, operation, creation, starts: starts.length, inputs, stops,
    sourceUnchanged: JSON.stringify(source) === JSON.stringify(await client.readAgentSession(source.agentSessionId)) }))
} finally { await rpc?.dispose(); await server.stop(); await hosted.dispose(); await client.dispose() }
