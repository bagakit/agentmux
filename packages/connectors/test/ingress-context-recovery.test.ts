import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { DurableIngressHost } from '../src/durable-ingress.js'
import { ConnectionHost } from '../src/connection-host.js'
import { channelContextFixture } from './fixtures/channel-context.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { preparedFixtureRun as defineRun } from '../../core/test/helpers/prepared-fixture-run.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

it('compiled managed context cancellation freezes the confirmed native prefix and only that original body continues', async () => {
  const f = await channelContextFixture(cleanup)
  await f.receive('baseline', 1000, 'Original unmentioned baseline', false)
  for (let i = 0; i < 60; i++) f.addNative('peer-' + i, 2000 + i, 'Confirmed native peer ' + i)
  let heldSignal: AbortSignal | undefined, release!: () => void, pages = 0
  f.transport.override(input => {
    if (input.params?.container_id_type !== 'chat') return
    pages++
    if (pages === 2) {
      heldSignal = (input as { signal?: AbortSignal }).signal
      return new Promise(resolve => { release = () => resolve({ code: 0, data: { items: [], has_more: true, page_token: 'late-never-owned' } }) })
    }
  })
  const received = await f.receive('cancel-current', 3000, 'Original healthy current request')
  await vi.waitFor(() => expect(heldSignal).toBeDefined())
  const inspect = await f.inspect(received.ingressId)
  expect(inspect).toMatchObject({ ingress: { state: 'received', body: 'Original healthy current request' }, preparation: { phase: 'history' }, rejoinSource: { kind: 'context-observation' } })
  const request = { ingressId: received.ingressId, operationId: 'cancel-original-observer', source: inspect.rejoinSource! }
  const environment = objectCliEnvironment(f.root, { AGENTMUX_AGENT_SESSION_ID: f.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: f.credentials.capability })
  const call = () => runCompiledObjectCli(['--endpoint', 'unix:' + f.desktopPath, 'connection', 'ingress', 'rejoin', '--input', '-'], environment, JSON.stringify(request))
  const cli = await call()
  expect(cli.code, cli.stdout + cli.stderr).toBe(0)
  const result = JSON.parse(cli.stdout).result
  expect(result.action).toMatchObject({ ...request, outcome: 'context-ended' })
  const row = f.services.database!.prepare('SELECT rejoin_json FROM connection_ingress_message WHERE ingress_id=?').get(received.ingressId)!
  expect(JSON.parse(String(row.rejoin_json))[request.operationId].actor).toEqual({ kind: 'agent', id: f.credentials.agentSessionId })
  expect(heldSignal!.aborted).toBe(true)
  const settled = await f.wait(received.ingressId, 'admitted')
  const ref = settled.ingress!.input!
  if (!('messageId' in ref)) throw Error('The original native body input was not retained')
  expect(ref.channelQuote).toMatchObject({ coverage: 'partial', gaps: expect.arrayContaining([{ reason: 'context-observation-cancelled' }]) })
  expect(ref.channelQuote!.records.length).toBeGreaterThan(0)
  expect(ref.channelQuote!.records.every(row => row.messageId.startsWith('peer-'))).toBe(true)
  expect(settled.context?.positionMessageId).toBeNull()
  const saved = await f.client.readMessage({ messageId: ref.messageId })
  expect(saved!.envelope.body).toBe('Original healthy current request')
  const frozen = JSON.stringify(saved!.envelope), wire = f.nativeSend.mock.calls[0]![0]
  expect(JSON.parse((await call()).stdout).result.action).toEqual(result.action)
  const other = await f.rpc.call('connection.ingress.rejoin', { ...request, operationId: 'other-action-on-consumed-source' }, { credentials: f.credentials })
  expect(other.action.outcome).toBe('stale')
  release(); await new Promise(resolve => setTimeout(resolve, 100))
  expect(pages).toBe(2); expect(f.nativeSend).toHaveBeenCalledOnce()
  expect(f.nativeSend.mock.calls[0]![0]).toBe(wire)
  expect(JSON.stringify((await f.client.readMessage({ messageId: ref.messageId }))!.envelope)).toBe(frozen)
  await f.reopen()
  expect(JSON.parse((await call()).stdout).result.action).toEqual(result.action)
  expect(f.nativeSend).toHaveBeenCalledOnce(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30000)

it('an old observer source cannot cancel O2 after owner reopen, even under a new action ID', async () => {
  const f = await channelContextFixture(cleanup)
  await f.receive('baseline', 1000, 'Retained baseline', false)
  const held: Array<{ signal: AbortSignal; release(): void }> = []
  f.transport.override(input => {
    if (input.params?.container_id_type !== 'chat') return
    return new Promise(resolve => { held.push({ signal: (input as { signal: AbortSignal }).signal,
      release: () => resolve({ code: 0, data: { items: f.nativeRows, has_more: false } }) }) })
  })
  const received = await f.receive('same-current', 2000, 'Same original current body')
  await vi.waitFor(() => expect(held).toHaveLength(1))
  const first = await f.inspect(received.ingressId)
  const oldAction = { ingressId: received.ingressId, operationId: 'old-observer-action', source: first.rejoinSource! }
  expect(oldAction.source.kind).toBe('context-observation')
  // The real action journal accepts O1; lose this call before the separate source-consumption CAS.
  const fault = vi.spyOn(f.services.ingress as unknown as { endContextObservation(...args: unknown[]): unknown }, 'endContextObservation')
    .mockImplementationOnce(() => { throw Error('Private fault after original action acceptance, before source consumption') })
  await expect(f.rpc.call('connection.ingress.rejoin', oldAction, { credentials: f.credentials })).rejects.toBeDefined()
  expect(fault).toHaveBeenCalledOnce(); fault.mockRestore()
  const pending = f.services.database!.prepare('SELECT rejoin_json FROM connection_ingress_message WHERE ingress_id=?').get(received.ingressId)!
  expect(JSON.parse(String(pending.rejoin_json))[oldAction.operationId].action).toEqual({ ...oldAction, outcome: 'pending' })
  expect(held[0]!.signal.aborted).toBe(false)
  await f.reopen()
  await vi.waitFor(() => expect(held).toHaveLength(2))
  const second = await f.inspect(received.ingressId)
  expect(second.rejoinSource).toMatchObject({ kind: 'context-observation' })
  expect(second.preparation!.revision).toBe(first.preparation!.revision + 1)
  expect(second.rejoinSource).not.toEqual(first.rejoinSource)
  const old = await f.rpc.call('connection.ingress.rejoin', oldAction, { credentials: f.credentials })
  expect(old.action.outcome).toBe('stale')
  expect((await f.rpc.call('connection.ingress.rejoin', oldAction, { credentials: f.credentials })).action).toEqual(old.action)
  expect((await f.rpc.call('connection.ingress.rejoin', { ...oldAction, operationId: 'other-old-id' }, { credentials: f.credentials })).action.outcome).toBe('stale')
  expect(held[1]!.signal.aborted).toBe(false); expect(f.nativeSend).not.toHaveBeenCalled()
  held[0]!.release(); await new Promise(resolve => setTimeout(resolve, 100))
  expect((await f.inspect(received.ingressId)).rejoinSource).toEqual(second.rejoinSource)
  expect(held[1]!.signal.aborted).toBe(false)
  const current = await f.rpc.call('connection.ingress.rejoin', { ...oldAction, operationId: 'current-observer-action', source: second.rejoinSource! }, { credentials: f.credentials })
  expect(current.action.outcome).toBe('context-ended')
  expect(held[1]!.signal.aborted).toBe(true)
  const settled = await f.wait(received.ingressId, 'admitted')
  expect(settled.context?.positionMessageId).toBeNull()
  held[1]!.release()
  expect(f.nativeSend).toHaveBeenCalledOnce()
}, 30000)

it('one unavailable Core position read releases its borrowed RPC signal and preserves healthy same-Session input', async () => {
  const f = await channelContextFixture(cleanup)
  await f.receive('baseline', 1000, 'Retained baseline', false)
  f.outcome('unknown')
  const first = await f.receive('unknown-first', 2000, 'Original native outcome remains unknown'), unknown = await f.wait(first.ingressId, 'unknown')
  const operation = unknown.ingress!.input!.operationId, forward = f.hosted.forwardRpc!.bind(f.hosted)
  let release!: () => void, held = false
  vi.spyOn(f.hosted, 'forwardRpc').mockImplementation(async (method, params, context = {}, fence) => {
    const result = forward(method, params, context, fence)
    const invocation = method === 'runtime.invoke' ? (params as { invocation: { method: string; args: Array<{ originalControlOperationId?: string }> } }).invocation : undefined
    if (!held && context.signal && invocation?.method === 'inspectAgentInput' && invocation.args[0]?.originalControlOperationId === operation) {
      held = true
      const observed = await result
      await new Promise<void>(resolve => { release = resolve }) // exact readonly response consumer ignores abort
      return observed
    }
    return await result
  })
  const windows: AbortController[] = []
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => { const controller = new AbortController(); windows.push(controller); return controller.signal })
  f.outcome('admitted')
  const waiting = await f.receive('position-waiting', 3000, 'Original body waiting only for its optional position read')
  await vi.waitFor(() => expect(release).toBeDefined())
  expect((await f.inspect(waiting.ingressId)).preparation?.phase).toBe('position')
  const borrowed = f.forwarded.findLast(call => call.method === 'runtime.invoke' && call.signal &&
    (call.params as { invocation: { method: string } }).invocation.method === 'inspectAgentInput')!
  expect(borrowed).toBeDefined(); expect(borrowed.signal!.aborted).toBe(false)
  const actual = (borrowed.params as { invocation: { args: unknown[] } }).invocation.args
  expect(actual).toHaveLength(1) // no signal or observation token in Core's caller/body wire slots
  const healthy = await f.receive('healthy-independent', 4000, 'Healthy independent same-Session request')
  await f.wait(healthy.ingressId, 'admitted')
  expect((await f.inspect(waiting.ingressId)).ingress?.state).toBe('received')
  windows[0]!.abort(new DOMException('Accelerated exact read observation window', 'TimeoutError'))
  const settled = await f.wait(waiting.ingressId, 'admitted')
  expect(borrowed.signal!.aborted).toBe(true)
  const input = settled.ingress!.input!
  if (!('messageId' in input)) throw Error('Original body input is unavailable')
  expect(input.channelQuote).toMatchObject({ coverage: 'partial', gaps: expect.arrayContaining([{ reason: 'context-position-unavailable' }]) })
  expect(input.channelQuote!.range.origin).toBe('first-observed')
  const before = JSON.stringify((await f.client.readMessage({ messageId: input.messageId }))!.envelope)
  release(); await new Promise(resolve => setTimeout(resolve, 100))
  expect(JSON.stringify((await f.client.readMessage({ messageId: input.messageId }))!.envelope)).toBe(before)
  expect(f.nativeSend).toHaveBeenCalledTimes(3); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30000)

it('one uncooperative quote credential read releases its original body without blocking another healthy input', async () => {
  const f = await channelContextFixture(cleanup)
  await f.receive('baseline', 1000, 'Retained baseline', false)
  const resolve = ConnectionHost.prototype.resolveCredential
  let release!: () => void, first = true
  vi.spyOn(ConnectionHost.prototype, 'resolveCredential').mockImplementation(async function (id) {
    if (first) { first = false; await new Promise<void>(resolve => { release = resolve }) }
    return await resolve.call(this, id)
  })
  const windows: AbortController[] = []
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => { const controller = new AbortController(); windows.push(controller); return controller.signal })
  const waiting = await f.receive('credential-current', 2000, 'Original body with unavailable optional credential')
  await vi.waitFor(() => expect(release).toBeDefined())
  expect((await f.inspect(waiting.ingressId)).preparation?.phase).toBe('credential')
  const healthy = await f.receive('healthy-after-credential', 3000, 'Independent healthy original request')
  await f.wait(healthy.ingressId, 'admitted')
  expect((await f.inspect(waiting.ingressId)).ingress!.state).toBe('received')
  windows[0]!.abort(new DOMException('Accelerated exact credential window', 'TimeoutError'))
  const result = await f.wait(waiting.ingressId, 'admitted'), input = result.ingress!.input!
  if (!('messageId' in input)) throw Error('Original body input is unavailable')
  expect(input.channelQuote).toMatchObject({ coverage: 'unavailable', gaps: [{ reason: 'native-history-credential-unavailable' }], records: [] })
  expect((await f.client.readMessage({ messageId: input.messageId }))!.envelope.body).toBe(waiting.body)
  const before = JSON.stringify(input.channelQuote), count = f.transport.requests.length
  release(); await new Promise(resolve => setTimeout(resolve, 100))
  expect(f.transport.requests).toHaveLength(count)
  expect(JSON.stringify((await f.inspect(waiting.ingressId)).ingress!.input!.channelQuote)).toBe(before)
  expect(f.nativeSend).toHaveBeenCalledTimes(2); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30000)

it('a closed original ingress cannot claim after its last strong target read returns behind O2', async () => {
  const f = await channelContextFixture(cleanup)
  await f.receive('baseline', 1000, 'Original baseline', false)
  const owner = f.services.ingress!, options = Reflect.get(owner, 'options') as ConstructorParameters<typeof DurableIngressHost>[0]
  const original = f.client.readAgentSession.bind(f.client)
  let release!: () => void, held = false
  vi.spyOn(f.client, 'readAgentSession').mockImplementation(async id => {
    const result = await original(id)
    if (!held && id === 'original-agent') {
      const rows = await owner.list({ connectionId: f.config.connectionId })
      const record = rows.ingresses.find(row => row.externalMessageId === 'generation-current')
      if (record && (await owner.inspect({ ingressId: record.ingressId })).preparation?.phase === 'ended') {
        held = true; await new Promise<void>(resolve => { release = resolve })
      }
    }
    return result
  })
  const received = await f.receive('generation-current', 2000, 'Original body awaiting its final strong target read')
  await vi.waitFor(() => expect(release).toBeDefined())
  const O1 = await f.inspect(received.ingressId), oldWork = owner.dispatch(received.ingressId).catch(error => error)
  expect(O1.ingress!.state).toBe('received')
  const receivedAction = { ingressId: received.ingressId, operationId: 'received-action-on-original-preparation', source: O1.rejoinSource! }
  const originalAction = owner.rejoin(receivedAction, { actor: { kind: 'user', id: 'original-user' } }).catch(error => error)
  await vi.waitFor(() => {
    const row = f.services.database!.prepare('SELECT rejoin_json FROM connection_ingress_message WHERE ingress_id=?').get(received.ingressId)!
    expect(JSON.parse(String(row.rejoin_json))[receivedAction.operationId]?.preparationRevision).toBe(O1.preparation!.revision)
  })
  owner.close() // Close only the original ingress owner; its retained database stays with ConnectionHost.
  const replacement = new DurableIngressHost(options); cleanup.push(() => replacement.close())
  let O2Signal: AbortSignal | undefined, releaseNative!: () => void
  f.transport.override(input => {
    if (input.params?.container_id_type !== 'chat') return
    O2Signal = (input as { signal: AbortSignal }).signal
    return new Promise(resolve => { releaseNative = () => resolve({ code: 0, data: { items: f.nativeRows, has_more: false } }) })
  })
  const currentWork = replacement.dispatch(received.ingressId)
  await vi.waitFor(() => expect(O2Signal).toBeDefined())
  const O2 = await f.inspect(received.ingressId)
  expect(O2.preparation!.observationId).not.toBe(O1.preparation!.observationId)
  release(); await oldWork; await originalAction
  const retainedAction = await replacement.rejoin(receivedAction, { actor: { kind: 'user', id: 'original-user' } })
  expect(retainedAction.action.outcome).toBe('pending')
  expect(retainedAction.inspection.rejoinSource).toEqual(O2.rejoinSource)
  const protectedRecord = await f.inspect(received.ingressId)
  expect(protectedRecord.ingress!.state).toBe('received')
  expect(protectedRecord.rejoinSource).toEqual(O2.rejoinSource)
  expect(O2Signal!.aborted).toBe(false); expect(f.nativeSend).not.toHaveBeenCalled()
  const result = await replacement.rejoin({ ingressId: received.ingressId, operationId: 'end-exact-replacement-observer', source: O2.rejoinSource! }, { actor: { kind: 'user', id: 'original-user' } })
  expect(result.action.outcome).toBe('context-ended')
  await currentWork; await f.wait(received.ingressId, 'admitted'); releaseNative()
  expect(f.nativeSend).toHaveBeenCalledOnce()
}, 30000)

it('context cancellation keeps current original grant authorization separate from its readable source', async () => {
  const f = await channelContextFixture(cleanup)
  await f.receive('baseline', 1000, 'Original baseline', false)
  let nativeSignal: AbortSignal | undefined, release!: () => void
  f.transport.override(input => {
    if (input.params?.container_id_type !== 'chat') return
    nativeSignal = (input as { signal: AbortSignal }).signal
    return new Promise(resolve => { release = () => resolve({ code: 0, data: { items: f.nativeRows, has_more: false } }) })
  })
  const received = await f.receive('revoked-context-current', 2000, 'Retained body after grant revocation')
  await vi.waitFor(() => expect(nativeSignal).toBeDefined())
  const observation = await f.inspect(received.ingressId), request = { ingressId: received.ingressId, operationId: 'revoked-context-cancel', source: observation.rejoinSource! }
  await f.rpc.call('connection.grant', { operationId: 'revoke-exact-context-member', bindingId: f.binding.bindingId, expectedBindingRevision: 1,
    grantId: 'context-member', expectedRevision: 1, actor: f.actor, capabilities: ['input'], state: 'revoked' })
  expect((await f.rpc.call('connection.ingress.inspect', { ingressId: received.ingressId }, { credentials: f.credentials })).rejoinSource).toEqual(request.source)
  await expect(f.rpc.call('connection.ingress.rejoin', request, { credentials: f.credentials })).rejects.toMatchObject({ code: 'INGRESS_ACTOR_NOT_AUTHORIZED' })
  expect(nativeSignal!.aborted).toBe(false)
  expect((await f.inspect(received.ingressId)).ingress).toMatchObject({ body: received.body, state: 'received' })
  expect(f.nativeSend).not.toHaveBeenCalled()
  release(); await new Promise(resolve => setTimeout(resolve, 100))
  expect((await f.inspect(received.ingressId)).ingress!.input).toBeUndefined()
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30000)

it('ending an exact old observation never accepts its original body into a changed native source', async () => {
  const f = await channelContextFixture(cleanup)
  await f.receive('baseline', 1000, 'Original baseline', false)
  let nativeSignal: AbortSignal | undefined, release!: () => void
  f.transport.override(input => {
    if (input.params?.container_id_type !== 'chat') return
    nativeSignal = (input as { signal: AbortSignal }).signal
    return new Promise(resolve => { release = () => resolve({ code: 0, data: { items: f.nativeRows, has_more: false } }) })
  })
  const received = await f.receive('source-change-current', 2000, 'Retain this original source request')
  await vi.waitFor(() => expect(nativeSignal).toBeDefined())
  const observation = await f.inspect(received.ingressId), request = { ingressId: received.ingressId, operationId: 'old-source-observation-end', source: observation.rejoinSource! }
  const metadata = (await f.store.readMetadata('original-agent'))!
  if (metadata.nativeHandle?.kind !== 'provider') throw Error('Original protocol source unavailable')
  await f.store.compareAndSwapMetadata(metadata, { ...metadata, nativeHandle: { ...metadata.nativeHandle, sessionId: 'different-native-source' } })
  await f.inner.registry.load('local')
  const result = await f.rpc.call('connection.ingress.rejoin', request, { credentials: f.credentials })
  expect(result.action).toEqual({ ...request, outcome: 'context-ended' })
  const retained = await vi.waitFor(async () => { const value = await f.inspect(received.ingressId); expect(value.ingress?.input?.admissionIntent).toMatchObject({ kind: 'native-conversation', source: f.source }); return value })
  expect(retained.ingress).toMatchObject({ body: received.body, input: { admissionIntent: { kind: 'native-conversation', source: f.source } } })
  expect(result.inspection.preparation?.source).toEqual(f.source)
  expect(nativeSignal!.aborted).toBe(true)
  expect((await f.rpc.call('connection.ingress.rejoin', request, { credentials: f.credentials })).action).toEqual(result.action)
  release(); await new Promise(resolve => setTimeout(resolve, 100))
  expect(f.nativeSend).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30000)

it('a durable local context result returns while strong target and later Core inspection are hung, then the same body finishes once', async () => {
  const f = await channelContextFixture(cleanup)
  await f.receive('baseline', 1000, 'Original baseline', false)
  let ingressId: string | undefined, releaseTarget!: () => void, releaseInspect!: () => void, releaseNative!: () => void
  let targetHeld = false, inspectGate: Promise<void> | undefined
  cleanup.push(() => { releaseTarget?.(); releaseInspect?.(); releaseNative?.() })
  const target = f.client.readAgentSession.bind(f.client)
  vi.spyOn(f.client, 'readAgentSession').mockImplementation(async id => {
    const value = await target(id)
    if (!targetHeld && ingressId && id === 'original-agent') {
      const local = await f.services.ingress!.inspect({ ingressId })
      if (local.ingress?.state === 'received' && local.preparation?.phase === 'ended') {
        targetHeld = true; await new Promise<void>(resolve => { releaseTarget = resolve })
      }
    }
    return value
  })
  const inspect = f.hosted.inspectAgentInput.bind(f.hosted)
  vi.spyOn(f.hosted, 'inspectAgentInput').mockImplementation(async input => {
    const result = await inspect(input)
    if (ingressId && result) await (inspectGate ??= new Promise<void>(resolve => { releaseInspect = resolve }))
    return result
  })
  f.transport.override(input => input.params?.container_id_type === 'chat'
    ? new Promise(resolve => { releaseNative = () => resolve({ code: 0, data: { items: f.nativeRows, has_more: false } }) }) : undefined)
  const received = await f.receive('strong-step-current', 2000, 'Original body continues after its separate strong steps')
  ingressId = received.ingressId
  await vi.waitFor(() => expect(releaseNative).toBeDefined())
  const observation = await f.inspect(ingressId), request = { ingressId, operationId: 'local-result-before-strong-body', source: observation.rejoinSource! }
  const env = objectCliEnvironment(f.root, { AGENTMUX_AGENT_SESSION_ID: f.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: f.credentials.capability })
  const call = () => runCompiledObjectCli(['--endpoint', 'unix:' + f.desktopPath, 'connection', 'ingress', 'rejoin', '--input', '-'], env, JSON.stringify(request))
  let first: Awaited<ReturnType<typeof call>> | undefined
  const firstCall = call().then(result => { first = result })
  await vi.waitFor(() => expect(releaseTarget).toBeDefined())
  await vi.waitFor(() => expect(first?.code, first?.stdout + String(first?.stderr)).toBe(0), { timeout: 3000 })
  const local = JSON.parse(first!.stdout).result
  expect(local).toMatchObject({ action: { ...request, outcome: 'context-ended' }, inspection: { ingress: { state: 'received', body: received.body }, inputReceipt: null, observation: 'not-started' } })
  expect(f.nativeSend).not.toHaveBeenCalled()
  releaseTarget()
  await vi.waitFor(() => expect(releaseInspect).toBeDefined())
  await vi.waitFor(() => expect(f.nativeSend).toHaveBeenCalledOnce())
  let repeated: Awaited<ReturnType<typeof call>> | undefined
  const repeatedCall = call().then(result => { repeated = result })
  await vi.waitFor(() => expect(repeated?.code, repeated?.stdout + String(repeated?.stderr)).toBe(0), { timeout: 3000 })
  const pendingCore = JSON.parse(repeated!.stdout).result
  expect(pendingCore).toMatchObject({ action: local.action, inspection: { ingress: { state: 'claimed', body: received.body }, inputReceipt: null, observation: 'unavailable' } })
  const frozen = pendingCore.inspection.ingress.input
  releaseInspect(); await firstCall; await repeatedCall
  const settled = await f.wait(ingressId, 'admitted')
  expect(settled.ingress!.input).toEqual(frozen)
  expect(settled.inputReceipt!.originalControlOperationId).toBe(frozen.operationId)
  releaseNative(); await new Promise(resolve => setTimeout(resolve, 100))
  expect(f.nativeSend).toHaveBeenCalledOnce(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30000)

/** End the original Run and let Core's own Level B continuity relaunch the same Session on `newRunId`. */
function resumeOnNewRun(f: Awaited<ReturnType<typeof channelContextFixture>>, endedRunId: string, newRunId: string) {
  const core = f.inner as any, provider = f.client.providers.get('claude'), starts: any[] = []
  f.client.providers.replace({ ...provider, prepareManagedLaunch: async (plan: any) => ({ plan }) })
  const recovered = () => ({ ...f.run(newRunId), program: starts[0]?.program ?? 'claude', args: starts[0]?.args ?? [], lifecycleOperationId: starts[0]?.operationKey ?? null })
  core.kernel.launchIdentity = ({ program, args }: any) => ({ program, argsDigest: createHash('sha256').update(JSON.stringify(args)).digest('base64url') })
  core.kernel.status = vi.fn(async (runId: string) => runId === endedRunId ? { ...f.run(runId), state: { type: 'exited', code: 0, signal: null } } : { ...recovered(), pid: 1234 })
  core.kernel.list = vi.fn(async () => starts.length ? [recovered()] : [])
  core.kernel.inspectCreation = vi.fn(async (operationId: string) => starts[0]?.operationKey === operationId ? recovered() : null)
  core.kernel.start = vi.fn(async (request: any) => { starts.push(request); return recovered() })
  core.kernel.creationRuntimeIdentity = () => ({ runtimeId: 'original-fixture-runtime', instanceId: 'fixture-instance', buildIdentity: 'fixture', protocolVersion: 1 })
  core.kernel.prepareStart = (input: any) => defineRun(input.program, { args: input.args, cwd: input.cwd, env: input.env, initialSize: { cols: input.cols ?? 80, rows: input.rows ?? 24 } })
  core.kernel.startPrepared = vi.fn(async (request: any, operationKey: string) => core.kernel.start({ program: request.program, args: request.args, cwd: request.cwd, env: request.env, operationKey }))
  core.kernel.inspectPreparedStart = vi.fn(async (_request: any, operationKey: string) => await core.kernel.inspectCreation(operationKey))
  core.probePreparedAgent = vi.fn(async () => ({ providerId: 'claude', executable: 'claude', installed: true, capabilities: provider.catalog.capabilities }))
  core.ensureTerminalHandshakeOrDegrade = async (session: any) => session
  core.hookServer.isRunning = () => true
  core.hookServer.createBinding = (_session: string, _provider: string, bindingId: string) => ({ bindingId, endpoint: { url: 'http://127.0.0.1:0', token: 'token'.padEnd(43, 'T') }, bindRun: async () => {}, close: async () => {} })
  vi.spyOn(core.screenEvidence, 'wait').mockResolvedValue(1)
  return starts
}

it('a quote frozen by context cancellation still delivers once to the Agent resumed by Level B on a new Run', async () => {
  const f = await channelContextFixture(cleanup)
  await f.receive('baseline', 1000, 'Original baseline', false)
  let nativeSignal: AbortSignal | undefined, release!: () => void
  f.transport.override(input => {
    if (input.params?.container_id_type !== 'chat') return
    nativeSignal = (input as { signal: AbortSignal }).signal
    return new Promise(resolve => { release = () => resolve({ code: 0, data: { items: f.nativeRows, has_more: false } }) })
  })
  cleanup.push(() => release?.())
  const received = await f.receive('recovered-run-current', 2000, 'Deliver this original request after recovery')
  await vi.waitFor(() => expect(nativeSignal).toBeDefined())
  const observation = await f.inspect(received.ingressId), request = { ingressId: received.ingressId, operationId: 'end-before-recovery', source: observation.rejoinSource! }
  const before = (await f.store.readMetadata('original-agent'))!
  // While the observation is held, the original Run ends and Core's Level B continuity resumes the same Session on a new Run.
  // Only then is the observation ended.
  const starts = resumeOnNewRun(f, before.run.runId, 'recovered-original-run')
  const resumed = await f.client.ensureAgentContinuity({ agentSessionId: before.agentSessionId, expectedRun: before.run, operationId: 'level-b-resume', trigger: 'manual' })
  expect(resumed, JSON.stringify(resumed)).toMatchObject({ kind: 'resumed', session: { agentSessionId: before.agentSessionId, hostId: before.hostId, run: { runId: 'recovered-original-run' }, nativeHandle: before.nativeHandle } })
  expect(starts).toHaveLength(1)
  expect((await f.store.readMetadata(before.agentSessionId))?.nativeBinding).toMatchObject({ run: { runId: 'recovered-original-run' } })
  // Level B issued the resumed process its own invocation capability; that same Agent ends the held observation.
  const credentials = { agentSessionId: before.agentSessionId, capability: starts[0].env.AGENTMUX_AGENT_CAPABILITY as string }
  expect(credentials.capability).toEqual(expect.any(String)); expect(credentials.capability).not.toBe(f.credentials.capability)
  const result = await f.rpc.call('connection.ingress.rejoin', request, { credentials })
  expect(result.action).toEqual({ ...request, outcome: 'context-ended' })
  expect(nativeSignal!.aborted).toBe(true)
  let refused: string | undefined
  const settled = await vi.waitFor(async () => {
    const value = await f.inspect(received.ingressId)
    // The receiver's own recovery dispatch is the product path; repeat it here instead of waiting for the 5s scan.
    if (value.ingress?.state !== 'claimed') await f.services.ingress!.dispatch(received.ingressId).catch(error => { refused = error?.code ?? String(error) })
    expect(value.ingress?.state, JSON.stringify({ refused, code: (value.ingress as { code?: string } | null)?.code, phase: value.preparation?.phase })).toBe('claimed'); return value
  }, { timeout: 10000 })
  const ref = settled.ingress!.input!
  expect(ref.expectedRun.runId).toBe('recovered-original-run'); expect(ref.expectedRun.runId).not.toBe(before.run.runId)
  expect(ref.channelQuote).toMatchObject({ gaps: expect.arrayContaining([{ reason: 'context-observation-cancelled' }]) })
  expect(settled.ingress!.body).toBe('Deliver this original request after recovery')
  // Core saved this original input once, keyed by its frozen message identity, for the recovered Run.
  await vi.waitFor(async () => {
    const value = await f.inspect(received.ingressId)
    expect(value.inputReceipt?.key, JSON.stringify(value.inputReceipt ?? value.observation)).toMatchObject({ kind: 'message', expectedRun: { runId: 'recovered-original-run' }, messageId: ref.messageId })
  }, { timeout: 10000 })
  expect((await f.rpc.call('connection.ingress.rejoin', request, { credentials })).action).toEqual(result.action)
  release(); await new Promise(resolve => setTimeout(resolve, 100))
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30000)

it('a stated Core refusal of the claimed original input reaches the real receiver as a check-failed service window', async () => {
  const f = await channelContextFixture(cleanup)
  await f.receive('baseline', 1000, 'Original baseline', false)
  const { AgentMuxError } = await import('@agentmux/core')
  const submit = vi.spyOn(f.client, 'submitAgentMessage').mockRejectedValue(new AgentMuxError('Refused before original Core save', 'STALE_AGENT_SESSION'))
  const received = await f.receive('refused-current', 2000, 'Original request Core refuses')
  await vi.waitFor(async () => expect((await f.inspect(received.ingressId)).ingress?.state).toBe('claimed'), { timeout: 10000 })
  await vi.waitFor(async () => expect((await f.rpc.call('connection.inspect', { connectionId: f.config.connectionId })).connection!.observation.intake)
    .toEqual({ state: 'unknown', reason: 'check-failed' }), { timeout: 10000 })
  expect(submit).toHaveBeenCalledOnce()
  expect(await f.inspect(received.ingressId)).toMatchObject({ ingress: { state: 'claimed', body: 'Original request Core refuses' }, inputReceipt: null, observation: 'observed' })
  expect(f.nativeSend).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30000)
