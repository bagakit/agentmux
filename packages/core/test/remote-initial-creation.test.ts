import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient as DefaultClient, hostAgentCreationIntent, type AgentMuxHostAgentCreateInput } from '../src/client.js'
import { AgentMuxCreationAuthority } from '../src/agent-creation-authority.js'
import { AgentMuxHostExecutorOwner } from '../src/executor-owner.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { issueAgentCapability, hashAgentCapability } from '../src/agent-capability.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import type { AgentMuxAgentSession, AgentMuxStoredAgentSession } from '../src/types.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'

const AgentMuxClient: typeof DefaultClient = process.env.AGENTMUX_TEST_REMOTE_CLIENT
  ? (await import(process.env.AGENTMUX_TEST_REMOTE_CLIENT)).AgentMuxClient : DefaultClient
const roots: string[] = [], clients: DefaultClient[] = []
afterEach(async () => {
  for (const client of clients.splice(0)) await client.dispose()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amux-remote-creation-')); roots.push(root)
  for (const name of Object.keys(process.env).filter(name => name.startsWith('AGENTMUX_'))) vi.stubEnv(name, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  const sourceStore = new AgentMuxFileAgentSessionStore(join(root, 'source', 'sessions.json'))
  const targetStore = new AgentMuxFileAgentSessionStore(join(root, 'target', 'sessions.json'))
  const capability = issueAgentCapability()
  await sourceStore.compareAndSwap(null, { kind: 'agent', agentSessionId: 'source-session', providerId: 'claude', executorId: 'claude',
    hostId: 'local', workspacePath: root, run: { runId: 'source-run' }, retiredRuns: [],
    hookBindingId: 'source-binding', hookToken: 'source-token', capabilityHash: hashAgentCapability(capability), createdAt: 1, updatedAt: 1 })
  const sourceAuthority = new AgentMuxCreationAuthority({ stateDirectory: join(root, 'source'), runtimeId: 'source-runtime' })
  const targetAuthority = new AgentMuxCreationAuthority({ stateDirectory: join(root, 'target'), runtimeId: 'target-runtime' })
  const source = new AgentMuxClient({ store: sourceStore, creationAuthority: sourceAuthority }); clients.push(source)
  const owner = new AgentMuxHostExecutorOwner({ path: join(root, 'target', 'executors.json'), runtimeId: 'target-runtime', catalog: () => source.catalog() })
  const registered = await owner.configure({ executorId: 'target-executor', config: { label: 'target', providerId: 'claude',
    command: '/bin/sh', args: [], env: {}, injectAgentMuxGuide: false } })
  const target = new AgentMuxClient({ store: targetStore, hostExecutorOwner: owner, creationAuthority: targetAuthority }); clients.push(target)
  // Adapter/hook/probe are fixture boundaries. Auth, signed intent, target resolution, durable
  // creation reservation, message journal and Session commit execute the production owners.
  const inner = target as unknown as { connected: boolean; registry: { load(host: string): Promise<void> }; kernel: Record<string, unknown>;
    hookServer: Record<string, unknown>; ensureManagedHooks: unknown; ensureTerminalHandshakeOrDegrade: unknown }
  await inner.registry.load('local'); inner.connected = true
  const runs: CtxmuxAdapterRun[] = []
  const start = vi.fn(async (input: { operationKey: string; cwd: string; program: string; args: string[] }) => {
    const run: CtxmuxAdapterRun = { nativeService: null, runId: 'target-run', lifecycleOperationId: input.operationKey,
      program: input.program, args: input.args, workspacePath: input.cwd, pid: 1234, state: { type: 'running' },
      cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0 }
    runs.push(run); return run
  })
  const stop = vi.fn()
  Object.assign(inner.kernel, { isConnected: () => true, identity: () => ({ daemonInstanceId: 'fixture', protocolVersion: 21, buildIdentity: 'fixture' }),
    start, stop, list: async () => runs, status: async () => runs[0] })
  inner.hookServer.isRunning = () => true
  inner.hookServer.createBinding = () => ({ bindingId: 'b'.repeat(43), endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
  inner.ensureManagedHooks = async () => {}
  inner.ensureTerminalHandshakeOrDegrade = async (session: AgentMuxAgentSession) => session
  vi.spyOn(target, 'probeAgent').mockImplementation(async providerId => ({ providerId, executable: '/bin/sh', installed: true,
    capabilities: target.providers.get(providerId).catalog.capabilities }))
  const identity = await source.agentCreationAuthority()
  const targetIdentity = await target.agentCreationAuthority()
  const pin = () => target.trustCreationSource({ sourceRuntimeId: identity.runtimeId, publicKey: identity.publicKey, targetRuntimeId: targetIdentity.runtimeId, targetKeyFingerprint: targetIdentity.fingerprint }, { kind: 'user', id: 'configured-user' })
  const input: AgentMuxHostAgentCreateInput = { agentSessionId: 'target-session', createOperationId: 'remote-create-original',
    executorId: 'target-executor', executorRevision: registered.executor.configRevision, workspacePath: root, prompt: '  exact first task\n正文  ' }
  const attest = async (value = input) => source.attestAgentCreation({ caller: { agentSessionId: 'source-session', capability },
    target: { runtimeId: 'target-runtime', intentDigest: hostAgentCreationIntent(value) } })
  return { root, source, target, sourceStore, targetStore, owner, start, stop, input, attest, pin, capability, runs }
}

describe('remote initial creation admission', () => {
  it('starts against the target registry without a source Session there; keeps sourced task and original receipt once', async () => {
    const f = await fixture(); await f.pin()
    const request = { ...f.input, initialMessageAdmission: await f.attest() }
    expect(await f.targetStore.load()).toEqual([])
    const first = await f.target.createHostAgentWithDelivery(request)
    expect(first.session).toMatchObject({ agentSessionId: 'target-session', providerId: 'claude', workspacePath: f.root,
      creation: { executorRevision: f.input.executorRevision, initialMessageOrigin: { source: { runtimeId: 'source-runtime', agentSessionId: 'source-session', runId: 'source-run' } } } })
    expect(first.session.forkedFrom).toBeUndefined()
    expect(f.start).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(f.start.mock.calls[0])).toContain('[Message from Agent source-session]')
    expect(JSON.stringify(f.start.mock.calls[0])).not.toContain(f.capability)
    const journal = await new DurableAgentMuxMessageQueue(f.target.agentMessageQueuePath()).listAfter()
    expect(journal).toHaveLength(1)
    expect(journal[0]!.envelope).toMatchObject({ body: f.input.prompt, senderSessionId: 'source-session', senderRunId: 'source-run' })
    await f.owner.configure({ executorId: f.input.executorId, expectedRevision: f.input.executorRevision, config: {
      label: 'changed later', providerId: 'claude', command: '/bin/echo', args: [], env: {}, injectAgentMuxGuide: false } })
    const recovered = await f.target.createHostAgentWithDelivery(request)
    expect(recovered.session.run).toEqual(first.session.run)
    expect(f.start).toHaveBeenCalledTimes(1)
    expect(await new DurableAgentMuxMessageQueue(f.target.agentMessageQueuePath()).listAfter()).toHaveLength(1)
    expect(f.stop).not.toHaveBeenCalled()
    vi.spyOn(f.owner, 'resolve').mockRejectedValue(new Error('Executor observation unavailable after startup'))
    const continuity = await f.target.ensureAgentContinuity({ agentSessionId: first.session.agentSessionId, expectedRun: first.session.run, operationId: 'reattach-only' })
    expect(continuity.kind).toBe('reattachable')
    expect(f.start).toHaveBeenCalledTimes(1)
  })

  it.each(['untrusted', 'body', 'operation', 'cwd', 'executorRevision', 'signature', 'runtime', 'author'] as const)('rejects %s before spawn', async variant => {
    const f = await fixture(); if (variant !== 'untrusted') await f.pin()
    const request = { ...f.input, initialMessageAdmission: await f.attest() }
    if (variant === 'body') request.prompt += 'tampered'
    if (variant === 'operation') request.createOperationId = 'another-operation'
    if (variant === 'cwd') request.workspacePath += '/another'
    if (variant === 'executorRevision') request.executorRevision = '0'.repeat(64)
    if (variant === 'signature') request.initialMessageAdmission.signature = 'A'.repeat(86)
    if (variant === 'runtime') request.initialMessageAdmission.target.runtimeId = 'other-target'
    if (variant === 'author') request.initialMessageAdmission.source.agentSessionId = 'forged-author'
    await expect(f.target.createHostAgentWithDelivery(request)).rejects.toBeInstanceOf(Error)
    expect(f.start).not.toHaveBeenCalled(); expect(await f.targetStore.load()).toEqual([])
  })

  it('refuses a forged source capability and ordinary SDK author spoofing', async () => {
    const f = await fixture()
    await expect(f.source.attestAgentCreation({ caller: { agentSessionId: 'source-session', capability: 'forged' },
      target: { runtimeId: 'target-runtime', intentDigest: hostAgentCreationIntent(f.input) } })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    await expect(f.target.createAgentWithDelivery({ providerId: 'claude', executorId: 'target-executor', workspacePath: f.root,
      injectAgentMuxGuide: false, initialMessageAdmission: await f.attest() } as never)).rejects.toMatchObject({ code: 'MESSAGE_ENVELOPE_REQUIRED' })
    expect(f.start).not.toHaveBeenCalled()
  })

  it('reads a lost start response through the original operation without repeating start or the first task', async () => {
    const f = await fixture(); await f.pin()
    const request = { ...f.input, initialMessageAdmission: await f.attest() }
    const actualStart = f.start.getMockImplementation()!
    f.start.mockImplementationOnce(async input => { await actualStart(input); throw new Error('start response lost after actual process creation') })
    await expect(f.target.createHostAgentWithDelivery(request)).rejects.toMatchObject({ code: 'AGENT_CREATION_UNCONFIRMED' })
    expect(f.start).toHaveBeenCalledTimes(1)
    const inspected = await f.target.inspectAgentCreation('target-session')
    expect(inspected).toMatchObject({ run: { runId: 'target-run' }, creation: { createOperationId: request.createOperationId, initialPrompt: 'unknown',
      initialMessageOrigin: { source: { runtimeId: 'source-runtime', agentSessionId: 'source-session' } } } })
    const recovered = await f.target.createHostAgentWithDelivery(request)
    expect(recovered.session.run).toEqual(inspected.run)
    expect(recovered.promptConfirmed).toBe(false)
    expect(f.start).toHaveBeenCalledTimes(1); expect(f.stop).not.toHaveBeenCalled()
    const messages = await new DurableAgentMuxMessageQueue(f.target.agentMessageQueuePath()).listAfter()
    expect(messages).toHaveLength(1); expect(messages[0]!.delivery.state).toBe('queued')
  })

  it('rejects a correctly signed intent when the target Executor configuration changed before launch', async () => {
    const f = await fixture(); await f.pin()
    const request = { ...f.input, initialMessageAdmission: await f.attest() }
    await f.owner.configure({ executorId: f.input.executorId, expectedRevision: f.input.executorRevision, config: {
      label: 'changed target', providerId: 'claude', command: '/bin/echo', args: [], env: {}, injectAgentMuxGuide: false } })
    await expect(f.target.createHostAgentWithDelivery(request)).rejects.toMatchObject({ code: 'EXECUTOR_REVISION_CONFLICT' })
    expect(f.start).not.toHaveBeenCalled()
  })

  it('re-reads the authoritative source Run and refuses a capability retired by another owner', async () => {
    const f = await fixture()
    const previous = (await f.sourceStore.load())[0] as AgentMuxStoredAgentSession
    await f.sourceStore.compareAndSwap(previous, { ...previous, run: { runId: 'replacement-source-run' },
      retiredRuns: [previous.run], capabilityHash: hashAgentCapability(issueAgentCapability()), updatedAt: 2 })
    await expect(f.attest()).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    expect(f.start).not.toHaveBeenCalled()
  })

  it('recovers a lost response in a new Core process while retaining the original source and unknown delivery', async () => {
    const f = await fixture(); await f.pin()
    const request = { ...f.input, initialMessageAdmission: await f.attest() }, actualStart = f.start.getMockImplementation()!
    f.start.mockImplementationOnce(async input => { await actualStart(input); throw new Error('lost start response') })
    await expect(f.target.createHostAgentWithDelivery(request)).rejects.toMatchObject({ code: 'AGENT_CREATION_UNCONFIRMED' })
    await f.target.dispose()
    const core = resolve('packages/core/src'), modulePath = join(f.root, 'recover.mjs')
    await build({ stdin: { contents: `import {AgentMuxClient} from ${JSON.stringify(join(core, 'client.ts'))};import {AgentMuxFileAgentSessionStore} from ${JSON.stringify(join(core, 'agent-session-store.ts'))};
const client=new AgentMuxClient({store:new AgentMuxFileAgentSessionStore(process.argv[2])}),runs=JSON.parse(process.argv[3]);await client.registry.load('local');client.connected=true;
client.kernel.list=async()=>runs;client.kernel.isConnected=()=>true;for(const action of ['start','stop','input'])client.kernel[action]=async()=>{throw Error('recovery must not '+action)};
client.hookServer.isRunning=()=>true;client.hookServer.createBinding=(sid,provider,bindingId,token)=>({bindingId,endpoint:{url:'http://127.0.0.1:0',token},bindRun:async()=>{},close:async()=>{}});
const session=await client.inspectAgentCreation('target-session');console.log(JSON.stringify({pid:process.pid,session}));await client.dispose();`, resolveDir: core, loader: 'ts' },
      outfile: modulePath, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
    await symlink(resolve('packages/core/node_modules'), join(f.root, 'node_modules'))
    const child = spawn(process.execPath, [modulePath, f.targetStore.path, JSON.stringify(f.runs)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', error = ''; child.stdout!.on('data', bytes => output += bytes); child.stderr!.on('data', bytes => error += bytes)
    expect((await once(child, 'exit'))[0], error).toBe(0)
    const restored = JSON.parse(output)
    expect(restored.pid).not.toBe(process.pid)
    expect(restored.session).toMatchObject({ run: { runId: 'target-run' }, creation: { createOperationId: request.createOperationId,
      initialPrompt: 'unknown', initialMessageOrigin: { source: { runtimeId: 'source-runtime', agentSessionId: 'source-session', runId: 'source-run' } } } })
    expect(f.start).toHaveBeenCalledTimes(1); expect(f.stop).not.toHaveBeenCalled()
  })
})
