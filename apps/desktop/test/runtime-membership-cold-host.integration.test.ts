import { EventEmitter } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxError, AgentMuxFileAgentSessionStore, AgentProviderRegistry, connectAgentMuxRpc, defaultAgentMuxControlSocketPath,
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

it('cold actual Host/Main delivers original Agent and Terminal attachments before recovery and after a sibling handshake failure', async () => {
  const scope = await headlessFixture(); cleanup.push(scope.cleanup)
  await scope.stopOwner()
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
  for (const [key, value] of Object.entries(scope.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, value!)
  const store = new AgentMuxFileAgentSessionStore(scope.env.AGENTMUX_AGENT_SESSION_STORE!)
  const codex = new AgentProviderRegistry().get('codex')
  const seed = await startAgentMuxHost({ store, providers: [codex], socketPath: defaultAgentMuxControlSocketPath() }); cleanup.push(seed.dispose)
  const previous = seed.client, originals: AgentMuxAgentSession[] = []
  await previous.connect()
  // Only these private children watch their own fixture file. Changing stdout
  // exercises real ordered output without sending any additional PTY input.
  const outputCli = join(scope.root, 'private-output-cli.mjs')
  await writeFile(outputCli, `#!/usr/bin/env node
    import { readFileSync } from 'node:fs'
    let emitted = ''
    setInterval(() => {
      try {
        const value = readFileSync(process.env.PRIVATE_COLD_OUTPUT_FILE, 'utf8')
        if (value && value !== emitted) { emitted = value; process.stdout.write('\\r\\n' + value + '\\r\\n') }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }, 10)
    if (process.argv[2] === 'private-raw') process.stdin.resume()
    else await import(${JSON.stringify(pathToFileURL(resolve('packages/core/test/fixtures/fake-codex-cli.mjs')).href)})
  `, { mode: 0o700 })
  const healthyOutput = join(scope.root, 'healthy-output'), rawOutput = join(scope.root, 'raw-output')
  const initialKernel = (previous as unknown as { kernel: { input: (...args: unknown[]) => Promise<unknown> } }).kernel
  // The real creation owner persists its original handshake claim. A precise
  // pre-dispatch fault leaves those bytes unapplied, without forging any receipt.
  const dispatch = vi.spyOn(initialKernel, 'input').mockRejectedValueOnce(new AgentMuxError(
    'Private transport did not dispatch the original handshake.', 'CTXMUX_io', undefined, { disposition: 'not_applied', confirmedInputBytes: 0 }))
  for (const suffix of ['uncertain', 'healthy']) {
    const session = await previous.createAgent({ providerId: 'codex', executorId: 'codex',
      agentSessionId: `private-cold-membership-${suffix}`, createOperationId: `private-cold-create-${suffix}`,
      workspacePath: scope.root, commandOverride: outputCli, args: [],
      env: { AGENTMUX_FAKE_READY_MODE: 'before', PRIVATE_COLD_OUTPUT_FILE: suffix === 'healthy' ? healthyOutput : join(scope.root, 'uncertain-output') },
      injectAgentMuxGuide: false })
    originals.push(session)
  }
  const [uncertain, healthy] = originals as [AgentMuxAgentSession, AgentMuxAgentSession]
  dispatch.mockRestore()
  const pending = (await store.readMetadata(uncertain.agentSessionId))!
  expect(pending.terminalHandshake?.acknowledged).toBe(false)
  const nativeBefore = previous.runtimeIdentity()
  const nativeProcessId = scope.nativeProcessId
  expect(nativeProcessId).toBeGreaterThan(1)
  await previous.writeTerminal(uncertain.run, { ownerInstanceId: nativeBefore.instanceId,
    operationId: 'private-cold-authorized-input', expectedByte: 0, data: 'Original authorized input\r' })
  const raw = await previous.createTerminal({ workspacePath: scope.root, command: process.execPath,
    args: [outputCli, 'private-raw'], env: { PRIVATE_COLD_OUTPUT_FILE: rawOutput }, cols: 80, rows: 24 })
  const retired = await previous.createTerminal({ workspacePath: scope.root, command: process.execPath,
    args: ['-e', 'process.stdin.resume()'], cols: 80, rows: 24 })
  const before = await previous.statusAgent(uncertain.agentSessionId)
  const healthyBefore = await previous.statusAgent(healthy.agentSessionId)
  const targets = [
    { id: healthy.agentSessionId, run: healthy.run, pid: healthyBefore.run.pid, file: healthyOutput, initial: 'private-original-agent-output' },
    { id: raw.runId, run: { runId: raw.runId }, pid: raw.pid, file: rawOutput, initial: 'private-original-terminal-output' }
  ]
  for (const target of targets) {
    expect(target.pid).toBeGreaterThan(1)
    await writeFile(target.file, target.initial)
    await until(() => previous.readRunReplay(target.run), value => value.replay.map(chunk => chunk.data).join('').includes(target.initial),
      'private original stdout before owner restart')
  }
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
  const kernel = (host.client as unknown as { kernel: {
    input: (...args: unknown[]) => Promise<unknown>; start: (...args: unknown[]) => Promise<unknown>; hasAttachment(runId: string): boolean
  } }).kernel
  const input = vi.spyOn(kernel, 'input'), start = vi.spyOn(kernel, 'start')
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
  // A cold standalone get still has no loaded registry. The actual attachment
  // must resolve its own exact metadata before Main asks for its Runtime Subject.
  await expect(host.client.runtimeSubject({ kind: 'agent-session', agentSessionId: healthy.agentSessionId }, healthyBefore.run))
    .rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
  const attachmentProofs: Array<{ phase: string; runId: string; pid: number | null; initialBytes: number; liveBytes: number }> = []
  const attachOriginals = async (phase: 'pending' | 'failed') => {
    const inputCount = input.mock.calls.length
    for (const target of targets) {
      const projected = opening.snapshot!.sessions.find(session => session.id === target.id)!
      const pendingAttachment = controller.attachSession(contents.id, projected.control, 0, config)
        .then(value => ({ value }), error => ({ error }))
      const attached = phase === 'pending' ? await Promise.race([
        pendingAttachment, sessionObservation.promise.then(() => ({ unrelatedRecovery: true as const }))
      ]) : await pendingAttachment
      // An actual classification regression must fail this semantic assertion,
      // then release only this fixture's gate so cleanup cannot hang behind it.
      if (!('value' in attached)) { release.resolve(); await pendingAttachment }
      expect(attached, 'original Main attachment must not wait for unrelated Session recovery').toHaveProperty('value')
      if (!('value' in attached)) throw new Error('Private original Attachment did not complete')
      const value = attached.value
      try {
        expect(value.attachmentId).toBeTruthy()
        expect(value.session).toMatchObject({ id: target.id, processState: 'running', control: { run: target.run } })
        expect(value.currentSize).toMatchObject({ cols: expect.any(Number), rows: expect.any(Number) })
        expect(value.gap).toBeNull()
        const original = value.terminal.type === 'basic-vt' ? new TextDecoder().decode(value.terminal.restoreBytes) : ''
        expect(original + value.replay.map(chunk => chunk.data).join('')).toContain(target.initial)
        const native = (await host.client.listRuns()).find(run => run.runId === target.run.runId)!
        expect(native).toMatchObject({ runId: target.run.runId, pid: target.pid, state: 'running' })
        const from = delivered.length, marker = `private-${phase}-${target.id}-live-output`
        const live = () => delivered.slice(from).flatMap(event => event.type === 'core' && event.event.type === 'terminal-output' &&
          event.event.run.runId === target.run.runId ? [event.event] : [])
        await writeFile(target.file, marker)
        const output = await until(live, values => values.map(event => event.data).join('').includes(marker), 'original Main live output')
        let cursor = value.session.latestOutputBytes
        for (const event of output) {
          const range = event.evidence.outputByteRange
          expect(range.startByte).toBe(cursor)
          expect(range.endByte - range.startByte).toBe(event.dataBytes.length)
          cursor = range.endByte
        }
        expect(cursor).toBeGreaterThan(value.session.latestOutputBytes)
        attachmentProofs.push({ phase, runId: target.run.runId, pid: native.pid,
          initialBytes: Buffer.byteLength(original) + value.replay.reduce((sum, chunk) => sum + chunk.dataBytes.length, 0),
          liveBytes: cursor - value.session.latestOutputBytes })
      } finally { await controller.detachSession(contents.id, value.attachmentId) }
      await until(() => kernel.hasAttachment(target.run.runId), value => !value, 'original reader lease release')
      // Leave the same known original marker for the next independently opened cut.
      await writeFile(target.file, target.initial)
      await until(() => host.client.readRunReplay(target.run), value => value.replay.map(chunk => chunk.data).join('').includes(target.initial),
        'private output retained after reader release')
    }
    expect(input).toHaveBeenCalledTimes(inputCount)
    expect(start).not.toHaveBeenCalled()
    expect(host.client.runtimeIdentity()).toEqual(nativeBefore)
    expect(scope.nativeProcessId).toBe(nativeProcessId)
  }
  await attachOriginals('pending')
  expect(observeSession).not.toHaveBeenCalled()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: defaultAgentMuxControlSocketPath() } })
  try {
    const { owner } = await rpc.call('runtime.owner.identity', {})
    await expect(rpc.call('runtime.invoke', { consumerId: 'private-wrong-owner',
      fence: { runtimeId: owner.runtimeId, ownerInstanceId: 'another-private-owner' },
      invocation: { method: 'runtimeSubject', args: [{ kind: 'terminal-run', runId: raw.runId }, raw] } }))
      .rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
  } finally { await rpc.dispose() }
  const healthyControl = opening.snapshot!.sessions.find(session => session.id === healthy.agentSessionId)!.control
  await expect(controller.attachSession(contents.id, { ...healthyControl, run: { runId: raw.runId } }, 0, config))
    .rejects.toThrow('Session control changed before its exact Run Attachment was established')
  await until(() => kernel.hasAttachment(healthy.run.runId), value => !value, 'wrong Run Attachment rollback')
  expect(input).not.toHaveBeenCalled()
  expect(start).not.toHaveBeenCalled()
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
  await attachOriginals('failed')
  expect(host.client.runtimeIdentity()).toEqual(nativeBefore)
  expect((await host.client.statusAgent(uncertain.agentSessionId)).run).toMatchObject({
    runId: uncertain.run.runId, pid: before.run.pid, state: 'running', acceptedInputBytes: before.run.acceptedInputBytes })
  expect((await store.readMetadata(uncertain.agentSessionId))!.terminalHandshake).toEqual(pending.terminalHandshake)
  await until(() => delivered, values => values.some(event => event.type === 'core' && event.event.type === 'connection-state' &&
    event.event.diagnostic?.code === 'CTXMUX_CONNECTION_OBSERVATION_FAILED'), 'ongoing original service window')
  expect(controller.endpointWarningSnapshot()).toContainEqual(expect.objectContaining({
    scope: 'observation', availability: 'connected', code: 'CTXMUX_CONNECTION_OBSERVATION_FAILED' }))
  console.info('PRIVATE_ORIGINAL_ATTACHMENTS=' + JSON.stringify({ nativeProcessId, nativeInstanceId: nativeBefore.instanceId,
    attachmentProofs, inputCalls: input.mock.calls.length, startCalls: start.mock.calls.length }))
}, 60_000)

it('cold actual Host/Main creates Terminal and Agent Runs during unrelated pending and failed recovery without replaying an unknown creation', async () => {
  const scope = await headlessFixture(); cleanup.push(scope.cleanup); await scope.stopOwner()
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
  for (const [key, value] of Object.entries(scope.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, value!)
  const store = new AgentMuxFileAgentSessionStore(scope.env.AGENTMUX_AGENT_SESSION_STORE!)
  const providers = [new AgentProviderRegistry().get('codex')]
  const cli = join(scope.root, 'creation-output.mjs')
  await writeFile(cli, `#!/usr/bin/env node
    import { readFileSync } from 'node:fs'
    let emitted = ''
    setInterval(() => {
      try { const value = readFileSync(process.env.PRIVATE_OUTPUT_FILE || process.argv[3], 'utf8')
        if (value !== emitted) { emitted = value; process.stdout.write('\\r\\n' + value + '\\r\\n') }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }, 10)
    if (process.argv[2] === 'private-raw') process.stdin.resume()
    else await import(${JSON.stringify(pathToFileURL(resolve('packages/core/test/fixtures/fake-codex-cli.mjs')).href)})
  `, { mode: 0o700 })
  const seed = await startAgentMuxHost({ store, providers, socketPath: defaultAgentMuxControlSocketPath() }); cleanup.push(seed.dispose)
  await seed.client.connect()
  const seedKernel = (seed.client as unknown as { kernel: { input: (...args: unknown[]) => Promise<unknown> } }).kernel
  const missed = vi.spyOn(seedKernel, 'input').mockRejectedValueOnce(new AgentMuxError(
    'Private original handshake was not dispatched.', 'CTXMUX_io', undefined, { disposition: 'not_applied', confirmedInputBytes: 0 }))
  const sibling = await seed.client.createAgent({ providerId: 'codex', executorId: 'codex', workspacePath: scope.root,
    agentSessionId: 'private-creation-sibling', createOperationId: 'private-creation-sibling-op', commandOverride: cli,
    args: [], env: { AGENTMUX_FAKE_READY_MODE: 'before', PRIVATE_OUTPUT_FILE: join(scope.root, 'sibling-output') }, injectAgentMuxGuide: false })
  missed.mockRestore()
  const original = (await store.readMetadata(sibling.agentSessionId))!
  expect(original.terminalHandshake?.acknowledged).toBe(false)
  const native = seed.client.runtimeIdentity(), nativePid = scope.nativeProcessId
  await seed.client.writeTerminal(sibling.run, { ownerInstanceId: native.instanceId, operationId: 'private-sibling-original-input',
    expectedByte: 0, data: 'Original authorized private input\r' })
  const siblingBefore = await seed.client.statusAgent(sibling.agentSessionId)
  await seed.dispose()
  const entered = deferred(), release = deferred(); cleanup.push(async () => { release.resolve() })
  const claim = store.claimStaleLifecycles.bind(store)
  vi.spyOn(store, 'claimStaleLifecycles').mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return await claim(...args) })
  const host = await startAgentMuxHost({ store, providers, socketPath: defaultAgentMuxControlSocketPath() }); cleanup.push(host.dispose)
  await entered.promise
  expect(host.client.agentSessions()).toEqual([])
  const kernel = (host.client as unknown as { kernel: { input: (...args: unknown[]) => Promise<unknown>; start: (...args: unknown[]) => Promise<unknown> } }).kernel
  const input = vi.spyOn(kernel, 'input'), start = vi.spyOn(kernel, 'start')
  const fullConnect = deferred(), connect = host.client.connect.bind(host.client)
  const observation = vi.spyOn(host.client, 'connect').mockImplementation(() => { fullConnect.resolve(); return connect() })
  const controller = new RuntimeController(store, connectDesktopAgentMuxHost); cleanup.push(() => controller.dispose())
  const config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), hosts: [{ id: 'local', kind: 'local', label: 'Private creation owner' }],
    workspaces: [{ id: 'private-create-workspace', hostId: 'local', kind: 'folder', name: 'Private', path: scope.root }] }
  controller.commit(await controller.prepare(config))
  const delivered: RuntimeEvent[] = []
  const contents = Object.assign(new EventEmitter(), { id: 74, isDestroyed: () => false,
    send: (_channel: string, event: RuntimeEvent) => delivered.push(event) }) as unknown as WebContents
  cleanup.push(controller.attach(contents))
  // The real receipt owner loses only the final delivery-metadata write. The
  // prepared seed/Run/unknown prompt remain genuine, rather than forged fields.
  const save = store.compareAndSwapMetadata.bind(store)
  const receiptFaults: string[] = []
  vi.spyOn(store, 'compareAndSwapMetadata').mockImplementation(async (...args) => {
    const next = args[1]
    if (next?.agentSessionId.startsWith('private-created-') && next.creation?.initialPrompt === 'confirmed') {
      receiptFaults.push(next.agentSessionId); throw new Error('Private final creation receipt acknowledgement unavailable')
    }
    return await save(...args)
  })
  const proofs: unknown[] = []
  for (const phase of ['pending', 'failed'] as const) {
    const agentFile = join(scope.root, phase + '-agent'), rawFile = join(scope.root, phase + '-raw')
    await writeFile(agentFile, `private-${phase}-agent-initial`); await writeFile(rawFile, `private-${phase}-raw-initial`)
    config.executors.codex = { ...config.executors.codex!, command: cli, args: [], injectAgentMuxGuide: false,
      env: { AGENTMUX_FAKE_READY_MODE: 'before', PRIVATE_OUTPUT_FILE: agentFile } }
    const request = { hostId: 'local', executorId: 'codex', workspacePath: scope.root,
      agentSessionId: `private-created-${phase}`, createOperationId: `private-created-operation-${phase}`, prompt: 'Original private task', cols: 80, rows: 24 }
    const creating = controller.launchAgent(request, config).then(value => ({ value }), error => ({ error }))
    const result = phase === 'pending' ? await Promise.race([creating, fullConnect.promise.then(() => ({ unrelatedRecovery: true }))]) : await creating
    if (!('value' in result)) { release.resolve(); await creating }
    if ('error' in result) throw result.error
    expect(result, 'new Main Agent must not wait for unrelated full recovery').toHaveProperty('value')
    if (!('value' in result)) throw new Error('Private Main Agent creation unavailable')
    const created = result.value.created
    expect(created).toMatchObject({ agentSessionId: request.agentSessionId, creation: { createOperationId: request.createOperationId } })
    expect((await store.readMetadata(created.agentSessionId))!.creation?.initialPrompt).toBe('unknown')
    expect(receiptFaults).toContain(created.agentSessionId)
    const raw = await controller.launchTerminal({ hostId: 'local', workspacePath: scope.root, createOperationId: `private-created-raw-${phase}`,
      shellCommand: `${process.execPath} ${JSON.stringify(cli)} private-raw ${JSON.stringify(rawFile)}`, cols: 80, rows: 24 }, config)
    const starts = start.mock.calls.length, inputs = input.mock.calls.length
    expect((await controller.launchAgent(request, config)).created).toMatchObject({ agentSessionId: created.agentSessionId, run: created.run,
      creation: { initialPrompt: 'unknown' } })
    expect(await controller.agentCreation('local', created.agentSessionId)).toMatchObject({ run: created.run, creation: { initialPrompt: 'unknown' } })
    await expect(controller.launchAgent({ ...request, prompt: 'Changed private task' }, config)).rejects.toMatchObject({ code: 'AGENT_FORK_OPERATION_CONFLICT' })
    expect(start).toHaveBeenCalledTimes(starts); expect(input).toHaveBeenCalledTimes(inputs)
    for (const target of [{ id: created.agentSessionId, run: created.run, file: agentFile, initial: `private-${phase}-agent-initial` },
      { id: raw.id, run: raw.control.run, file: rawFile, initial: `private-${phase}-raw-initial` }]) {
      const run = (await host.client.listRuns()).find(run => run.runId === target.run.runId)!
      expect(run.pid).toBeGreaterThan(1); expect(run.state).toBe('running')
      await until(() => host.client.readRunReplay(target.run), replay => replay.replay.map(chunk => chunk.data).join('').includes(target.initial), 'new private known output')
      const session = (await controller.snapshot(config)).sessions.find(session => session.id === target.id)!
      const attached = await controller.attachSession(contents.id, session.control, 0, config)
      try {
        const initial = attached.terminal.type === 'basic-vt' ? new TextDecoder().decode(attached.terminal.restoreBytes) : ''
        expect(initial + attached.replay.map(chunk => chunk.data).join('')).toContain(target.initial)
        const from = delivered.length, marker = `private-${phase}-${target.id}-later`
        await writeFile(target.file, marker)
        const output = await until(() => delivered.slice(from).flatMap(event => event.type === 'core' && event.event.type === 'terminal-output' &&
          event.event.run.runId === target.run.runId ? [event.event] : []), output => output.map(event => event.data).join('').includes(marker), 'new Main ordered output')
        let cursor = attached.session.latestOutputBytes
        for (const event of output) { expect(event.evidence.outputByteRange.startByte).toBe(cursor)
          expect(event.evidence.outputByteRange.endByte - cursor).toBe(event.dataBytes.length); cursor = event.evidence.outputByteRange.endByte }
        proofs.push({ phase, id: target.id, runId: run.runId, pid: run.pid, initialBytes: Buffer.byteLength(initial), liveBytes: cursor - attached.session.latestOutputBytes })
      } finally { await controller.detachSession(contents.id, attached.attachmentId) }
    }
    expect(host.client.runtimeIdentity()).toEqual(native); expect(scope.nativeProcessId).toBe(nativePid)
    if (phase === 'pending') {
      expect(observation).not.toHaveBeenCalled(); observation.mockRestore()
      await controller.rpcClients()[0]!.client.connect()
      const recovering = host.client.connect().then(() => null, error => error); release.resolve()
      expect(await recovering).toMatchObject({ code: 'CTXMUX_input_cursor_mismatch' })
    }
  }
  expect(start).toHaveBeenCalledTimes(4)
  expect(input.mock.calls.filter(call => call[0] === sibling.run.runId)).toHaveLength(1) // original failed recovery only
  expect((await host.client.statusAgent(sibling.agentSessionId)).run).toMatchObject({ runId: sibling.run.runId, pid: siblingBefore.run.pid,
    acceptedInputBytes: siblingBefore.run.acceptedInputBytes, state: 'running' })
  expect((await store.readMetadata(sibling.agentSessionId))!.terminalHandshake).toEqual(original.terminalHandshake)
  expect(controller.endpointWarningSnapshot()).toContainEqual(expect.objectContaining({ scope: 'observation', code: 'CTXMUX_CONNECTION_OBSERVATION_FAILED' }))
  console.info('PRIVATE_NEW_CREATIONS=' + JSON.stringify({ nativePid, nativeInstanceId: native.instanceId, proofs, receiptFaults,
    startCalls: start.mock.calls.length, siblingInputCalls: input.mock.calls.filter(call => call[0] === sibling.run.runId).length }))
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
