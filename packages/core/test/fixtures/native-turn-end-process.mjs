import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore } from '../../dist/index.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../../test/fixture-values.mjs'


// Each invocation owns one real Node lifecycle. Runtime/process and native status
// are controlled ports; Store, status admission, Hook HTTP and response owners are compiled Core.
const [mode, root] = process.argv.slice(2)
if (!['writer', 'reader'].includes(mode) || !root) throw new Error('An isolated lifecycle and root are required.')
const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
const nativeHandle = { kind: 'provider', providerId: 'codex', sessionId: 'native-durable' }
if (mode === 'writer') await store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'durable-agent',
  providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: root, run: { runId: 'durable-run' }, retiredRuns: [],
  nativeHandle, hookBindingId: 'durable-binding', hookToken: 'durable-token', createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1) })
const client = new AgentMuxClient({ store })
const registry = Reflect.get(client, 'registry'), kernel = Reflect.get(client, 'kernel')
await registry.load('local')
Reflect.set(client, 'connected', true)
kernel.isConnected = () => true
kernel.status = async runId => ({ runId, lifecycleOperationId: null, program: 'codex', args: [], workspacePath: root,
  pid: 123, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0, nativeService: null })
kernel.identity = () => ({ daemonInstanceId: 'isolated-runtime', protocolVersion: 1, buildIdentity: 'controlled-port' })
let inputCalls = 0
kernel.input = async () => { inputCalls++; throw new Error('This lifecycle must not send PTY input.') }
const provider = client.providers.get('codex')
provider.discoverNativeSession = async () => ({ handle: nativeHandle, assertCurrent: async () => {} })
let status
provider.observeSessionStatus = async context => { status = context.onStatus; return { dispose() {} } }
let callback
try {
  if (mode === 'writer') {
    await client.statusAgent('durable-agent')
    status({ recordId: 'durable-end', nativeTurnId: 'durable-turn', state: 'unknown', endReason: 'interrupted', nativeObservedAt: _historyFixtureEpoch(0, 0, 7) })
    await Reflect.get(client, 'nativeStatusWatches').get('durable-agent').pending
  } else {
    const server = Reflect.get(client, 'hookServer'); await server.start()
    const binding = server.createBinding('durable-agent', 'codex'); await binding.bindRun('durable-run')
    callback = fetch(binding.endpoint.url, { method: 'POST', headers: { authorization: `Bearer ${binding.endpoint.token}` },
      body: JSON.stringify({ receiptId: 'durable-hook', eventName: 'PermissionRequest', decision: true,
        payload: { hook_event_name: 'PermissionRequest', session_id: nativeHandle.sessionId, turn_id: 'durable-turn', tool_name: 'Bash' } }) })
    const pending = () => client.agentSession('durable-agent').pendingInteraction
    while (pending()?.request.id !== 'durable-hook') await new Promise(resolve => setTimeout(resolve, 1))
    await Reflect.get(server, 'bindings').get(binding.endpoint.token).tail
    const input = { agentSessionId: 'durable-agent', expectedRun: { runId: 'durable-run' }, operationId: 'durable-response',
      expectedRequest: pending().request, response: { kind: 'permission', requestId: 'durable-hook', decision: { outcome: 'selected', optionId: 'allow-once' } } }
    const error = await client.respondAgentInteraction(input).then(() => null, error => ({ code: error.code }))
    await binding.close()
    const body = await (await callback).json()
    const operation = await client.inspectAgentInteractionOperation(input)
    const session = client.agentSession('durable-agent')
    process.stdout.write(JSON.stringify({ mode, pid: process.pid, error, body, inputCalls, operation,
      publicFactLeaked: Object.hasOwn(session, 'nativeTurnEnds'), request: session.pendingInteraction.request }) + '\n')
  }
  if (mode === 'writer') {
    const session = await store.readMetadata('durable-agent')
    process.stdout.write(JSON.stringify({ mode, pid: process.pid, inputCalls, agentSessionId: session.agentSessionId,
      run: session.run, nativeHandle: session.nativeHandle, nativeTurnEnds: session.nativeTurnEnds }) + '\n')
  }
} finally { await client.dispose() }
