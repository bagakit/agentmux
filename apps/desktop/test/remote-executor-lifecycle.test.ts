import { fixtureIso as _hygiene_fixtureIso, fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { AgentMuxClient } from '../../../packages/core/src/client.js'
import { AgentMuxHostExecutorOwner } from '../../../packages/core/src/executor-owner.js'
import { AgentMuxMemoryAgentSessionStore } from '../../../packages/core/src/agent-session-store.js'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session.js'
import { RuntimeController } from '../src/main/runtime-controller.js'
import type { DesktopRuntimeClient } from '../src/main/desktop-host.js'
import type { AppConfig, HostConfig } from '../src/shared/contracts.js'

vi.mock('electron', () => ({ app: {}, nativeImage: {} }))
const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const local = { label: 'Local template', providerId: 'claude', command: _hygiene_fixturePath("local/claude"), args: ['local-only'],
  env: { LOCAL_SECRET: 'must-not-cross' }, injectAgentMuxGuide: false }
const identity = { executorId: 'target-wrapper', providerId: 'claude', workspacePath: _hygiene_fixturePath("target/workspace"),
  nativeHandle: { kind: 'provider' as const, providerId: 'claude', sessionId: 'native-main' }, createdAt: 1 }
const session = { ...identity, kind: 'agent' as const, agentSessionId: 'original-session', hostId: 'local',
  run: { runId: 'original-run' }, retiredRuns: [], updatedAt: 1 }
const source = { providerId: 'claude', nativeSessionId: 'native-main' }
const resource = { source, recordId: 'original-record', partIndex: 0, expectedReference: 'recorded-reference' }
const question = { source, turnId: 'original-turn', recordId: 'original-record', answers: [{ questionId: 'q', answer: 'yes' }],
  operationId: 'original-reply', expectedRun: session.run, afterSubmissionId: null }

function mainFixture(kind: 'local' | 'ssh', template: boolean) {
  const reached = new Error('Target operation reached')
  const client = { connect: vi.fn(async () => {}), dispose: vi.fn(async () => {}), onEvent: () => () => {},
    agentSession: () => session, statusAgent: vi.fn(async () => ({ session, run: session.run })),
    sessionHistorySources: vi.fn(async () => [{ agentSessionId: session.agentSessionId, hostId: 'local', state: 'retired', retiredAt: 10, history: identity }]),
    sessionHistoryPage: vi.fn(async () => { throw reached }), sessionHistoryResource: vi.fn(async () => { throw reached }),
    observeSessionHistory: vi.fn(async () => { throw reached }), replySessionQuestion: vi.fn(async () => { throw reached }),
    resumeAgent: vi.fn(async () => { throw reached }), reopenAgent: vi.fn(async () => { throw reached }),
    ensureAgentContinuity: vi.fn(async () => { throw reached }) }
  const host: HostConfig = kind === 'ssh' ? { id: 'target', kind, label: 'Target', hostname: 'target.invalid' } : { id: 'local', kind, label: 'Local' }
  const config = { hosts: [host], executors: template ? { 'target-wrapper': local } : {}, workspaces: [],
    appearance: { terminalTheme: 'graphite' } } as unknown as AppConfig
  const main = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), async () => { throw new Error('No substitute owner') })
  main.commit({ hosts: [{ id: host.id, config: host, client: client as unknown as DesktopRuntimeClient,
    executionHost: { kind, dispose: async () => {} } as never }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  closes.push(() => main.dispose())
  const control = { kind: 'agent' as const, hostId: host.id, agentSessionId: session.agentSessionId, run: session.run }
  const calls = {
    page: () => main.sessionHistoryPage(control, { limit: 3 }, config),
    resource: () => main.sessionHistoryResource(control, resource, config),
    observe: () => main.observeSessionHistory(control, () => {}, config, new AbortController().signal),
    question: () => main.replyQuestion(control, question, config),
    resume: () => main.resumeSession(control, 'Explicit continuation', 'original-resume', config),
    reopen: () => main.reopenRetiredSession(control, 10, 'original-reopen', config),
    recover: () => main.recoverSession(control, config, undefined, 'original-continuity')
  }
  const methods = { page: client.sessionHistoryPage, resource: client.sessionHistoryResource, observe: client.observeSessionHistory,
    question: client.replySessionQuestion, resume: client.resumeAgent, reopen: client.reopenAgent, recover: client.ensureAgentContinuity }
  return { reached, calls, methods, main, client, config, host }
}

for (const operation of ['page', 'resource', 'observe', 'question', 'resume', 'reopen', 'recover'] as const) {
  it(`Main ${operation} rejects a same-ID rebind at its actual preparation boundary before invoking the old client`, async () => {
    const history = operation === 'page' || operation === 'resource' || operation === 'observe'
    const f = mainFixture(history ? 'local' : 'ssh', true)
    const rebind = () => {
      const replacement = f.host.kind === 'local' ? { ...f.host, label: 'Replacement' } : { ...f.host, hostname: 'replacement.invalid' }
      f.main.commit({ hosts: [{ id: f.host.id, config: replacement,
        client: { ...f.client } as unknown as DesktopRuntimeClient, executionHost: { kind: replacement.kind, dispose: async () => {} } as never }],
        removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
    }
    if (operation === 'page' || operation === 'resource' || operation === 'observe') {
      const read = f.client.sessionHistorySources.getMockImplementation()!
      f.client.sessionHistorySources.mockImplementationOnce(async () => { rebind(); return await read() })
    } else f.client.connect.mockImplementationOnce(async () => { rebind() })
    if (operation === 'observe') await expect(f.calls[operation]()).rejects.toThrow('History observation owner was released.')
    else await expect(f.calls[operation]()).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    expect(f.methods[operation]).not.toHaveBeenCalled()
  })
}

for (const operation of ['page', 'resource', 'observe', 'question', 'resume', 'reopen', 'recover'] as const) {
  it.each([false, true])(`Main ${operation} reaches the original remote owner without a local template or same-name local overrides (template=%s)`, async template => {
    const f = mainFixture('ssh', template)
    await expect(f.calls[operation]()).rejects.toBe(f.reached)
    const args = f.methods[operation].mock.calls[0] as unknown[]
    expect(args).toBeDefined()
    expect(JSON.stringify(args)).not.toMatch(/local-only|must-not-cross|\/local\/claude/)
    const input = operation === 'observe' ? args[2] : operation === 'page' || operation === 'resource' ? args[1] : args[0]
    expect(input).not.toHaveProperty('commandOverride'); expect(input).not.toHaveProperty('args'); expect(input).not.toHaveProperty('env')
  })
  it(`Main local ${operation} retains the explicit local template`, async () => {
    const f = mainFixture('local', true)
    await expect(f.calls[operation]()).rejects.toBe(f.reached)
    const args = f.methods[operation].mock.calls[0] as unknown[]
    const input = operation === 'observe' ? args[2] : operation === 'page' || operation === 'resource' ? args[1] : args[0]
    expect(input).toMatchObject({ commandOverride: local.command, args: local.args, env: local.env })
  })
}

async function targetFixture(options: { providerId?: 'claude' | 'codex'; targetOwned?: boolean; nativeSessionId?: string } = {}) {
  const f = await nativeHistoryFixture('claude', jsonl([{ uuid: 'original-record', type: 'user', sessionId: 'native-main',
    timestamp: _hygiene_fixtureIso(24537600000, "second"), message: { role: 'user', content: 'Original retained task' } }]), options)
  closes.push(f.close)
  const stored = { ...f.session, executorId: 'target-wrapper', ...(options.targetOwned ? {
    creation: { createOperationId: 'original-create', executorRevision: 'a'.repeat(64), initialPrompt: 'confirmed' as const }
  } : {}) }
  await f.store.compareAndSwap(f.session, stored)
  const provider = f.client.providers.get('claude')
  const page = vi.fn(provider.readSessionHistoryPage!.bind(provider))
  const observe = vi.fn(provider.observeSessionHistory!.bind(provider))
  const prepare = vi.fn<NonNullable<typeof provider.prepareSessionQuestionReply>>(async _context => { throw new Error('Exact question reader reached') })
  const record = vi.fn<NonNullable<typeof provider.readSessionHistoryRecord>>(async _context => { throw new Error('Exact resource reader reached') })
  const resume = vi.fn<typeof provider.buildResumeLaunch>(_context => { throw new Error('Exact resume planner reached') })
  const executors = new AgentMuxHostExecutorOwner({ path: join(f.root, 'executors.json'), runtimeId: 'target-runtime',
    catalog: () => [provider.catalog, f.client.providers.get('codex').catalog] })
  await executors.configure({ executorId: stored.executorId, config: { label: 'Private wrapper', providerId: options.providerId ?? 'claude', command: '/bin/sh',
    args: ['target-only'], env: { TARGET_SECRET: 'private-target-value' }, injectAgentMuxGuide: false } })
  const resolveExecutor = executors.resolve.bind(executors)
  const resolve = vi.spyOn(executors, 'resolve')
  const core = new AgentMuxClient({ store: f.store, hostExecutorOwner: executors,
    providers: [{ ...provider, readSessionHistoryPage: page, observeSessionHistory: observe,
      prepareSessionQuestionReply: prepare, readSessionHistoryRecord: record, buildResumeLaunch: resume }] })
  closes.push(() => core.dispose())
  const inner = core as unknown as { connected: boolean; registry: { load(hostId: string): Promise<void> }; kernel: Record<string, unknown> }
  await inner.registry.load('local'); inner.connected = true
  const start = vi.fn(), stop = vi.fn()
  Object.assign(inner.kernel, { isConnected: () => true, status: async () => ({ runId: stored.run.runId, workspacePath: stored.workspacePath,
    program: '/bin/sh', args: [], pid: 99, state: { type: 'exited', code: 0 }, latestOutputBytes: 0, firstAvailableByte: 0,
    acceptedInputBytes: 0, nativeService: null, cols: 80, rows: 24 }), start, stop })
  vi.spyOn(core, 'probeAgent').mockResolvedValue({ providerId: 'claude', installed: true, executable: '/bin/sh', capabilities: provider.catalog.capabilities })
  return { ...f, stored, core, inner, executors, resolve, resolveExecutor, page, observe, prepare, record, resume, start, stop }
}
function targetInvocation(value: unknown) {
  expect(value).toMatchObject({ command: '/bin/sh', args: ['target-only'], env: { TARGET_SECRET: 'private-target-value' } })
  expect(JSON.stringify(value)).not.toMatch(/must-not-cross|local-only/)
}

it('target Core resolves private wrapper configuration for actual retained pages, observations, resource and question readers', async () => {
  const f = await targetFixture(), id = f.stored.agentSessionId
  const result = await f.core.sessionHistoryPage(id)
  expect(result.items.map(item => item.id)).toEqual(['original-record'])
  expect(JSON.stringify(result)).not.toContain('private-target-value')
  targetInvocation(f.page.mock.calls[0]![0])
  expect(f.resolve).toHaveBeenCalledTimes(1)
  const watch = await f.core.observeSessionHistory(id, () => {}); watch.dispose()
  targetInvocation(f.observe.mock.calls[0]![0])
  expect(f.resolve).toHaveBeenCalledTimes(2)
  await expect(f.core.sessionHistoryResource(id, resource)).rejects.toThrow('Exact resource reader reached')
  targetInvocation(f.record.mock.calls[0]![0])
  expect(f.resolve).toHaveBeenCalledTimes(3)
  await expect(f.core.replySessionQuestion({ ...question, agentSessionId: id, expectedRun: f.stored.run })).rejects.toThrow('Exact question reader reached')
  targetInvocation(f.prepare.mock.calls[0]![0])
  expect(f.resolve).toHaveBeenCalledTimes(4)
  expect(f.start).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  expect((await f.store.readMetadata(id))?.nativeHandle).toEqual(f.stored.nativeHandle)
})

it.each([false, true])('target Core resolves the original wrapper before explicit resume/reopen planning (retired=%s), preserving native identity and no failed-start side effects', async retired => {
  const f = await targetFixture(), id = f.stored.agentSessionId
  if (retired) {
    const reservation = { kind: 'stop' as const, reservationId: 'original-stop', ownerId: 'stop-owner', ownerPid: process.pid,
      agentSessionId: id, expectedRun: f.stored.run, operationId: 'original-stop', expiresAt: Date.now() + 60_000,
      stopOperation: { daemonInstance: 'original-native', operationKey: 'original-stop', runId: f.stored.run.runId } }
    await f.store.reserveLifecycle(reservation); await f.store.commitLifecycle(reservation, null)
    await f.inner.registry.load('local')
    const original = (await f.core.sessionHistorySources())[0]!
    await expect(f.core.reopenAgent({ agentSessionId: id, expectedRetiredAt: original.retiredAt!, operationId: 'original-reopen' })).rejects.toThrow('Exact resume planner reached')
  } else await expect(f.core.resumeAgent({ agentSessionId: id, operationId: 'original-resume', prompt: 'Continue exactly' })).rejects.toThrow('Exact resume planner reached')
  const planned = f.resume.mock.calls[0]![0]
  expect(planned).toMatchObject({ commandOverride: '/bin/sh', args: ['target-only'], env: { TARGET_SECRET: 'private-target-value' },
    workspacePath: f.stored.workspacePath, nativeHandle: f.stored.nativeHandle })
  expect(f.start).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  expect((await f.core.sessionHistorySources())[0]?.history?.nativeHandle).toEqual(f.stored.nativeHandle)
})

it('target-owned resume ignores caller invocation overrides and retains the original Provider/native target', async () => {
  const f = await targetFixture({ targetOwned: true })
  await expect(f.core.resumeAgent({ agentSessionId: f.stored.agentSessionId, operationId: 'original-resume', prompt: 'Continue exactly',
    commandOverride: local.command, args: local.args, env: local.env })).rejects.toThrow('Exact resume planner reached')
  expect(f.resume.mock.calls[0]![0]).toMatchObject({ commandOverride: '/bin/sh', args: ['target-only'], env: { TARGET_SECRET: 'private-target-value' } })
  expect(f.start).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})

it('active target-owned history resolves its authoritative private configuration despite explicit SDK overrides', async () => {
  const f = await targetFixture({ targetOwned: true }), id = f.stored.agentSessionId
  const options = { commandOverride: local.command, args: local.args, env: local.env }
  expect((await f.core.sessionHistoryPage(id, options)).items[0]?.id).toBe('original-record')
  targetInvocation(f.page.mock.calls[0]![0])
  const watch = await f.core.observeSessionHistory(id, () => {}, options); watch.dispose()
  targetInvocation(f.observe.mock.calls[0]![0])
  await expect(f.core.sessionHistoryResource(id, { ...resource, ...options })).rejects.toThrow('Exact resource reader reached')
  targetInvocation(f.record.mock.calls[0]![0])
  await expect(f.core.replySessionQuestion({ ...question, ...options, agentSessionId: id, expectedRun: f.stored.run })).rejects.toThrow('Exact question reader reached')
  targetInvocation(f.prepare.mock.calls[0]![0])
  expect(f.start).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})

it('legacy SDK history retains its explicit invocation configuration even when a Host owner is present', async () => {
  const f = await targetFixture()
  expect((await f.core.sessionHistoryPage(f.stored.agentSessionId, { commandOverride: local.command,
    args: local.args, env: local.env })).items[0]?.id).toBe('original-record')
  expect(f.page.mock.calls[0]![0]).toMatchObject({ command: local.command, args: local.args, env: local.env })
  expect(f.resolve).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})

it('a retired read-only locator preserves the explicit SDK configuration contract without inventing creation authority', async () => {
  const f = await targetFixture({ targetOwned: true }), id = f.stored.agentSessionId
  const reservation = { kind: 'stop' as const, reservationId: 'original-stop', ownerId: 'stop-owner', ownerPid: process.pid,
    agentSessionId: id, expectedRun: f.stored.run, operationId: 'original-stop', expiresAt: Date.now() + 60_000,
    stopOperation: { daemonInstance: 'original-native', operationKey: 'original-stop', runId: f.stored.run.runId } }
  await f.store.reserveLifecycle(reservation); await f.store.commitLifecycle(reservation, null)
  await f.inner.registry.load('local')
  expect((await f.core.sessionHistoryPage(id, { commandOverride: local.command, args: local.args, env: local.env })).items[0]?.id).toBe('original-record')
  expect(f.page.mock.calls[0]![0]).toMatchObject({ command: local.command, args: local.args, env: local.env })
  expect(f.resolve).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})

it('a source change while resolving the target configuration is rejected before the Provider read', async () => {
  const f = await targetFixture(), id = f.stored.agentSessionId
  f.resolve.mockImplementationOnce(async executorId => {
    const configuration = await f.resolveExecutor(executorId)
    await f.store.compareAndSwap(f.stored, { ...f.stored,
      nativeHandle: { ...f.stored.nativeHandle!, sessionId: 'changed-during-configuration' } })
    return configuration
  })
  await expect(f.core.sessionHistoryPage(id)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  expect(f.page).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  expect((await f.store.readMetadata(id))?.run).toEqual(f.stored.run)
})

it('a temporary native observation released during configuration resolution cannot authorize a new Provider read', async () => {
  const f = await targetFixture({ nativeSessionId: 'retained-old' }), id = f.stored.agentSessionId
  Object.assign(f.inner.kernel, { status: async () => ({ runId: f.stored.run.runId, workspacePath: f.stored.workspacePath,
    program: '/bin/sh', args: [], pid: 99, state: { type: 'running' }, latestOutputBytes: 0, firstAvailableByte: 0,
    acceptedInputBytes: 0, nativeService: null, cols: 80, rows: 24 }) })
  const provider = f.core.providers.get('claude')
  expect(provider.discoverNativeSession).toBeTypeOf('function')
  vi.spyOn(provider as typeof provider & { discoverNativeSession: NonNullable<typeof provider.discoverNativeSession> }, 'discoverNativeSession').mockResolvedValue({
    handle: { kind: 'provider', providerId: 'claude', sessionId: 'native-main', transcriptPath: f.path }, assertCurrent: async () => {}
  })
  vi.spyOn(f.store, 'compareAndSwapMetadata').mockRejectedValueOnce(Object.assign(new Error('Controlled save failure'), { code: 'EIO' }))
  const watch = await f.core.observeSessionHistory(id, () => {})
  expect(watch.source.nativeSessionId).toBe('native-main')
  expect((await f.store.readMetadata(id))?.nativeHandle?.sessionId).toBe('retained-old')
  f.resolve.mockImplementationOnce(async executorId => {
    const configuration = await f.resolveExecutor(executorId)
    watch.dispose()
    return configuration
  })
  await expect(f.core.sessionHistoryPage(id)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  expect(f.page).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})

it('a conflicting target registration rejects this read before changing Provider, native identity or Run', async () => {
  const f = await targetFixture({ providerId: 'codex' })
  await expect(f.core.sessionHistoryPage(f.stored.agentSessionId)).rejects.toMatchObject({ code: 'EXECUTOR_PROVIDER_CONFLICT' })
  expect(f.page).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  expect((await f.store.readMetadata(f.stored.agentSessionId))?.nativeHandle).toEqual(f.stored.nativeHandle)
})

it('a missing target owner refuses an unresolvable resume without substituting a Provider command or replacing the Session', async () => {
  const f = await targetFixture({ targetOwned: true })
  Object.assign(f.core, { hostExecutorOwner: undefined })
  await expect(f.core.resumeAgent({ agentSessionId: f.stored.agentSessionId, operationId: 'original-resume', prompt: 'Continue exactly' })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(f.resume).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  expect((await f.store.readMetadata(f.stored.agentSessionId))?.run).toEqual(f.stored.run)
})

it('a healthy original Run remains reattachable without resolving or probing its unavailable target owner', async () => {
  const f = await targetFixture({ targetOwned: true })
  Object.assign(f.core, { hostExecutorOwner: undefined })
  Object.assign(f.inner.kernel, { status: async () => ({ runId: f.stored.run.runId, workspacePath: f.stored.workspacePath,
    program: '/bin/sh', args: [], pid: 99, state: { type: 'running' }, latestOutputBytes: 0, firstAvailableByte: 0,
    acceptedInputBytes: 0, nativeService: null, cols: 80, rows: 24 }) })
  await expect(f.core.ensureAgentContinuity({ agentSessionId: f.stored.agentSessionId, expectedRun: f.stored.run,
    operationId: 'original-continuity' })).resolves.toMatchObject({ kind: 'reattachable' })
  expect(f.core.probeAgent).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  expect((await f.store.readMetadata(f.stored.agentSessionId))?.run).toEqual(f.stored.run)
})
