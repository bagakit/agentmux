import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient as DefaultClient, hostAgentCreationIntent } from '../src/client.js';
import type { AgentMuxHostAgentCreateInput } from "../src/client-contract.js";
import { AgentMuxCreationAuthority } from '../src/agent-creation-authority.js'
import { AgentMuxHostExecutorOwner } from '../src/executor-owner.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { issueAgentCapability, hashAgentCapability } from '../src/agent-capability.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import type { AgentMuxAgentSession, AgentMuxStoredAgentSession } from '../src/types.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import { hostedTestClient } from './helpers/hosted-runtime-port.js'
import { executionCreationId } from '../src/host-route-execution.js'
import { AgentMuxError } from '../src/errors.js'
import * as claudePolicy from '../src/providers/claude-execution-policy.js'

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
    hookBindingId: 'source-binding', hookToken: 'source-token', capabilityHash: hashAgentCapability(capability), createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1) })
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
    start, stop, list: async () => runs, inspectCreation: async (key: string) => runs.find(run => run.lifecycleOperationId === key) ?? null, status: async () => runs[0] })
  inner.hookServer.isRunning = () => true
  inner.hookServer.createBinding = () => ({ bindingId: 'b'.repeat(43), endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
  inner.ensureManagedHooks = async () => {}
  inner.ensureTerminalHandshakeOrDegrade = async (session: AgentMuxAgentSession) => session
  const probe = vi.spyOn(target as unknown as { probePreparedAgent: typeof target.probeAgent }, 'probePreparedAgent').mockImplementation(async providerId => ({ providerId, executable: '/bin/sh', installed: true,
    capabilities: target.providers.get(providerId).catalog.capabilities }))
  const identity = await source.agentCreationAuthority()
  const targetIdentity = await target.agentCreationAuthority()
  const pin = () => target.trustCreationSource({ sourceRuntimeId: identity.runtimeId, publicKey: identity.publicKey, targetRuntimeId: targetIdentity.runtimeId, targetKeyFingerprint: targetIdentity.fingerprint }, { kind: 'user', id: 'configured-user' })
  const input: AgentMuxHostAgentCreateInput = { agentSessionId: 'target-session', createOperationId: 'remote-create-original',
    executorId: 'target-executor', executorRevision: registered.executor.configRevision, workspacePath: root, prompt: '  exact first task\n正文  ' }
  const attest = async (value = input) => source.attestAgentCreation({ caller: { agentSessionId: 'source-session', capability },
    target: { runtimeId: 'target-runtime', intentDigest: hostAgentCreationIntent(value) } })
  return { root, source, target, sourceStore, targetStore, owner, start, stop, probe, input, attest, pin, capability, runs }
}

async function splitFrontend(f: Awaited<ReturnType<typeof fixture>>) {
  const agentSessionId = f.input.agentSessionId!
  const locator = (await f.target.hostEnvironment({ agentSessionId })).agentWorkspace
  const toolExecution = { bindingId: 'split-binding', resourceHostId: 'resource', resourceRuntimeId: 'resource-runtime', workspacePath: f.root }
  await f.target.prepareAgentExecutionHelper({ providerId: 'claude', role: 'frontend', bindingId: toolExecution.bindingId, agentSessionId,
    createOperationId: executionCreationId(toolExecution.bindingId, 'frontend'), workspacePath: locator.workspacePath, toolExecution })
  const request: AgentMuxHostAgentCreateInput = { ...f.input, workspacePath: locator.workspacePath, toolExecution }
  const markerPath = join(f.root, 'target', 'agent-workspace-identities', locator.workspacePath.split('/').at(-1)! + '.json')
  return { locator, toolExecution, request, markerPath }
}

function allowSplitLaunch(f: Awaited<ReturnType<typeof fixture>>, workspacePath: string) {
  const native: CtxmuxAdapterRun = { nativeService: null, runId: 'frontend-run', lifecycleOperationId: null, program: 'claude', args: [], workspacePath,
    pid: 4321, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0 }
  vi.spyOn(f.target, 'inspectPreparedTerminal').mockResolvedValue((f.target as any).projectRun(native))
  vi.spyOn(f.target as any, 'readExecutionFrontendEndpoint').mockResolvedValue('ws://127.0.0.1:34567/private-capability')
}

async function createSplit(f: Awaited<ReturnType<typeof fixture>>, request: AgentMuxHostAgentCreateInput) {
  await f.pin()
  return await f.target.createHostAgentWithDelivery({ ...request, initialMessageAdmission: await f.attest(request) })
}

async function holdProviderPreparation(f: Awaited<ReturnType<typeof fixture>>, stage: 'probe' | 'policy') {
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const admission = new Promise<void>(resolve => { entered = resolve })
  if (stage === 'probe') {
    const original = f.probe.getMockImplementation()!
    f.probe.mockImplementation(async (providerId, commandOverride, context) => { entered(); await held; return await original(providerId, commandOverride, context) })
  } else {
    const original = claudePolicy.prepareClaudeExecutionPolicy
    vi.spyOn(claudePolicy, 'prepareClaudeExecutionPolicy').mockImplementation(async input => { entered(); await held; return await original(input) })
  }
  return { admission, release }
}

async function replaceLeafDuringProviderPreparation(path: string, fault: 'deleted' | 'replaced' | 'symlink', external: string) {
  await rm(path, { recursive: true })
  if (fault === 'replaced') await mkdir(path)
  if (fault === 'symlink') { await mkdir(external); await symlink(external, path) }
}

describe('remote initial creation admission', () => {
  it('rejects a changed launch cwd before Provider probe even when every other frontend binding field matches', async () => {
    const f = await fixture(), split = await splitFrontend(f)
    const changed = join(f.root, 'changed-launch-cwd'); await mkdir(changed)
    allowSplitLaunch(f, split.locator.workspacePath)
    await expect(createSplit(f, { ...split.request, workspacePath: changed })).rejects.toMatchObject({ code: 'EXECUTION_BINDING_MISMATCH' })
    expect(f.probe).not.toHaveBeenCalled()
    expect(f.start).not.toHaveBeenCalled()
    expect(f.stop).not.toHaveBeenCalled()
  })

  it('rejects an exact locator without its retained frontend record before Provider probe or Start', async () => {
    const f = await fixture(), split = await splitFrontend(f)
    const helperPath = join(f.root, 'target', 'execution-helpers')
    await rm(helperPath, { recursive: true, force: true })
    await expect(createSplit(f, split.request)).rejects.toMatchObject({ code: 'EXECUTION_HELPER_UNAVAILABLE' })
    expect(f.probe).not.toHaveBeenCalled()
    expect(f.start).not.toHaveBeenCalled()
    expect(f.stop).not.toHaveBeenCalled()
  })

  it.each(['deleted', 'replaced'] as const)('refuses a %s provisioned leaf before Provider effects and never rebuilds it', async fault => {
    const f = await fixture(), split = await splitFrontend(f)
    const before = await readFile(split.markerPath)
    const originalLeaf = (await stat(split.locator.workspacePath)).ino
    await rm(split.locator.workspacePath, { recursive: true })
    if (fault === 'replaced') await mkdir(split.locator.workspacePath)
    const input = vi.spyOn((f.target as any).kernel, 'input')
    await expect(createSplit(f, split.request)).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED' })
    expect(f.probe).not.toHaveBeenCalled()
    expect(f.start).not.toHaveBeenCalled()
    expect(input).not.toHaveBeenCalled()
    expect(f.stop).not.toHaveBeenCalled()
    expect(await readFile(split.markerPath)).toEqual(before)
    if (fault === 'deleted') await expect(stat(split.locator.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' })
    else expect((await stat(split.locator.workspacePath)).ino).not.toBe(originalLeaf)
  })

  it.each([
    ['probe', 'deleted'], ['probe', 'replaced'], ['probe', 'symlink'],
    ['policy', 'deleted'], ['policy', 'replaced'], ['policy', 'symlink']
  ] as const)('rejects a %s leaf during held %s preparation without any Provider write or rebuild', async (stage, fault) => {
    const f = await fixture(), split = await splitFrontend(f)
    allowSplitLaunch(f, split.locator.workspacePath)
    const hold = await holdProviderPreparation(f, stage)
    const pending = createSplit(f, split.request)
    void pending.catch(() => {})
    await hold.admission
    const external = join(f.root, 'provider-race-external')
    await replaceLeafDuringProviderPreparation(split.locator.workspacePath, fault, external)
    hold.release()
    await expect(pending).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED' })
    expect(f.start).not.toHaveBeenCalled()
    expect(f.stop).not.toHaveBeenCalled()
    if (fault === 'deleted') await expect(stat(split.locator.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' })
    if (fault === 'replaced') await expect(stat(join(split.locator.workspacePath, '.claude'))).rejects.toMatchObject({ code: 'ENOENT' })
    if (fault === 'symlink') await expect(stat(join(external, '.claude'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['.claude', '.claude/agentmux/tool-execution'] as const)('rejects a pre-existing %s symlink without writing outside the proven leaf', async relative => {
    const f = await fixture(), split = await splitFrontend(f)
    allowSplitLaunch(f, split.locator.workspacePath)
    const external = join(f.root, 'provider-descendant-symlink-target')
    await mkdir(external)
    const link = join(split.locator.workspacePath, relative)
    await mkdir(join(link, '..'), { recursive: true })
    await symlink(external, link)
    const outcome = await createSplit(f, split.request).then(value => ({ value }), error => ({ error }))
    expect(outcome).toHaveProperty('error')
    expect((outcome as { error: Error }).error).toMatchObject({ code: 'EXECUTION_BINDING_CONFLICT' })
    expect(f.start).not.toHaveBeenCalled()
    expect(await readdir(external)).toEqual([])
  })

  it('adopts an existing split Session before any physical fence after its leaf disappears', async () => {
    const f = await fixture(), split = await splitFrontend(f)
    allowSplitLaunch(f, split.locator.workspacePath)
    const created = await createSplit(f, split.request)
    expect(f.start).toHaveBeenCalledOnce()
    await rm(split.locator.workspacePath, { recursive: true })
    f.probe.mockClear()
    const adopted = await createSplit(f, split.request)
    expect(adopted.session.run).toEqual(created.session.run)
    expect(f.probe).not.toHaveBeenCalled()
    expect(f.start).toHaveBeenCalledOnce()
    expect(f.stop).not.toHaveBeenCalled()
  })

  it('forwards budgeted optional context through hosted signed creation and binds the entire intent', async () => {
    const f = await fixture()
    const source = await hostedTestClient(f.source), target = await hostedTestClient(f.target)
    const optionalContext = [
      { text: 'Small original source <&> complete.', omittedText: 'Small original was not loaded; read /small.md.' },
      { text: '<&>'.repeat(20000), omittedText: 'Large original was not loaded; read /large.md.' }
    ]
    const original = { ...f.input, optionalContext }
    try {
      await f.pin()
      const admission = await source.sdk.attestAgentCreation({ caller: { agentSessionId: 'source-session', capability: f.capability },
        target: { runtimeId: 'target-runtime', intentDigest: hostAgentCreationIntent(original) } })
      const request = { ...original, initialMessageAdmission: admission }
      const receipt = await target.sdk.createHostAgentWithDelivery(request)
      const timeline = await f.target.sessionTimeline(receipt.session.agentSessionId)
      const system = timeline.items.filter(item => item.kind === 'system_message').map(item => item.content).join('\n\n')
      expect(system).toContain(optionalContext[0]!.text)
      expect(system).toContain(optionalContext[1]!.omittedText)
      expect(system).not.toContain(optionalContext[1]!.text)
      expect(timeline.items.filter(item => item.kind === 'user_message').map(item => item.content).join()).toContain(f.input.prompt!)
      expect((await target.sdk.createHostAgentWithDelivery(request)).session.run).toEqual(receipt.session.run)
      for (const changed of [
        optionalContext.map((part, i) => i ? part : { ...part, text: part.text + 'changed' }),
        optionalContext.map((part, i) => i ? part : { ...part, omittedText: part.omittedText + 'changed' }),
        [...optionalContext].reverse()
      ]) await expect(target.sdk.createHostAgentWithDelivery({ ...request, optionalContext: changed })).rejects.toBeInstanceOf(Error)
      expect(f.start).toHaveBeenCalledTimes(1); expect(f.stop).not.toHaveBeenCalled()
    } finally { await source.dispose(); await target.dispose() }
  })
  it('Hosted direct createAgent retains the original prepared start and unknown prompt without global recovery or replay', async () => {
    const f = await fixture(), global = vi.spyOn(f.target, 'connect').mockRejectedValue(new Error('Unrelated private recovery is unavailable'))
    const input = vi.spyOn((f.target as any).kernel, 'input').mockRejectedValue(new Error('Creation retries must not input'))
    const h = await hostedTestClient(f.target)
    const launch = f.start.getMockImplementation()!
    f.start.mockImplementationOnce(async input => { await launch(input); throw new Error('Private original start acknowledgement lost') })
    const request = { agentSessionId: 'direct-created-session', createOperationId: 'direct-original-operation',
      providerId: 'claude', executorId: 'target-executor', workspacePath: f.root, injectAgentMuxGuide: false, prompt: 'Original direct task' }
    try {
      await expect(h.sdk.createAgent(request)).rejects.toMatchObject({ code: 'AGENT_CREATION_UNCONFIRMED' })
      expect(await f.targetStore.readMetadata(request.agentSessionId)).toBeNull()
      const prepared = await f.targetStore.loadCreationCorrelation(request.agentSessionId)
      expect(prepared?.preparedCreation?.creation?.initialPrompt).toBe('unknown')
      const original = await h.sdk.createAgent(request)
      expect(original).toMatchObject({ agentSessionId: request.agentSessionId, run: { runId: 'target-run' }, creation: { initialPrompt: 'unknown' } })
      expect((await h.sdk.createAgent(request)).run).toEqual(original.run)
      await expect(h.sdk.createAgent({ ...request, prompt: 'Changed original task' })).rejects.toMatchObject({ code: 'AGENT_FORK_OPERATION_CONFLICT' })
      expect(f.start).toHaveBeenCalledOnce(); expect(input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled(); expect(global).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })

  it('Hosted target creation and source attest retain original authority under unavailable Native observation', async () => {
    const f = await fixture(); await f.pin()
    const sourceInner = f.source as any
    const native = vi.spyOn(sourceInner.kernel, 'connect').mockRejectedValue(new Error('Private source Native is unavailable'))
    vi.spyOn(sourceInner.kernel, 'isConnected').mockReturnValue(false)
    const global = vi.spyOn(f.target, 'connect').mockRejectedValue(new Error('Unrelated private target recovery is unavailable'))
    const source = await hostedTestClient(f.source), target = await hostedTestClient(f.target)
    native.mockClear()
    const attest = () => source.sdk.attestAgentCreation({ caller: { agentSessionId: 'source-session', capability: f.capability },
      target: { runtimeId: 'target-runtime', intentDigest: hostAgentCreationIntent(f.input) } })
    try {
      const request = { ...f.input, initialMessageAdmission: await attest() }
      const created = await target.sdk.createHostAgentWithDelivery(request)
      expect(created.session.creation?.initialMessageOrigin?.source).toMatchObject({ runtimeId: 'source-runtime', agentSessionId: 'source-session', runId: 'source-run' })
      expect((await target.sdk.createHostAgentWithDelivery(request)).session.run).toEqual(created.session.run)
      await expect(target.sdk.createHostAgentWithDelivery({ ...request, executorRevision: '0'.repeat(64) })).rejects.toBeInstanceOf(Error)
      await expect(source.sdk.attestAgentCreation({ caller: { agentSessionId: 'source-session', capability: 'forged' },
        target: { runtimeId: 'target-runtime', intentDigest: hostAgentCreationIntent(f.input) } })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
      const old = (await f.sourceStore.readMetadata('source-session'))!
      await f.sourceStore.compareAndSwapMetadata(old, { ...old, run: { runId: 'replacement-source-run' }, retiredRuns: [old.run], capabilityHash: hashAgentCapability(issueAgentCapability()), updatedAt: old.updatedAt + 1 })
      await expect(attest()).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
      expect(native).not.toHaveBeenCalled(); expect(global).not.toHaveBeenCalled(); expect(f.start).toHaveBeenCalledOnce(); expect(f.stop).not.toHaveBeenCalled()
    } finally { await source.dispose(); await target.dispose() }
  })

  it('Hosted prepared inspection connects only its original Runtime after a real lost start receipt, preserving failure and never replaying', async () => {
    const f = await fixture(); await f.pin()
    const request = { ...f.input, initialMessageAdmission: await f.attest() }, launch = f.start.getMockImplementation()!
    f.start.mockImplementationOnce(async input => { await launch(input); throw new Error('Private original start acknowledgement lost') })
    await expect(f.target.createHostAgentWithDelivery(request)).rejects.toMatchObject({ code: 'AGENT_CREATION_UNCONFIRMED' })
    const seed = await f.targetStore.loadCreationCorrelation(request.agentSessionId!)
    expect(seed?.preparedCreation?.creation?.initialPrompt).toBe('unknown')
    const inner = f.target as any
    inner.connected = false
    let connected = false
    vi.spyOn(inner.kernel, 'isConnected').mockImplementation(() => connected)
    const native = vi.spyOn(inner.kernel, 'connect').mockRejectedValue(new AgentMuxError('Private original Native temporarily unavailable', 'CTXMUX_io'))
    const list = vi.spyOn(inner.kernel, 'list').mockRejectedValue(new Error('Unrelated inventory is unavailable'))
    const observation = vi.spyOn(inner.kernel, 'inspectCreation')
    const input = vi.spyOn(inner.kernel, 'input').mockRejectedValue(new Error('Inspection must not input'))
    const global = vi.spyOn(f.target, 'connect').mockRejectedValue(new Error('Unrelated private recovery is unavailable'))
    const h = await hostedTestClient(f.target)
    native.mockClear(); list.mockClear()
    try {
      await expect(h.sdk.inspectAgentCreation(request.agentSessionId!)).rejects.toThrow('Private original Native temporarily unavailable')
      expect(await f.targetStore.loadCreationCorrelation(request.agentSessionId!)).toEqual(seed)
      expect(list).not.toHaveBeenCalled()
      native.mockImplementation(async () => { connected = true })
      const recovered = await h.sdk.inspectAgentCreation(request.agentSessionId!)
      expect(recovered).toMatchObject({ agentSessionId: request.agentSessionId, run: { runId: 'target-run' }, creation: { initialPrompt: 'unknown' } })
      expect(native).toHaveBeenCalledTimes(2); expect(list).not.toHaveBeenCalled(); expect(observation).toHaveBeenCalledExactlyOnceWith(seed!.operationId)
      expect(f.start).toHaveBeenCalledOnce(); expect(input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled(); expect(global).not.toHaveBeenCalled()
    } finally { await h.dispose() }
  })

  it('starts against the target registry without a source Session there; keeps sourced task and original receipt once', async () => {
    const f = await fixture(); await f.pin()
    const request = { ...f.input, initialMessageAdmission: await f.attest() }
    expect(await f.targetStore.load()).toEqual([])
    const first = await f.target.createHostAgentWithDelivery(request)
    expect(first.session).toMatchObject({ agentSessionId: 'target-session', providerId: 'claude', workspacePath: f.root,
      creation: { executorRevision: f.input.executorRevision, initialMessageOrigin: { source: { runtimeId: 'source-runtime', agentSessionId: 'source-session', runId: 'source-run' } } } })
    expect(first.session.forkedFrom).toBeUndefined()
    expect(f.start).toHaveBeenCalledTimes(1)
    expect(f.start.mock.calls[0]![0].args[0]).toContain('<amux:a2a from="source-session"')
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
      retiredRuns: [previous.run], capabilityHash: hashAgentCapability(issueAgentCapability()), updatedAt: _tailFixtureEpoch(0, 0, 2) })
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
client.kernel.inspectCreation=async key=>runs.find(run=>run.lifecycleOperationId===key)??null;client.kernel.list=async()=>{throw Error('recovery must not list')};client.kernel.isConnected=()=>true;for(const action of ['start','stop','input'])client.kernel[action]=async()=>{throw Error('recovery must not '+action)};
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
