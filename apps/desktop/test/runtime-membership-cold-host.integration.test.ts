import { EventEmitter } from 'node:events'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxError, AgentMuxFileAgentSessionStore, AgentProviderRegistry, defaultAgentMuxControlSocketPath,
  type AgentMuxAgentSession, type AgentMuxClientEvent } from '@agentmux/core'
import { headlessFixture, until } from '../../../packages/core/test/helpers/headless-runtime-fixture.js'
import { startAgentMuxHost } from '../../host/src/host.js'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import { connectDesktopAgentMuxHost } from '../src/main/desktop-host.js'
import type { AppConfig, RuntimeEvent } from '../src/shared/contracts.js'
import type { WebContents } from 'electron'

vi.mock('electron', async () => { const { fixturePath: privateMembershipFixturePath } = await import("../../../test/fixture-values.mjs"); return { app: { getPath: () => privateMembershipFixturePath('unused-private-cold-membership') } } })
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const dispose of cleanup.splice(0).reverse()) try { await dispose() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Private cold membership cleanup failed')
})
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

it('cold actual Host/Main projects original Agent bindings before lifecycle loading and after a sibling handshake cursor failure', async () => {
  const scope = await headlessFixture(); cleanup.push(scope.cleanup)
  await scope.stopOwner()
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
  for (const [key, value] of Object.entries(scope.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, value!)
  const store = new AgentMuxFileAgentSessionStore(scope.env.AGENTMUX_AGENT_SESSION_STORE!)
  const codex = new AgentProviderRegistry().get('codex')
  const seed = await startAgentMuxHost({ store, providers: [codex], socketPath: defaultAgentMuxControlSocketPath() }); cleanup.push(seed.dispose)
  const previous = seed.client, originals: AgentMuxAgentSession[] = []
  await previous.connect()
  const initialKernel = (previous as unknown as { kernel: { input: (...args: unknown[]) => Promise<unknown> } }).kernel
  // The real creation owner persists its original handshake claim. A precise
  // pre-dispatch fault leaves those bytes unapplied, without forging any receipt.
  const dispatch = vi.spyOn(initialKernel, 'input').mockRejectedValueOnce(new AgentMuxError(
    'Private transport did not dispatch the original handshake.', 'CTXMUX_io', undefined, { disposition: 'not_applied', confirmedInputBytes: 0 }))
  for (const suffix of ['uncertain', 'healthy']) {
    const session = await previous.createAgent({ providerId: 'codex', executorId: 'codex',
      agentSessionId: `private-cold-membership-${suffix}`, createOperationId: `private-cold-create-${suffix}`,
      workspacePath: scope.root, commandOverride: resolve('packages/core/test/fixtures/fake-codex-cli.mjs'), args: [],
      env: { AGENTMUX_FAKE_READY_MODE: 'before' }, injectAgentMuxGuide: false })
    originals.push(session)
  }
  const [uncertain, healthy] = originals as [AgentMuxAgentSession, AgentMuxAgentSession]
  dispatch.mockRestore()
  const pending = (await store.readMetadata(uncertain.agentSessionId))!
  expect(pending.terminalHandshake?.acknowledged).toBe(false)
  const nativeBefore = previous.runtimeIdentity()
  await previous.writeTerminal(uncertain.run, { ownerInstanceId: nativeBefore.instanceId,
    operationId: 'private-cold-authorized-input', expectedByte: 0, data: 'Original authorized input\r' })
  const raw = await previous.createTerminal({ workspacePath: scope.root, command: process.execPath,
    args: ['-e', 'process.stdin.resume()'], cols: 80, rows: 24 })
  const retired = await previous.createTerminal({ workspacePath: scope.root, command: process.execPath,
    args: ['-e', 'process.stdin.resume()'], cols: 80, rows: 24 })
  const before = await previous.statusAgent(uncertain.agentSessionId)
  const healthyBefore = await previous.statusAgent(healthy.agentSessionId)
  expect(before.run.acceptedInputBytes).toBeGreaterThan(pending.terminalHandshake!.inputByteRange.startByte)
  await seed.dispose() // Only the isolated semantic owner; its original Native/PTYs survive.
  await store.retireRuns([{ runId: retired.runId }])
  await store.compareAndSwapMetadata(null, { kind: 'agent', agentSessionId: 'private-foreign-metadata',
    providerId: 'codex', executorId: 'codex', hostId: 'other-host', workspacePath: scope.root,
    run: { runId: raw.runId }, retiredRuns: [], hookBindingId: 'f'.repeat(43), hookToken: 't'.repeat(43),
    createdAt: pending.createdAt, updatedAt: pending.updatedAt })
  const entering = deferred(), release = deferred()
  cleanup.push(async () => { release.resolve() })
  const claim = store.claimStaleLifecycles.bind(store)
  vi.spyOn(store, 'claimStaleLifecycles').mockImplementationOnce(async (...args) => {
    entering.resolve(); await release.promise; return await claim(...args)
  })
  const host = await startAgentMuxHost({ store, providers: [codex], socketPath: defaultAgentMuxControlSocketPath() })
  cleanup.push(host.dispose)
  await entering.promise
  expect(host.client.agentSessions()).toEqual([]) // Strong cold-load oracle: registry.load has not run.
  const kernel = (host.client as unknown as { kernel: { input: (...args: unknown[]) => Promise<unknown> } }).kernel
  const input = vi.spyOn(kernel, 'input')
  const events: AgentMuxClientEvent[] = []
  host.client.onEvent(event => events.push(event))
  const sessionObservation = deferred(), connect = host.client.connect.bind(host.client)
  const observeSession = vi.spyOn(host.client, 'connect').mockImplementation(() => { sessionObservation.resolve(); return connect() })
  let eventObservationAvailable = false
  const subscribe = host.hosted.subscribe.bind(host.hosted)
  vi.spyOn(host.hosted, 'subscribe').mockImplementation(async (method, ...args) => {
    if (method === 'runtime.events' && !eventObservationAvailable) throw new AgentMuxError(
      'Private general Session event observation is not yet available.', 'CONTROL_UNAVAILABLE')
    return await subscribe(method, ...args)
  })
  const controller = new RuntimeController(store, connectDesktopAgentMuxHost)
  cleanup.push(() => controller.dispose())
  const config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), hosts: [{ id: 'local', kind: 'local', label: 'Private original Host' }],
    workspaces: [{ id: 'private-cold-workspace', hostId: 'local', kind: 'folder', name: 'Private', path: scope.root }] }
  controller.commit(await controller.prepare(config))
  const delivered: RuntimeEvent[] = []
  const contents = Object.assign(new EventEmitter(), { id: 73, isDestroyed: () => false,
    send: (_channel: string, event: RuntimeEvent) => delivered.push(event) }) as unknown as WebContents
  cleanup.push(controller.attach(contents))
  const assertMembers = (snapshot: Awaited<ReturnType<typeof controller.snapshot>>) => {
    for (const session of [uncertain, healthy]) {
      const projected = snapshot.sessions.find(current => current.id === session.agentSessionId)!
      expect(projected, 'the original durable Agent must never become a raw Terminal').toMatchObject({
        kind: 'agent', id: session.agentSessionId, processState: 'running',
        control: { kind: 'agent', hostId: 'local', agentSessionId: session.agentSessionId, run: session.run } })
    }
    expect(snapshot.sessions.find(session => session.id === raw.runId)?.kind).toBe('terminal')
    expect(snapshot.sessions.some(session => session.id === retired.runId)).toBe(false)
  }
  const opening = await Promise.race([
    controller.snapshot(config).then(snapshot => ({ snapshot })),
    sessionObservation.promise.then(() => ({ snapshot: null }))
  ])
  expect(opening.snapshot, 'membership must not start or wait for full Session recovery').not.toBeNull()
  assertMembers(opening.snapshot!)
  const coldProjection = await host.client.runtimeProjection()
  for (const [session, known] of [[uncertain, before], [healthy, healthyBefore]] as const) {
    expect(coldProjection.subjects.find(subject => subject.run.runId === session.run.runId)?.run.pid).toBe(known.run.pid)
  }
  expect(host.client.agentSessions()).toEqual([])
  expect(input).not.toHaveBeenCalled()
  expect(observeSession).not.toHaveBeenCalled()
  observeSession.mockRestore()
  expect((await store.readMetadata(uncertain.agentSessionId))!.terminalHandshake).toEqual(pending.terminalHandshake)
  eventObservationAvailable = true
  await controller.rpcClients()[0]!.client.connect()
  const observation = host.client.connect().then(() => null, error => error)
  release.resolve()
  expect(await observation).toMatchObject({ code: 'CTXMUX_input_cursor_mismatch' })
  expect(events.some(event => event.type === 'agent-error' && event.code === 'CTXMUX_CONNECTION_OBSERVATION_FAILED')).toBe(true)
  const attempted = input.mock.calls.length
  expect(attempted).toBeGreaterThan(0)
  assertMembers(await controller.snapshot(config))
  assertMembers(await controller.snapshot(config))
  expect(input).toHaveBeenCalledTimes(attempted) // Reading membership never retries terminal input.
  expect(host.client.runtimeIdentity()).toEqual(nativeBefore)
  expect((await host.client.statusAgent(uncertain.agentSessionId)).run).toMatchObject({
    runId: uncertain.run.runId, pid: before.run.pid, state: 'running', acceptedInputBytes: before.run.acceptedInputBytes })
  expect((await store.readMetadata(uncertain.agentSessionId))!.terminalHandshake).toEqual(pending.terminalHandshake)
  await until(() => delivered, values => values.some(event => event.type === 'core' && event.event.type === 'connection-state' &&
    event.event.diagnostic?.code === 'CTXMUX_CONNECTION_OBSERVATION_FAILED'), 'ongoing original service window')
  expect(controller.endpointWarningSnapshot()).toContainEqual(expect.objectContaining({
    scope: 'observation', availability: 'connected', code: 'CTXMUX_CONNECTION_OBSERVATION_FAILED' }))
}, 60_000)

it('Main consumes an original owner resume completed during its delayed metadata/Native read without publishing the new Run as a Terminal', async () => {
  const scope = await headlessFixture(); cleanup.push(scope.cleanup); await scope.stopOwner()
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
  for (const [key, value] of Object.entries(scope.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, value!)
  const store = new AgentMuxFileAgentSessionStore(scope.env.AGENTMUX_AGENT_SESSION_STORE!)
  const host = await startAgentMuxHost({ store, socketPath: defaultAgentMuxControlSocketPath() }); cleanup.push(host.dispose)
  await host.client.connect()
  const fakeCli = resolve('packages/core/test/fixtures/fake-codex-cli.mjs')
  const original = await host.client.createAgent({ providerId: 'codex', executorId: 'codex',
    agentSessionId: 'private-cold-racing-resume', createOperationId: 'private-cold-racing-create',
    workspacePath: scope.root, commandOverride: fakeCli, args: [],
    env: { AGENTMUX_FAKE_READY_MODE: 'before', AGENTMUX_FAKE_NATIVE_RECORD: '1',
      AGENTMUX_FAKE_NATIVE_RECORD_DIRECTORY: join(scope.root, 'native') }, injectAgentMuxGuide: false })
  await until(() => host.client.agentSession(original.agentSessionId), session => Boolean(session.nativeHandle), 'original native resume handle')
  const active = await host.client.statusAgent(original.agentSessionId)
  expect(active.run.pid).toBeGreaterThan(1)
  // End only the child this private fixture just created. This leaves the
  // original Core Session retained, unlike retiring it through Stop.
  process.kill(active.run.pid!, 'SIGTERM')
  await until(() => host.client.statusAgent(original.agentSessionId), status => status.run.state === 'exited', 'original private Run terminal exit')
  const controller = new RuntimeController(store, connectDesktopAgentMuxHost)
  cleanup.push(() => controller.dispose())
  const config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), hosts: [{ id: 'local', kind: 'local', label: 'Original Host' }],
    workspaces: [{ id: 'private-racing-workspace', hostId: 'local', kind: 'folder', name: 'Private', path: scope.root }] }
  controller.commit(await controller.prepare(config)); await controller.snapshot(config)
  const entered = deferred(), release = deferred(); cleanup.push(async () => { release.resolve() })
  const read = store.loadMetadata.bind(store)
  vi.spyOn(store, 'loadMetadata').mockImplementationOnce(async () => {
    const old = await read(); entered.resolve(); await release.promise; return old
  })
  const kernel = (host.client as unknown as { kernel: { list: () => Promise<unknown> } }).kernel
  const list = kernel.list.bind(kernel)
  vi.spyOn(kernel, 'list').mockImplementationOnce(async () => { await release.promise; return await list() })
  const reading = controller.snapshot(config)
  await entered.promise
  const resumed = await host.client.resumeAgent({ agentSessionId: original.agentSessionId,
    expectedRun: original.run, operationId: 'private-cold-racing-resume-operation', commandOverride: fakeCli,
    prompt: 'Continue the same original private conversation.',
    env: { AGENTMUX_FAKE_READY_MODE: 'before', AGENTMUX_FAKE_NATIVE_RECORD: '1',
      AGENTMUX_FAKE_NATIVE_RECORD_DIRECTORY: join(scope.root, 'native') }, injectAgentMuxGuide: false })
  expect(resumed.run).not.toEqual(original.run)
  expect((await store.readMetadata(original.agentSessionId))!.run).toEqual(resumed.run)
  release.resolve()
  const snapshot = await reading
  expect(snapshot.sessions).toContainEqual(expect.objectContaining({ kind: 'agent', id: original.agentSessionId,
    control: { kind: 'agent', hostId: 'local', agentSessionId: original.agentSessionId, run: resumed.run }, processState: 'running' }))
  expect(snapshot.sessions.some(session => session.id === resumed.run.runId || session.id === original.run.runId)).toBe(false)
}, 60_000)
