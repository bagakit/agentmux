/// <reference path="./agent-creation-operation-identity.raw.d.ts" />
import { fixturePath } from './helpers/fixture-values.js'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build, transform } from 'esbuild'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient, hostAgentCreationIntent } from '../src/client.js'
import { AgentMuxFileAgentSessionStore, AgentMuxMemoryAgentSessionStore, agentLifecycleOperationIdentity, type AgentMuxLifecycleReservation } from '../src/agent-session-store.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import { issueAgentCapability, hashAgentCapability } from '../src/agent-capability.js'
import { deriveAgentSessionId } from '../src/agent-session-id.js'
import { AgentMuxCreationAuthority } from '../src/agent-creation-authority.js'
import { AgentMuxHostExecutorOwner } from '../src/executor-owner.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import type { AgentMuxHostedRpcPort } from '../src/hosted-client-contract.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import runtimeControllerSource from '../../../apps/desktop/src/main/runtime-controller.ts?raw'

const roots: string[] = [], clients: AgentMuxClient[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})
const oldId = 'aLegacy_16-id__x9', operation = 'original-create-operation'
function session(id = oldId, op = operation): AgentMuxStoredAgentSession {
  return { kind: 'agent', agentSessionId: id, providerId: 'claude', executorId: 'private', hostId: 'local', workspacePath: fixturePath("private-workspace"),
    run: { runId: 'run-' + id }, retiredRuns: [], createdAt: 1, updatedAt: 1, hookBindingId: 'b'.repeat(43), hookToken: 't'.repeat(43), capabilityHash: 'c'.repeat(43),
    creation: { createOperationId: op, agentMuxContext: 'confirmed', initialPrompt: 'confirmed' } }
}
function reservation(id = oldId, op = operation): Extract<AgentMuxLifecycleReservation, { kind: 'create' }> {
  return { kind: 'create', agentSessionId: id, operationId: agentLifecycleOperationIdentity('create', id, op), reservationId: 'original-reservation-' + id,
    ownerId: 'original-owner', ownerPid: process.pid, expiresAt: Date.now() + 60000 }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amux-creation-id-')); roots.push(root)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const queue = new DurableAgentMuxMessageQueue(join(root, 'messages.ndjson'))
  const client = new AgentMuxClient({ store }); clients.push(client)
  return { root, store, queue, client }
}
async function enqueue(queue: DurableAgentMuxMessageQueue, id = oldId, op = operation) {
  return await queue.append({ messageId: 'initial-message-' + op, operationId: op, createdAt: 1,
    sender: { kind: 'agent-session', agentSessionId: 'source-session' }, recipient: { kind: 'agent-session', agentSessionId: id },
    senderSessionId: 'source-session', senderRunId: 'source-run', recipientSessionId: id, recipientRunId: null,
    threadId: 'initial-message-' + op, correlationId: 'initial-message-' + op, replyTo: null, workspaceId: null, body: 'first task' })
}

it.each(['memory', 'file'] as const)('recovers the original %s active and unprepared/prepared identities without a second ledger', async kind => {
  const f = await fixture(), store = kind === 'file' ? f.store : new AgentMuxMemoryAgentSessionStore()
  await store.compareAndSwap(null, session())
  expect(await store.loadCreationSessionId(operation)).toBe(oldId)
  expect(await store.loadCreationSessionId('new-operation')).toBeNull()
  const pending = reservation('pending_Legacy_id', 'pending-operation')
  await store.reserveLifecycle(pending)
  expect(await store.loadCreationSessionId('pending-operation')).toBe(pending.agentSessionId)
  const { run: _run, retiredRuns: _retired, ...seed } = session(pending.agentSessionId, 'pending-operation')
  await store.prepareCreate(pending, { ...seed, hookBindingId: 'b'.repeat(43), hookToken: 't'.repeat(43), creation: { ...seed.creation!, agentMuxContext: 'unknown', initialPrompt: 'unknown', intentDigest: 'd'.repeat(64) } })
  expect(await store.loadCreationSessionId('pending-operation')).toBe(pending.agentSessionId)
  await store.compareAndSwap(null, session('other-original', operation))
  await expect(store.loadCreationSessionId(operation)).rejects.toMatchObject({ code: 'AGENT_CREATION_OPERATION_CONFLICT' })
})

it('reads old active, prepared, unprepared and queued bindings in a new process', async () => {
  const f = await fixture()
  await f.store.compareAndSwap(null, session())
  const pending = reservation('prepared_Legacy', 'prepared-operation'); await f.store.reserveLifecycle(pending)
  const { run: _run, retiredRuns: _retired, ...seed } = session(pending.agentSessionId, 'prepared-operation')
  await f.store.prepareCreate(pending, { ...seed, hookBindingId: 'b'.repeat(43), hookToken: 't'.repeat(43), creation: { ...seed.creation!, agentMuxContext: 'unknown', initialPrompt: 'unknown', intentDigest: 'd'.repeat(64) } })
  await f.store.reserveLifecycle(reservation('unprepared_Legacy', 'unprepared-operation'))
  await enqueue(f.queue, 'queued_Legacy', 'queued-operation')
  const worker = join(f.root, 'worker.mjs')
  await build({ stdin: { contents: `import {AgentMuxClient} from './packages/core/src/client.ts';import {AgentMuxFileAgentSessionStore} from './packages/core/src/agent-session-store.ts';const client=new AgentMuxClient({store:new AgentMuxFileAgentSessionStore(process.argv[2])});const ids=[];for(const op of ${JSON.stringify([operation, 'prepared-operation', 'unprepared-operation', 'queued-operation'])})ids.push(await client.resolveAgentCreationSessionId(op));console.log(JSON.stringify(ids));await client.dispose();`, resolveDir: resolve('.'), sourcefile: 'creation-identity-worker.ts' },
    bundle: true, packages: 'external', platform: 'node', format: 'esm', outfile: worker })
  // External dependencies resolve from the owning Core package rather than a private temp tree.
  const { symlink } = await import('node:fs/promises'); await symlink(resolve('packages/core/node_modules'), join(f.root, 'node_modules'), 'dir')
  const child = spawn(process.execPath, [worker, join(f.root, 'sessions.json')], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
  const exit = await new Promise<number | null>((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
  expect({ exit, stderr: stderr.replace(/\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/g, '') }).toEqual({ exit: 0, stderr: '' })
  expect(JSON.parse(stdout.trim())).toEqual([oldId, 'prepared_Legacy', 'unprepared_Legacy', 'queued_Legacy'])
})

it('uses the queue operation index, refuses disagreement and preserves read failures', async () => {
  const f = await fixture(); await enqueue(f.queue)
  expect((await f.queue.readByOperationId(operation))?.envelope.recipientSessionId).toBe(oldId)
  expect(await f.client.resolveAgentCreationSessionId(operation)).toBe(oldId)
  await f.store.compareAndSwap(null, session('different-original'))
  await expect(f.client.resolveAgentCreationSessionId(operation)).rejects.toMatchObject({ code: 'AGENT_CREATION_OPERATION_CONFLICT' })
  vi.spyOn(f.store, 'loadCreationSessionId').mockRejectedValue(new Error('owner unavailable'))
  await expect(f.client.resolveAgentCreationSessionId('new-operation')).rejects.toThrow('owner unavailable')
})

it('returns the original initial-message creation without repeating start or input after encoding changes', async () => {
  const f = await fixture(), capability = issueAgentCapability()
  await f.store.compareAndSwap(null, { ...session('source-session', 'source-operation'), run: { runId: 'source-run' }, capabilityHash: hashAgentCapability(capability) })
  await f.store.compareAndSwap(null, session())
  const inner = f.client as any; await inner.registry.load('local'); inner.connected = true; vi.spyOn(inner.kernel, 'isConnected').mockReturnValue(true)
  const start = vi.spyOn(inner.kernel, 'start').mockRejectedValue(new Error('must not start a replacement'))
  const input = vi.spyOn(inner.kernel, 'input').mockRejectedValue(new Error('must not resend first input'))
  const reserve = vi.spyOn(inner.registry, 'reserveNew').mockRejectedValue(new Error('unexpected second reservation'))
  const request = { providerId: 'claude', executorId: 'private', workspacePath: fixturePath("private-workspace"), createOperationId: operation,
    injectAgentMuxGuide: false, prompt: 'first task', initialMessage: { callerAgentSessionId: 'source-session', capability } }
  for (let retry = 0; retry < 2; retry++) {
    await expect(f.client.createAgentWithDelivery(request)).resolves.toMatchObject({ session: { agentSessionId: oldId, run: session().run } })
  }
  expect(start).not.toHaveBeenCalled(); expect(input).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled()
  expect(await f.queue.listAfter()).toHaveLength(1)
})

it('reconciles a prepared old target creation on repeated requests without another start or input', async () => {
  const f = await fixture()
  const owner = new AgentMuxHostExecutorOwner({ path: join(f.root, 'executors.json'), runtimeId: 'target-runtime', catalog: () => f.client.catalog() })
  const target = new AgentMuxClient({ store: f.store, hostExecutorOwner: owner, creationAuthority: new AgentMuxCreationAuthority({ stateDirectory: f.root, runtimeId: 'target-runtime' }) }); clients.push(target)
  const request = { agentSessionId: oldId, createOperationId: operation, executorId: 'private', executorRevision: 'e'.repeat(64), workspacePath: fixturePath("private-workspace"), prompt: 'original task' }
  const pending = reservation(); await f.store.reserveLifecycle(pending)
  const { run: _run, retiredRuns: _retired, ...seed } = session()
  await f.store.prepareCreate(pending, { ...seed, creation: { ...seed.creation!, agentMuxContext: 'unknown', initialPrompt: 'unknown', intentDigest: hostAgentCreationIntent(request) } })
  await f.store.releaseReopenOwner(pending.ownerId)
  const inner = target as any; await inner.registry.load('local')
  const originalRun = { runId: 'original-started-run', lifecycleOperationId: pending.operationId, workspacePath: fixturePath("private-workspace"), program: '/bin/sh', args: [], pid: process.pid, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0, nativeService: null }
  vi.spyOn(inner.kernel, 'list').mockResolvedValue([originalRun])
  const start = vi.spyOn(inner.kernel, 'start').mockRejectedValue(new Error('must not start again'))
  const input = vi.spyOn(inner.kernel, 'input').mockRejectedValue(new Error('must not input again'))
  inner.hookServer.isRunning = () => true; inner.hookServer.createBinding = () => ({ bindRun: async () => {}, close: async () => {} })
  for (let retry = 0; retry < 2; retry++) {
    const restoredId = await target.resolveAgentCreationSessionId(operation)
    const receipt = await target.createHostAgentWithDelivery({ ...request, agentSessionId: restoredId })
    expect(receipt.session.agentSessionId).toBe(oldId); expect(receipt.session.run).toEqual({ runId: originalRun.runId })
    expect(receipt.promptConfirmed).toBe(false)
  }
  expect(start).not.toHaveBeenCalled(); expect(input).not.toHaveBeenCalled()
})

it('only derives a fresh identity when both original owners confirm no binding', async () => {
  const f = await fixture()
  expect(await f.client.resolveAgentCreationSessionId('new-operation')).toBe(await deriveAgentSessionId('new-operation'))
  await expect(f.client.resolveAgentCreationSessionId('')).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
})

async function hosted(f: Awaited<ReturnType<typeof fixture>>) {
  vi.spyOn(f.client, 'runtimeIdentity').mockReturnValue({ hostId: 'local', instanceId: 'fixture-runtime', buildIdentity: 'fixture', protocolVersion: 1, processId: process.pid, ownership: 'owned' })
  const connect = vi.spyOn(f.client, 'connect').mockResolvedValue(undefined)
  const service = new AgentMuxHostedRuntimeService(f.client, join(f.root, 'sessions.json'), () => hostedTestOwner(f.client))
  const calls: any[] = []
  const port = {
    call: async (method: string, params: unknown, options: any) => { calls.push({ method, params }); return JSON.parse(JSON.stringify(await service.call(method as any, JSON.parse(JSON.stringify(params)), options))) },
    subscribe: async (method: string, params: unknown, handlers: any) => {
      const server = await service.subscribe(method as any, params as any, event => handlers.onEvent(JSON.parse(JSON.stringify(event))))
      handlers.onInitial(JSON.parse(JSON.stringify(server.initial))); await server.start?.()
      return { dispose: () => server.dispose() }
    }
  } as unknown as AgentMuxHostedRpcPort
  const sdk = await connectHostedAgentMux({ rpc: port }); connect.mockClear()
  return { sdk, service, calls, connect }
}

it('carries operation identity through the real Hosted SDK and service without waking a Run', async () => {
  const f = await fixture(); await f.store.reserveLifecycle(reservation())
  const h = await hosted(f)
  try {
    expect(await h.sdk.resolveAgentCreationSessionId(operation)).toBe(oldId)
    expect(h.calls.some(call => call.method === 'runtime.invoke' && call.params.invocation.method === 'resolveAgentCreationSessionId' && call.params.invocation.args[0] === operation)).toBe(true)
    expect(h.connect).not.toHaveBeenCalled()
  } finally { await h.sdk.dispose(); await h.service.dispose() }
})

it('executes the actual Desktop remote launch method and resolves the target identity before signing', async () => {
  const f = await fixture(); await f.store.reserveLifecycle(reservation())
  const h = await hosted(f), order: string[] = []
  const file = ts.createSourceFile('runtime-controller.ts', runtimeControllerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const cls = file.statements.find(node => ts.isClassDeclaration(node) && node.members.some(member => member.name?.getText(file) === 'launchAdmittedAgent')) as ts.ClassDeclaration
  const method = cls.members.find(member => member.name?.getText(file) === 'launchAdmittedAgent')!
  const compiled = await transform(`class ActualLaunch { ${method.getText(file)} }`, { loader: 'ts', format: 'cjs' })
  const launch = new Function('profileAgentContext', 'hostAgentCreationIntent', 'randomUUID', compiled.code + '\nreturn ActualLaunch.prototype.launchAdmittedAgent;')(() => '', hostAgentCreationIntent, () => 'unexpected-operation')
  const resolveIdentity = h.sdk.resolveAgentCreationSessionId.bind(h.sdk)
  h.sdk.resolveAgentCreationSessionId = async op => { order.push('resolve'); return await resolveIdentity(op) }
  const create = vi.fn(async intent => { order.push('create'); expect(intent.agentSessionId).toBe(oldId); return { session: session(), creation: session().creation!, promptConfirmed: true } })
  h.sdk.listHostExecutors = async () => ({ runtimeId: 'target-runtime', executors: [{ executorId: 'private', providerId: 'claude', configRevision: 'original-revision' }] } as any)
  h.sdk.createHostAgentWithDelivery = create
  h.sdk.sessionTimeline = async () => { throw new Error('unrelated projection unavailable') }
  const attest = vi.fn(async ({ target }) => { order.push('sign'); expect(target.intentDigest).toBe(hostAgentCreationIntent({ agentSessionId: oldId, createOperationId: operation, executorId: 'private', executorRevision: 'original-revision', workspacePath: fixturePath("private-workspace"), prompt: 'first task' })); return { fixture: 'signed-original-intent' } })
  const context = { trackHostLifecycleOperation: (_host: string, action: () => Promise<unknown>) => action(), connectedClient: async () => h.sdk,
    authorizedCallerHost: async () => ({ client: { attestAgentCreation: attest } }), sessionByTarget: async () => { throw new Error('unrelated projection unavailable') } }
  try {
    const result = await launch.call(context, { hostId: 'ssh-target', executorId: 'private', workspacePath: fixturePath("private-workspace"), createOperationId: operation, prompt: 'first task', initialMessage: { callerAgentSessionId: 'source-session', capability: 'fixture-source-capability' } }, { hosts: [{ id: 'ssh-target', kind: 'ssh' }], executors: {}, profile: {} })
    expect(result.created.agentSessionId).toBe(oldId); expect(order).toEqual(['resolve', 'sign', 'create'])
    expect(create).toHaveBeenCalledOnce(); expect(h.connect).not.toHaveBeenCalled()
  } finally { await h.sdk.dispose(); await h.service.dispose() }
})
