import { afterEach, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { readFile, rm, writeFile } from 'node:fs/promises'
import * as core from '../../core/dist/index.js'
import { DurableAgentMuxMessageQueue } from '../../core/dist/agent-global-message-queue.js'
import { DurableIngressHost } from '../dist/index.js'
import { ingressFixture } from './fixtures/ingress.js'
import { context } from './fixtures/room-binding.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { headlessFixture, until } from '../../core/test/helpers/headless-runtime-fixture.js'
import { hostedTestOwner } from '../../core/test/helpers/hosted-runtime-port.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(running = false) {
  const f = await ingressFixture(running); cleanup.push(f.close)
  return f
}
async function beforeFirstsave(f: Awaited<ReturnType<typeof fixture>>) {
  const received = await f.receive()
  let original!: Parameters<typeof f.client.submitAgentMessage>
  const submit = vi.spyOn(f.client, 'submitAgentMessage').mockImplementationOnce(async (...args) => { original = args; throw Error('Before Core firstsave') })
  const inspection = await f.ingress.dispatch(received.ingress.ingressId)
  expect(inspection.inputReceipt).toBeNull(); expect(inspection.rejoinSource?.kind).toBe('firstsave')
  expect(submit).toHaveBeenCalledOnce()
  submit.mockRestore()
  return { received, inspection, original, request: { ingressId: received.ingress.ingressId, operationId: 'original-recovery-action', source: inspection.rejoinSource! } }
}

it('ensures the exact frozen request after the firstsave gap and coalesces a delayed writer', async () => {
  const f = await fixture(true), first = await beforeFirstsave(f), restored = new DurableIngressHost(f.options)
  const [action] = await Promise.all([restored.rejoin(first.request, context), f.client.submitAgentMessage(...first.original)])
  expect(action.action).toMatchObject({ ...first.request, outcome: 'handed-off' })
  expect(action.inspection.ingress!.input).toEqual(first.inspection.ingress!.input)
  expect(action.inspection.inputReceipt!.originalControlOperationId).toBe(first.original[0].envelope.operationId)
  const message = await f.client.readMessage({ operationId: first.original[0].envelope.operationId })
  expect(message!.envelope.body).toBe(first.received.ingress.body)
  expect(message!.envelope.createdAt).toBe(first.inspection.ingress!.input!.createdAt)
  const rows = await f.client.readAgentInputMailbox({ agentSessionId: f.session.agentSessionId })
  expect(rows.items).toHaveLength(1)
  const repeated = await new DurableIngressHost(f.options).rejoin(first.request, context)
  expect(repeated.action).toEqual(action.action)
  await expect(restored.rejoin({ ...first.request, source: { ...first.request.source, messageId: 'foreign-message' } as typeof first.request.source }, context))
    .rejects.toMatchObject({ code: 'INGRESS_REJOIN_CONFLICT' })
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('reads saved custody despite a changed current Run and unavailable external author without retrying or broadening scope', async () => {
  const f = await fixture(), first = await beforeFirstsave(f)
  const saved = await f.client.submitAgentMessage(...first.original)
  expect(saved).toHaveProperty('persistence', 'confirmed')
  const prior = (await f.store.readMetadata(f.session.agentSessionId))!
  await f.store.compareAndSwapMetadata(prior, { ...prior, run: { runId: 'unrelated-new-run' } })
  const authority = vi.fn(async () => { throw Error('Original hosting authority offline') })
  const read = await f.client.submitAgentMessage(first.original[0], { externalAuthor: { identity: first.original[0].envelope.sender as core.AgentExternalMessageAuthor, assertCurrent: authority } })
  expect(read).toMatchObject({ persistence: 'confirmed', ref: (saved as core.AgentInputSubmissionReceipt).ref })
  await vi.waitFor(() => expect(authority).toHaveBeenCalled())
  await expect(f.client.submitAgentMessage({ ...first.original[0], caller: { agentSessionId: 'foreign', capability: f.capability } }))
    .rejects.toMatchObject({ code: 'MESSAGE_SENDER_MISMATCH' })
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('does not route a retained message without an input intent through legacy direct dispatch', async () => {
  const f = await fixture(true), first = await beforeFirstsave(f)
  const input = first.original[0]
  await new DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath()).append({ ...input.envelope, admissionIntent: input.admissionIntent!, execution: 'immediate', sourceChannel: 'agent-message' })
  await expect(f.client.submitAgentMessage(...first.original)).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
  expect((await f.ingress.inspect({ ingressId: first.request.ingressId })).inputReceipt).toBeNull()
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('wake-only preserves a later not-applied result and leaves a deliberate retry with the Core owner', async () => {
  const f = await fixture(true), first = await beforeFirstsave(f)
  f.inner.kernel.input.mockRejectedValue(new core.AgentMuxError('Accurate whole-input refusal', 'CTXMUX_input_cursor_mismatch', 'not_applied', { disposition: 'not_applied', confirmedInputBytes: 0 }))
  const action = await f.ingress.rejoin(first.request, context)
  const refused = await vi.waitFor(async () => {
    const receipt = (await f.ingress.inspect({ ingressId: first.request.ingressId })).inputReceipt!
    expect(receipt.status).toBe('not-applied'); return receipt
  })
  const calls = f.inner.kernel.input.mock.calls.length
  expect((await f.client.rejoinAgentInputWaiting({ ref: refused.ref, scope: 'wake-only' }, first.original[1])).ref).toEqual(refused.ref)
  expect((await f.client.submitAgentMessage(...first.original))!.ref).toEqual(refused.ref)
  expect((await f.ingress.dispatch(first.request.ingressId)).inputReceipt!.ref).toEqual(refused.ref)
  expect((await f.ingress.rejoin(first.request, context)).action).toEqual(action.action)
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(calls)
  const explicit = await f.client.rejoinAgentInputWaiting({ ref: refused.ref }, first.original[1])
  expect(explicit.ref.waitGeneration).toBe(refused.ref.waitGeneration + 1)
  expect(explicit.control.retry?.previousWaitGeneration).toBe(refused.ref.waitGeneration)
})

it('a delayed firstsave action points to the original generation after explicit Core reenable advances the observation', async () => {
  const f = await fixture(), first = await beforeFirstsave(f), saved = (await f.client.submitAgentMessage(...first.original))!
  await f.client.stopAgentInputWaiting({ ref: saved.ref, cancelOperationId: 'stop-before-delayed-action' })
  const current = await f.client.rejoinAgentInputWaiting({ ref: saved.ref }, first.original[1])
  expect(current.ref.waitGeneration).toBe(2)
  const wake = vi.spyOn(f.client, 'rejoinAgentInputWaiting')
  const result = await f.ingress.rejoin(first.request, context)
  expect(result.action.inputRef).toEqual(saved.ref)
  expect(result.inspection.inputReceipt!.ref).toEqual(current.ref)
  expect(wake).toHaveBeenCalledWith({ ref: saved.ref, scope: 'wake-only' }, expect.anything())
  expect((await new DurableIngressHost(f.options).rejoin(first.request, context)).action).toEqual(result.action)
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('retains an allowed action identity that is also a JavaScript prototype property', async () => {
  const f = await fixture(), first = await beforeFirstsave(f), request = { ...first.request, operationId: '__proto__' }
  const result = await f.ingress.rejoin(request, context)
  const row = f.connections.database.prepare('SELECT rejoin_json FROM connection_ingress_message WHERE ingress_id=?').get(request.ingressId)!
  expect(Object.hasOwn(JSON.parse(String(row.rejoin_json)), request.operationId)).toBe(true)
  expect((await new DurableIngressHost(f.options).rejoin(request, context)).action).toEqual(result.action)
})

it.each(['missing-root', 'ambiguous-chain', 'native-drift', 'executor-drift'] as const)('an unqualified %s cannot borrow the current Run for firstsave and leaves accurate healthy input available', async scenario => {
  const f = await fixture(true), first = await beforeFirstsave(f), prior = (await f.store.readMetadata(f.session.agentSessionId))!
  const nativeTarget = prior.nativeHandle!
  const operation = { operationId: 'private-resume', agentSessionId: prior.agentSessionId, previousRun: prior.run, newRun: { runId: 'resumed-original-run' },
    kind: 'resumed' as const, trigger: 'input' as const, policy: { continuationEnabled: false }, nativeTarget,
    admittedAt: 1, observedAt: 1, rechecks: 0, reason: 'run-ended', evidence: { kind: 'run-ended', state: 'exited', observedAt: 1 } }
  const continuityOperations = { [operation.operationId]: operation, ...(scenario === 'ambiguous-chain' ? { ambiguity: { ...operation, operationId: 'ambiguity' } } : {}) }
  await f.store.compareAndSwapMetadata(prior, { ...prior, run: operation.newRun, continuity: operation, continuityOperations,
    nativeBinding: { source: 'semantic-resume-target', run: operation.newRun, observedAt: 1 },
    ...(scenario === 'native-drift' ? { nativeHandle: { ...nativeTarget, sessionId: 'unrelated-native' } } : {}),
    ...(scenario === 'missing-root' ? {} : { continuityExecutors: { [operation.operationId]: { providerId: prior.providerId, executorId: scenario === 'executor-drift' ? 'wrong-executor' : prior.executorId, source: 'provider' } } }) } as typeof prior)
  await expect(f.client.submitAgentMessage(...first.original)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect((await f.ingress.dispatch(first.request.ingressId)).inputReceipt).toBeNull()
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  await f.client.submitAgentPrompt({ agentSessionId: prior.agentSessionId, expectedRun: operation.newRun, operationId: 'independent-current-input',
    prompt: 'Independent accurate healthy input', authorHuman: true, execution: 'immediate', admissionIntent: { kind: 'manual-actor' } })
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
})

it('public compiled CLI rejoin consumes the same original action and never reenables a stopped Core input', async () => {
  const f = await fixture(), first = await beforeFirstsave(f)
  const socketPath = join(f.root, 'custody.sock')
  const server = new core.AgentMuxControlServer({ socketPath, connections: f.connections, coreClients: f.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  const run = (args: string[], body = '') => runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', 'ingress', ...args], objectCliEnvironment(f.root), body)
  const stale = await run(['rejoin', '--input', '-'], JSON.stringify({ ...first.request, operationId: 'stale-public-action',
    source: { ...first.request.source, messageId: 'foreign-message' } }))
  expect(stale.code, stale.stderr).toBe(0)
  expect(JSON.parse(stale.stdout).result.action.outcome).toBe('stale')
  expect((await f.ingress.inspect({ ingressId: first.request.ingressId })).inputReceipt).toBeNull()
  const output = await run(['rejoin', '--input', '-'], JSON.stringify(first.request))
  expect(output.code, output.stderr).toBe(0)
  const accepted = JSON.parse(output.stdout).result
  expect(accepted.action).toMatchObject({ outcome: 'handed-off', operationId: first.request.operationId })
  const ref = accepted.action.inputRef
  await f.client.stopAgentInputWaiting({ ref, cancelOperationId: 'original-stop' })
  const again = await run(['rejoin', '--input', '-'], JSON.stringify(first.request))
  expect(again.code, again.stderr).toBe(0)
  expect(JSON.parse(again.stdout).result.action).toEqual(accepted.action)
  expect(JSON.parse(again.stdout).result.inspection.inputReceipt.control.state).toBe('stopped-before-dispatch')
  const inspected = await run(['inspect', '--ingress', first.request.ingressId])
  expect(JSON.parse(inspected.stdout).result.inputReceipt.ref).toEqual(ref)
  const help = await runCompiledObjectCli(['connection', 'ingress', 'rejoin', '--help'], objectCliEnvironment(f.root))
  expect(help.stdout).toContain('operationId'); expect(help.stdout).toContain('source')
  const skill = await runCompiledObjectCli(['connection', '--skill'], objectCliEnvironment(f.root))
  expect(skill.code).toBe(0); expect(skill.stdout).toContain('rejoinSource'); expect(skill.stdout).toContain('connection ingress rejoin')
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('each original ingress owns its action namespace without reading unrelated action history', async () => {
  const f = await fixture(), first = await beforeFirstsave(f)
  const prepare = f.connections.database.prepare.bind(f.connections.database)
  vi.spyOn(f.connections.database, 'prepare').mockImplementation(sql => {
    if (sql.includes('json_each(rejoin_json)')) throw Error('Unrelated action history is unavailable')
    return prepare(sql)
  })
  const original = await f.ingress.rejoin(first.request, context)
  const other = await f.receive({ eventId: 'independent-namespace-event', messageId: 'independent-namespace-message' })
  vi.spyOn(f.client, 'submitAgentMessage').mockRejectedValueOnce(Error('Independent firstsave boundary'))
  const inspection = await f.ingress.dispatch(other.ingress.ingressId)
  const otherRequest = { ingressId: other.ingress.ingressId, operationId: first.request.operationId, source: inspection.rejoinSource! }
  const independent = await f.ingress.rejoin(otherRequest, context)
  expect(independent.action.outcome).toBe('handed-off')
  expect(independent.action.inputRef!.key).not.toEqual(original.action.inputRef!.key)
  expect((await f.ingress.rejoin(first.request, context)).action).toEqual(original.action)
})

async function publicManaged(f: Awaited<ReturnType<typeof fixture>>) {
  const hosted = new core.AgentMuxHostedRuntimeService(f.client, f.store.path, () => hostedTestOwner(f.client))
  cleanup.push(() => hosted.dispose())
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'managed-custody.sock'), connections: f.connections,
    coreClients: f.coreClients, hostedRuntime: () => hosted })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  return { rpc, server, credentials: { agentSessionId: f.session.agentSessionId, capability: f.capability } }
}

it('public managed recipient ensures its frozen message without enrollment ownership and preserves its real actor', async () => {
  const f = await fixture(true), first = await beforeFirstsave(f), api = await publicManaged(f)
  const enrollment = vi.spyOn(f.connections, 'ownsEnrollmentConnection').mockResolvedValue(false)
  const env = objectCliEnvironment(f.root, { AGENTMUX_AGENT_SESSION_ID: f.session.agentSessionId, AGENTMUX_AGENT_CAPABILITY: f.capability })
  const run = () => runCompiledObjectCli(['--endpoint', 'unix:' + api.server.path, 'connection', 'ingress', 'rejoin', '--input', '-'], env, JSON.stringify(first.request))
  const stale = await runCompiledObjectCli(['--endpoint', 'unix:' + api.server.path, 'connection', 'ingress', 'rejoin', '--input', '-'], env,
    JSON.stringify({ ...first.request, operationId: 'managed-stale-source', source: { ...first.request.source, messageId: 'foreign-message' } }))
  expect(await f.client.inspectAgentInput({ kind: 'message-control', originalControlOperationId: first.original[0].envelope.operationId })).toBeNull()
  expect(stale.code, stale.stderr).toBe(0); expect(JSON.parse(stale.stdout).result.action.outcome).toBe('stale')
  const output = await run()
  expect(output.code, output.stderr).toBe(0)
  const result = JSON.parse(output.stdout).result
  expect(result.action).toMatchObject({ ...first.request, outcome: 'handed-off' })
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  const row = f.connections.database.prepare('SELECT rejoin_json FROM connection_ingress_message WHERE ingress_id=?').get(first.request.ingressId)!
  expect(JSON.parse(String(row.rejoin_json))[first.request.operationId].actor).toEqual({ kind: 'agent', id: f.session.agentSessionId })
  expect(JSON.parse((await run()).stdout).result.action).toEqual(result.action)
  expect(enrollment).not.toHaveBeenCalled()
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
})

it.each(['foreign-session', 'foreign-host', 'no-frozen-target', 'wrong-runtime', 'revoked-grant', 'context-cancel-source'] as const)('public managed custody rejects %s advancement while retaining original facts and healthy local input', async scenario => {
  const f = await fixture(true), first = await beforeFirstsave(f), api = await publicManaged(f)
  let request = first.request, credentials = api.credentials
  if (scenario === 'foreign-session') {
    const prior = (await f.store.readMetadata(f.session.agentSessionId))!
    await f.store.compareAndSwap(null, { ...prior, agentSessionId: 'foreign-session', run: { runId: 'foreign-run' }, nativeHandle: undefined, nativeBinding: undefined })
    await f.inner.registry.load('local')
    credentials = { ...credentials, agentSessionId: 'foreign-session' }
  }
  if (scenario === 'foreign-host') {
    const row = f.connections.database.prepare('SELECT record_json FROM connection_ingress_message WHERE ingress_id=?').get(request.ingressId)!
    const record = JSON.parse(String(row.record_json)); record.input.hostId = 'foreign-host'
    f.connections.database.prepare('UPDATE connection_ingress_message SET record_json=? WHERE ingress_id=?').run(JSON.stringify(record), request.ingressId)
  }
  if (scenario === 'no-frozen-target') {
    const received = await f.receive({ eventId: 'unassigned-event', messageId: 'unassigned-message' })
    request = { ingressId: received.ingress.ingressId, operationId: 'unassigned-action', source: { kind: 'received', preparationRevision: 0 } }
  }
  if (scenario === 'revoked-grant') await f.bindings.grant({ ...f.grant, operationId: 'revoke-before-managed-ensure', expectedRevision: 1, state: 'revoked' }, context)
  if (scenario === 'context-cancel-source') request = { ...request, source: { kind: 'context-observation', observationId: 'unissued-context-source' } }
  const call = api.rpc.call('connection.ingress.rejoin', request, { credentials,
    ...(scenario === 'wrong-runtime' ? { runtimeFence: { runtimeId: 'foreign-runtime', ownerInstanceId: 'foreign-owner' } } : {}) })
  if (scenario === 'revoked-grant') {
    expect(await call).toMatchObject({ action: { outcome: 'pending' }, inspection: { inputReceipt: null } })
    expect(await f.ingress.authority({ operationId: first.original[0].envelope.operationId })).toMatchObject({ authority: 'refused' })
  } else await expect(call).rejects.toMatchObject({ code: scenario === 'wrong-runtime' ? 'RUNTIME_OWNER_MISMATCH' : 'CONTROL_PERMISSION_DENIED' })
  expect(await f.client.inspectAgentInput({ kind: 'message-control', originalControlOperationId: first.original[0].envelope.operationId })).toBeNull()
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  await f.client.submitAgentPrompt({ agentSessionId: f.session.agentSessionId, expectedRun: f.session.run, operationId: 'accurate-independent-input',
    prompt: 'Healthy local input', authorHuman: true, execution: 'immediate', admissionIntent: { kind: 'manual-actor' } })
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
})

it('real receiver and owner crashes preserve claimed custody, the accepted action, and a single original PTY effect', async () => {
  const source = await fixture()
  vi.stubEnv('AGENTMUX_TEST_OWNER_ENTRY', resolve(import.meta.dirname, 'fixtures/ingress-custody-worker.mjs'))
  const h = await headlessFixture(); cleanup.push(h.cleanup)
  const state = h.env.AGENTMUX_STATE_DIRECTORY!, output = join(h.root, 'original-terminal.jsonl')
  let client = await h.client(), rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: h.socketPath } })
  const rpcs = [rpc]; cleanup.push(async () => { for (const connection of rpcs) await connection.dispose(); vi.unstubAllEnvs() })
  const session = await client.createAgent({ agentSessionId: 'original-agent', createOperationId: 'custody-create', providerId: 'pi', executorId: 'pi',
    workspacePath: h.root, injectAgentMuxGuide: false, commandOverride: process.execPath,
    args: [resolve(import.meta.dirname, '../../core/test/fixtures/prompt-carrier-terminal.mjs')], env: { AGENTMUX_TEST_INPUT_WITNESS: output } })
  const before = await until(async () => { try { const ready = JSON.parse(await readFile(output + '.ready', 'utf8')); const status = await client.statusAgent(session.agentSessionId); return ready.pid === status.run.pid ? status : null } catch { return null } }, Boolean, 'original private PTY')
  await writeFile(join(state, 'checkpoint.json'), JSON.stringify(await source.client.conversationCheckpoint({ hostId: 'local', agentSessionId: 'original-agent' })))
  const { regionAnchor: _anchor, ...bind } = source.input
  expect(await rpc.call('connection.bind', bind)).toMatchObject({ state: 'applied' })
  expect(await rpc.call('connection.grant', source.grant)).toMatchObject({ state: 'applied' })
  await writeFile(join(state, 'hold-before-firstsave'), 'barrier')
  await writeFile(join(state, 'transport-event.json'), JSON.stringify({ proof: 'adapter-private-witness', event: source.event() }))
  const originalRequest = await until(async () => { try { return JSON.parse(await readFile(join(state, 'before-firstsave.json'), 'utf8')) } catch { return null } }, Boolean, 'receiver durable claim before Core firstsave')
  const list = await rpc.call('connection.ingress.ls', { connectionId: source.input.connectionId })
  const ingressId = list.ingresses[0]!.ingressId
  const first = await rpc.call('connection.ingress.inspect', { ingressId })
  expect(first).toMatchObject({ ingress: { state: 'claimed', body: source.event().body }, inputReceipt: null })
  expect(await client.inspectAgentInput({ kind: 'message-control', originalControlOperationId: originalRequest.envelope.operationId })).toBeNull()
  const request = { ingressId, operationId: 'crash-original-action', source: first.rejoinSource! }, owners = [h.owner], pids = [h.ownerProcess.pid]
  const crash = async () => {
    const ended = once(h.ownerProcess, 'exit'); h.ownerProcess.kill('SIGKILL'); await ended
    await h.restart(); owners.push(h.owner); pids.push(h.ownerProcess.pid)
    client = await h.client(); rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: h.socketPath } }); rpcs.push(rpc)
    expect((await client.statusAgent(session.agentSessionId)).run).toMatchObject({ runId: before!.run.runId, pid: before!.run.pid, state: 'running' })
  }
  await crash()
  await rm(join(state, 'before-firstsave.json'))
  const acceptedBeforeCall = rpc.call('connection.ingress.rejoin', request).catch(() => null)
  await until(async () => { try { return JSON.parse(await readFile(join(state, 'before-firstsave.json'), 'utf8')) } catch { return null } }, Boolean, 'accepted action before firstsave call')
  const { DatabaseSync } = await import('node:sqlite'), disk = new DatabaseSync(join(state, 'connections', 'connections.sqlite'))
  let actionBeforeCall
  try { actionBeforeCall = JSON.parse(String(disk.prepare('SELECT rejoin_json FROM connection_ingress_message WHERE ingress_id=?').get(ingressId)!.rejoin_json))[request.operationId].action
    expect(actionBeforeCall).toMatchObject({ ...request, outcome: 'pending' }) } finally { disk.close() }
  // The same action survives a second loss before any Core acceptance.
  await crash(); await acceptedBeforeCall
  await rm(join(state, 'hold-before-firstsave'))
  await writeFile(join(state, 'hold-after-firstsave'), 'barrier')
  await writeFile(join(state, 'hold-after-gate'), 'qualified original gate before first effect')
  const lostAfterSave = rpc.call('connection.ingress.rejoin', request).catch(() => null)
  const saved = await until(async () => { try { return JSON.parse(await readFile(join(state, 'after-firstsave.json'), 'utf8')) } catch { return null } }, Boolean, 'Core durable firstsave before local action reply')
  expect(saved.persistence).toBe('confirmed')
  await until(async () => { try { return JSON.parse(await readFile(join(state, 'gate-witness.json'), 'utf8')) } catch { return null } }, Boolean, 'same qualified handoff gate before first effect')
  const gated = (await client.inspectAgentInput({ key: saved.key }))!
  expect(gated.control).toMatchObject({ state: 'dispatch-authorized', handoff: { carrier: { kind: 'pty' } } }); expect(gated.admission).toBeNull()
  await crash(); await lostAfterSave
  await rm(join(state, 'hold-after-firstsave'))
  await rm(join(state, 'hold-after-gate'))
  // A delayed same-operation writer races recovery through the actual Hosted service.
  const delayed = client.submitAgentMessage(originalRequest)
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + h.socketPath, 'connection', 'ingress', 'rejoin', '--input', '-'], objectCliEnvironment(h.root), JSON.stringify(request))
  expect(cli.code, cli.stderr).toBe(0)
  const result = JSON.parse(cli.stdout).result
  expect(result.action).toMatchObject({ ...request, outcome: 'handed-off', inputRef: saved.ref })
  expect((await delayed)!.ref).toEqual(saved.ref)
  const inputs = async () => (await readFile(output, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })).split('\n').filter(Boolean).map(line => JSON.parse(line).text)
  await until(inputs, value => value.length === 1, 'one original real PTY effect')
  expect((await client.readAgentInputMailbox({ agentSessionId: session.agentSessionId })).items).toHaveLength(1)
  expect((await rpc.call('connection.ingress.rejoin', request)).action).toEqual(result.action)
  expect(await inputs()).toHaveLength(1)
  expect(new Set(pids).size).toBe(4); expect(new Set(owners.map(owner => owner.runtimeId)).size).toBe(1)
  expect(new Set(owners.map(owner => owner.ownerInstanceId)).size).toBe(4)
  if (process.env.INGRESS_CUSTODY_CRASH) await writeFile(process.env.INGRESS_CUSTODY_CRASH, JSON.stringify({ owners, pids, before,
    after: await client.statusAgent(session.agentSessionId), originalRequest, first, actionBeforeCall, saved, gated, result, inputs: await inputs() }, null, 2))
  await client.stopAgent(session.agentSessionId, session.run)
}, 60000)
