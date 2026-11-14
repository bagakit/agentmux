import { afterEach, expect, it, vi } from 'vitest'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createMoteConversationStartFixture } from './helpers/mote-conversation-start-fixture.js'
import { preparedFixtureRun } from '../../../packages/core/test/helpers/prepared-fixture-run.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { runSourceObjectCli } from '../../../packages/core/test/helpers/source-object-cli.js'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { moteMainBaseline, spatialAgentOpenRecord, moteMainHandoverInputId } from '../../../packages/core/src/spatial-agent-open-contract.js'
import { moteQuickBaseline } from '../../../packages/core/src/mote/preferences.js'
import { AgentMuxError } from '../../../packages/core/src/errors.js'

// A standalone listener is loaded from this source candidate, rather than a
// concurrently rebuilt dist asset. Its actual OS socket/IPC behavior is intact.
vi.mock('node:child_process', async importOriginal => {
  const native = await importOriginal<typeof import('node:child_process')>()
  return { ...native, fork: (path: string | URL, args: string[], options: import('node:child_process').ForkOptions) => {
    const listener = String(path).endsWith('/dist/control-endpoint-listener-worker.js')
    return native.fork(listener ? new URL('../../../packages/core/src/control-endpoint-listener-worker.ts', import.meta.url) : path, args,
      { ...options, execArgv: listener ? ['--experimental-transform-types'] : options.execArgv })
  } }
})
const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function record(value: unknown) { if (process.env.MOTE_ESCAPE_CASES) await appendFile(process.env.MOTE_ESCAPE_CASES, JSON.stringify(value) + '\n') }
async function fixture() {
  const f = await createMoteConversationStartFixture({ providerId: 'claude' }); closes.push(f.close)
  await record({ scenario: 'private-root', root: f.h.root })
  await f.start('original-main'); const originalSetup = await f.settledSetup('original-main')
  expect(originalSetup.binding, originalSetup.issue ?? '').toBe('confirmed')
  const main = await f.main.readCurrentMoteMain(f.target), session = (await f.h.client.readAgentSession(main.current!.sessionId))!
  const entry = (operationId: string) => ({ target: f.target, expectedRoleRevision: main.roleRevision!, reference: main.current!, expectedRun: session.run, operationId })
  const cli = (path: string[], input?: unknown, credentials?: { agentSessionId: string; capability: string }) => runSourceObjectCli(
    ['--endpoint', 'unix:' + f.server.path, ...path], objectCliEnvironment(f.h.root, credentials ? {
      AGENTMUX_AGENT_SESSION_ID: credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: credentials.capability
    } : {}), input === undefined ? '' : JSON.stringify(input), 30000, new URL('./fixtures/mote-main-recovery-escape-loader.mjs', import.meta.url))
  const newIntent = async (operationId: string) => {
    const read = await f.rpc.call('space.mote.preferences.read', { kind: 'quick', target: f.target })
    const current = await f.main.readCurrentMoteMain(f.target), baseline = moteQuickBaseline(read)
    if (!baseline) throw Error('The exact original preferences baseline is unavailable')
    return { target: f.target, baseline: moteMainBaseline(baseline), expectedRoleRevision: current.roleRevision,
      sourceOperationId: operationId + ':source', bindOperationId: operationId + ':bind' }
  }
  return { ...f, mainSnapshot: main, session, entry, cli, newIntent }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
function endedRuntime(f: Fixture, lostStart = false) {
  const core = f.h.inner, originalStatus = core.kernel.status, oldRun = f.session.run.runId
  core.kernel.status = vi.fn(async (id: string) => id === oldRun
    ? { ...await originalStatus(id), state: { type: 'exited', code: 0, signal: null }, acceptedInputBytes: null }
    : await originalStatus(id))
  core.kernel.launchIdentity = ({ program, args }: any) => ({ program, argsDigest: createHash('sha256').update(JSON.stringify(args)).digest('base64url') })
  core.kernel.prepareStart = ({ program, args, cwd, env }: any) => preparedFixtureRun(program, { args, cwd, env, initialSize: { cols: 80, rows: 24 } })
  core.kernel.creationRuntimeIdentity = () => ({ runtimeId: 'escape-fixture-runtime', instanceId: 'escape-fixture', protocolVersion: 18, buildIdentity: 'fixture' })
  core.hookServer.createBinding = (_session: string, _provider: string, bindingId: string) => ({ bindingId, endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
  core.kernel.startPrepared = vi.fn(async (request: any, operationKey: string) => core.kernel.start({ ...request, operationKey }))
  core.kernel.inspectCreation = vi.fn(async (operationKey: string) => {
    const index = f.h.started.findIndex((value: any) => value.operationKey === operationKey)
    return index < 0 ? null : core.kernel.status('fixture-run-' + index)
  })
  core.kernel.inspectPreparedStart = vi.fn(async (_request: unknown, operationKey: string) => core.kernel.inspectCreation(operationKey))
  if (lostStart) {
    const start = core.kernel.start
    core.kernel.start = vi.fn(async (spec: any) => { await start(spec); throw new AgentMuxError('Controlled original Start acknowledgement is unknown', 'CTXMUX_START_UNKNOWN', undefined, { disposition: 'unknown', confirmedInputBytes: null }) })
  }
  return core
}
async function unknownQuery(f: Fixture) {
  const request = { target: f.target, expectedRoleRevision: f.mainSnapshot.roleRevision!, input: {
    agentSessionId: f.session.agentSessionId, expectedRun: f.session.run, operationId: 'old-unknown-query', prompt: 'Retain this original question only on its original Main.',
    admissionIntent: { kind: 'manual-actor' as const }, execution: 'immediate' as const } }
  const original = f.h.inner.kernel.input
  f.h.inner.kernel.input = vi.fn(async (...args: any[]) => {
    await original(...args)
    throw new AgentMuxError('Controlled original input acknowledgement is unknown', 'CTXMUX_INPUT_UNKNOWN', undefined, { disposition: 'unknown', confirmedInputBytes: null })
  })
  await f.rpc.call('space.mote.dialogue.input.submit', request)
  let saved = await f.rpc.call('space.mote.dialogue.input.inspect', { target: f.target, operationId: request.input.operationId })
  await vi.waitFor(async () => {
    saved = await f.rpc.call('space.mote.dialogue.input.inspect', { target: f.target, operationId: request.input.operationId })
    expect(saved.input?.status).toBe('unknown')
  })
  f.h.inner.kernel.input = original
  expect(saved.route?.key).toEqual({ kind: 'prompt', agentSessionId: f.session.agentSessionId, expectedRun: f.session.run, submissionId: request.input.operationId })
  expect(saved.record?.admission?.intent?.message.userContent).toBe(request.input.prompt)
  return { request, saved }
}
/** Only owner-recorded platform initialization and the separately keyed handover
 * may write here. Neither authorizes adopting or replaying the old Query. */
async function assertPlatformInputs(f: Fixture, sessionId: string, from: number, handover?: import('../../../packages/core/src/types.js').AgentPromptSubmissionRecord | null) {
  const session = (await f.h.client.readAgentSession(sessionId))!, initial = session.creation?.initialInputKey
  expect(session.creation?.initialPrompt).toBe('not-requested'); expect(initial?.agentSessionId).toBe(sessionId)
  const creation = initial && await f.h.client.inspectAgentPromptSubmission(initial)
  expect(creation?.admission?.inputKey).toEqual(initial)
  expect(creation?.admission?.intent?.message.userContent).toBeUndefined()
  const records = [creation, handover].filter((value): value is NonNullable<typeof value> => !!value)
  const delta = f.h.inner.kernel.input.mock.calls.slice(from)
  expect(delta.length).toBe(records.length)
  for (const [runId, input] of delta) {
    const original = records.find(value => value.admission?.operationId === input.operationId)
    expect(original).toBeDefined(); expect(original!.agentSessionId).toBe(sessionId); expect(original!.run.runId).toBe(runId)
    expect(original!.admission?.inputKey?.submissionId).not.toBe('old-unknown-query')
    expect(original!.admission?.intent?.plan).toMatchObject({ kind: 'single-phase', data: input.data })
  }
  return { requestedTask: session.creation?.initialPrompt, creationKey: initial,
    handoverKey: handover?.admission?.inputKey ?? null, inputs: delta.map(([runId, input]: any[]) => ({ runId, operationId: input.operationId })) }
}
it('typed missing-handle unavailable starts nothing; explicit person source CLI creates a no-input Main while retaining the old unknown Query', async () => {
  const f = await fixture(), oldQuery = await unknownQuery(f)
  const before = (await f.h.store.readMetadata(f.session.agentSessionId))!, { nativeHandle: _native, nativeBinding: _binding, nativeSourceObservation: _sourceObservation, nativeConfirmation: _confirmation, observedNativeHandle: _observedNative, nativeTurnEnds: _ends, nativeInteractionEnds: _interactions, nativeSubagents: _subagents, currentActivity: _activity, recoveryActivity: _recoveryActivity, ...withoutNative } = before
  await f.h.store.compareAndSwapMetadata(before, withoutNative); await f.h.inner.registry.load('local')
  endedRuntime(f)
  const starts = f.h.started.length, writes = f.h.inner.kernel.input.mock.calls.length, entry = f.entry('unavailable-original-entry')
  expect(await f.rpc.call('space.mote.dialogue.recovery.inspect', entry)).toEqual({ operation: null })
  const first = await f.cli(['space', 'mote', 'dialogue', 'recovery', 'ensure', '--input', '-'], entry)
  expect(first.code, first.stdout + first.stderr).toBe(0)
  const unavailable = JSON.parse(first.stdout).result
  expect(unavailable.operation).toMatchObject({ kind: 'unavailable', reason: 'native-handle-unavailable', operationId: entry.operationId, previousRun: f.session.run })
  expect(await f.rpc.call('space.mote.dialogue.recovery.inspect', entry)).toEqual(unavailable)
  expect(f.h.started).toHaveLength(starts); expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(writes)
  const recover = vi.spyOn(f.h.client, 'ensureAgentContinuity').mockRejectedValue(new Error('The old recovery is not a prerequisite for new creation'))
  vi.spyOn(f.h.client, 'sessionHistoryPage').mockRejectedValue(new Error('The old native history remains unavailable'))
  const oldContext = vi.spyOn(f.h.client, 'sessionHistorySources').mockRejectedValue(new Error('The original context source is unavailable'))
  vi.spyOn(f.h.client, 'conversationCheckpoint').mockRejectedValue(new Error('The original checkpoint is unavailable'))
  const operationId = 'explicit-new-main', intent = { ...await f.newIntent(operationId), handover: true as const }, graphBefore = (await f.spatial.read())!.graph
  const opened = await f.cli(['agent', 'open', '--executor', 'saved', '--space', f.target.spaceId, '--zone', f.target.zoneId, '--new-tab', '--operation-id', operationId, '--mote-main', '-'], intent)
  expect(opened.code, opened.stdout + opened.stderr).toBe(0)
  const created = JSON.parse(opened.stdout).result
  expect(created.outcome).toBe('opened'); expect(created.agent.agentSessionId).not.toBe(f.session.agentSessionId)
  const inspect = await f.rpc.call('space.mote.dialogue.setup.inspect', { target: f.target, creation: { hostId: 'local', operationId } })
  expect(inspect.creation).toBe('confirmed')
  const creationContext = await assertPlatformInputs(f, created.agent.agentSessionId, writes)
  expect(creationContext.handoverKey).toBeNull()
  const setupCli = await f.cli(['space', 'mote', 'dialogue', 'setup', 'advance', '--input', '-'], { target: f.target, creation: { hostId: 'local', operationId } })
  expect(setupCli.code, setupCli.stdout + setupCli.stderr).toBe(0)
  const bound = JSON.parse(setupCli.stdout).result
  expect(bound.binding, bound.issue ?? '').toBe('confirmed'); expect(bound.reference.sessionId).toBe(created.agent.agentSessionId)
  expect(bound.deferredInput ?? null).toBeNull()
  expect(bound.handoverInput?.route?.key).toMatchObject({ agentSessionId: created.agent.agentSessionId, submissionId: moteMainHandoverInputId(operationId) })
  expect(bound.handoverInput?.route?.key.submissionId).not.toBe(oldQuery.request.input.operationId)
  expect(oldContext).toHaveBeenCalled()
  expect(bound.issue).toBeTruthy()
  expect(recover).not.toHaveBeenCalled(); expect(f.h.started).toHaveLength(starts + 1)
  const permittedContext = await assertPlatformInputs(f, created.agent.agentSessionId, writes, bound.handoverInput?.record)
  const afterHandoverWrites = f.h.inner.kernel.input.mock.calls.length
  expect(await f.rpc.call('space.mote.dialogue.input.inspect', { target: f.target, operationId: oldQuery.request.input.operationId })).toEqual(oldQuery.saved)
  await expect(f.rpc.call('space.mote.dialogue.input.submit', oldQuery.request)).resolves.toEqual(oldQuery.saved)
  await expect(f.rpc.call('space.mote.dialogue.input.submit', { ...oldQuery.request, input: { ...oldQuery.request.input, prompt: 'Do not redirect the old operation' } })).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(afterHandoverWrites)
  const old = (await f.h.client.readAgentSession(f.session.agentSessionId))!
  expect(old.run).toEqual(f.session.run); expect(old.nativeHandle).toBeUndefined(); expect(old.continuityOperations?.[entry.operationId]).toEqual(unavailable.operation)
  const admission = spatialAgentOpenRecord((await f.spatial.read())!.graph, operationId)!
  expect(admission.moteMain?.deferredInput).toBeUndefined(); expect(admission.moteMainFollowUps?.deferredInputKey).toBeUndefined()
  const graphAfter = (await f.spatial.read())!.graph
  expect(graphAfter.resources['tab:old-tab']).toEqual(graphBefore.resources['tab:old-tab'])
  for (const original of graphBefore.regions) expect(graphAfter.regions).toContainEqual(original)
  expect(await readFile(f.path, 'utf8')).toContain('Keep original cooperation notes.')
  expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
  await record({ scenario: 'unavailable-explicit-new', root: f.h.root, entry, unavailable, created: { agentSessionId: created.agent.agentSessionId, operationId }, bound: { binding: bound.binding, reference: bound.reference }, oldQuery: oldQuery.saved, afterQuery: await f.rpc.call('space.mote.dialogue.input.inspect', { target: f.target, operationId: oldQuery.request.input.operationId }), startsBefore: starts, startsAfter: f.h.started.length, inputWritesBefore: writes, inputWritesAfter: f.h.inner.kernel.input.mock.calls.length, oldResumeCalls: recover.mock.calls.length, permittedContext })
})
it('an unknown original Start stays on its original operation and does not block a separate explicit SDK new Main', async () => {
  const f = await fixture(), core = endedRuntime(f, true), starts = f.h.started.length, entry = f.entry('unknown-original-entry')
  const first = await f.rpc.call('space.mote.dialogue.recovery.ensure', entry)
  await record({ scenario: 'unknown-first-observation', root: f.h.root, first, starts: f.h.started.length })
  expect(first.operation, JSON.stringify(first)).toMatchObject({ reason: 'operation-unconfirmed', operationId: entry.operationId })
  expect(first.operation?.kind).not.toBe('unavailable'); expect(f.h.started).toHaveLength(starts + 1)
  const ensure = vi.spyOn(f.h.client, 'ensureAgentContinuity')
  const read = await f.cli(['space', 'mote', 'dialogue', 'recovery', 'inspect', '--input', '-'], { ...entry, operationId: 'another-explicit-entry' })
  expect(read.code, read.stdout + read.stderr).toBe(0); expect(JSON.parse(read.stdout).result).toEqual(first)
  expect(await f.rpc.call('space.mote.dialogue.recovery.ensure', { ...entry, operationId: 'another-explicit-entry' })).toEqual(first)
  expect(ensure).not.toHaveBeenCalled(); expect(f.h.started).toHaveLength(starts + 1)
  core.kernel.start = vi.fn(async (spec: any) => {
    const runId = 'fixture-run-' + f.h.started.length; f.h.started.push(spec)
    return { ...f.h.run(runId), workspacePath: spec.cwd, program: spec.program, args: spec.args, lifecycleOperationId: spec.operationKey }
  })
  const operationId = 'explicit-after-unknown', intent = await f.newIntent(operationId), writes = core.kernel.input.mock.calls.length
  const created = await f.rpc.call('agent.open', { operationId, content: { kind: 'new-agent', executorId: 'saved' }, destination: { spaceId: f.target.spaceId, zoneId: f.target.zoneId, newTab: true }, focus: false, moteMain: intent })
  expect(created.outcome).toBe('opened')
  const bound = await f.settledSetup(operationId)
  expect(bound.binding, bound.issue ?? '').toBe('confirmed'); expect(bound.reference?.sessionId).not.toBe(f.session.agentSessionId)
  expect(await f.rpc.call('space.mote.dialogue.recovery.inspect', entry)).toEqual(first)
  const permittedContext = await assertPlatformInputs(f, bound.reference!.sessionId, writes)
  expect(f.h.started).toHaveLength(starts + 2); expect(core.kernel.stop).not.toHaveBeenCalled()
  await record({ scenario: 'unknown-independent-new', root: f.h.root, entry, first, after: await f.rpc.call('space.mote.dialogue.recovery.inspect', entry), repeatedEnsureCalls: ensure.mock.calls.length, bound: { binding: bound.binding, reference: bound.reference }, oldSessionId: f.session.agentSessionId, startsBefore: starts, startsAfter: f.h.started.length, permittedContext })
})
it('managed SDK and source CLI cannot recover or appoint Main through the same person-only contracts', async () => {
  const f = await fixture(), entry = f.entry('managed-entry'), credentials = { agentSessionId: 'source', capability: f.h.capability }
  const managed = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.server.path }, credentials }); closes.push(() => managed.dispose())
  const starts = f.h.started.length, writes = f.h.inner.kernel.input.mock.calls.length
  await expect(managed.call('space.mote.dialogue.recovery.ensure', entry)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  const denied = await f.cli(['space', 'mote', 'dialogue', 'recovery', 'ensure', '--input', '-'], entry, credentials)
  expect(denied.code).not.toBe(0); expect(denied.stdout + denied.stderr).toContain('CONTROL_PERMISSION_DENIED')
  const operationId = 'managed-creation', intent = await f.newIntent(operationId)
  await expect(managed.call('agent.open', { operationId, content: { kind: 'new-agent', executorId: 'saved' }, destination: { spaceId: f.target.spaceId, zoneId: f.target.zoneId, newTab: true }, focus: false, moteMain: intent })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(managed.call('space.mote.dialogue.setup.advance', { target: f.target, creation: { hostId: 'local', operationId: 'original-main' } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(f.h.started).toHaveLength(starts); expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(writes); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
  await record({ scenario: 'managed-denied', root: f.h.root, sdkDenied: true, sourceCliDenied: true, appointmentDenied: true, setupDenied: true, startsBefore: starts, startsAfter: f.h.started.length })
})
