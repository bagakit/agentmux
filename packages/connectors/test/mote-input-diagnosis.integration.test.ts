import { expect, it, vi } from 'vitest'
import { AgentMuxError, type AgentMuxStoredAgentSession, type AgentProviderInputInitialization } from '@agentmux/core'
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '../../core/src/agent-session-recovery/continuity-contract.js'
import { moteChatDiagnosisKey, moteChatInputFailureCode } from '@agentmux/core/mote-chat'
import { nativeInputCorrelationKey } from '../../core/src/native-input-correlation.js'
import { MoteChatStore } from '../src/mote-chat-store.js'
import { moteChatJourneyFixture as fixture } from './fixtures/mote-chat-journey.js'

it('projects an actual original Core initialization wait through public RPC and compiled CLI without granting retry', async () => {
  const f = await fixture(1, 60_000, 'headless', true)
  const initialization: AgentProviderInputInitialization = { state: 'unknown', reason: 'inspection-unavailable', source: 'unavailable', scope: 'unknown' }
  const observed = vi.fn(async () => initialization)
  f.client.providers.replace({ ...f.client.providers.get('claude'), readInputInitialization: observed })
  f.inner.kernel.readRunEnvironment = vi.fn(async (runId: string) => f.start.mock.calls[Number(runId.replace('native-run-', '')) - 1]?.[0].env)
  const rejoin = vi.spyOn(f.client, 'rejoinAgentInputWaiting')
  expect(await f.wire.post(f.message('original-initialization'))).toBe(202)
  const record = await f.claimed('original-initialization'), key = moteChatDiagnosisKey(f.target, record.ingressId)
  await vi.waitFor(async () => {
    const receipt = (await f.services.ingress!.inspect({ ingressId: record.ingressId })).inputReceipt, waiting = receipt?.control.waiting
    expect(receipt, JSON.stringify({ status: receipt?.status, phase: waiting?.phase, reason: waiting?.reason,
      observationPhase: waiting && 'observation' in waiting ? waiting.observation?.phase : null,
      failureCode: receipt ? moteChatInputFailureCode(receipt) : null, initializationReads: observed.mock.calls.length }))
      .toMatchObject({ status: 'waiting', control: { waiting: { phase: 'service', observation: { phase: 'native-initialization' },
        failure: { code: 'AGENT_INITIAL_INPUT_UNCONFIRMED' }, initialization } } })
  }, { timeout: 5_000 })
  const store = new MoteChatStore(f.services.database!), admission = store.admissionByIngress(record.ingressId), configuration = store.configuration(f.target.spaceId)
  const people = store.people(f.target.spaceId, '', 5)
  expect(people.length).toBeGreaterThan(0)
  const report = await f.sdk.call('space.mote.chat.diagnose', { target: f.target })
  const original = report.incoming!.rows.find(row => row.key === key)!.input
  expect(original.failureCode, 'original initialization failure must remain distinguishable').toBe('AGENT_INITIAL_INPUT_UNCONFIRMED')
  expect(original.waitObservation, 'the original Core initialization observation must reach the public consumer')
    .toEqual({ phase: 'native-initialization', initialization })
  expect(original.runtime).toMatchObject({ target: 'original', continuity: 'confirmed' })
  const cli = await f.cli('diagnose', { target: f.target }, f.credentials(0))
  expect(cli.incoming.rows.find((row: { key: string }) => row.key === key).input).toEqual(original)
  const denied = await f.cliRaw('inspect', { target: f.target }, f.credentials(0))
  expect(denied.code).toBe(1); expect(JSON.parse(denied.stderr).error.code).toBe('CONTROL_PERMISSION_DENIED')
  for (const secret of [f.root, record.body, record.ingressId, record.input!.agentSessionId, record.input!.expectedRun.runId,
    record.input!.operationId, f.lanePerson.userId, 'observedAt', 'nativeSessionId', 'providerId', 'canRetry']) expect(JSON.stringify(cli)).not.toContain(secret)
  expect((await f.records()).find(row => row.ingressId === record.ingressId)!.input).toEqual(record.input)
  expect(store.admissionByIngress(record.ingressId)).toEqual(admission); expect(store.configuration(f.target.spaceId)).toEqual(configuration)
  expect(store.people(f.target.spaceId, '', 5)).toEqual(people)
  expect(observed).toHaveBeenCalled(); expect(rejoin).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect(f.start).toHaveBeenCalledOnce(); expect(f.wire.effects).toHaveLength(0)
}, 20_000)

it('relates each frozen input only through its exact Session snapshot and canonical resume sources', async () => {
  const f = await fixture(2, 60_000, 'headless')
  for (const id of ['original-one', 'original-two']) { expect(await f.wire.post(f.message(id))).toBe(202); await f.claimed(id) }
  await vi.waitFor(async () => {
    for (const row of await f.records()) expect((await f.services.ingress!.inspect({ ingressId: row.ingressId })).inputReceipt)
      .toMatchObject({ status: 'waiting', control: { state: 'enabled' } })
  })
  const records = await f.records(), frozen = records[0]!.input!, sid = frozen.agentSessionId
  const initial = (await f.store.readMetadata(sid))!, nextRun = { runId: 'diagnosis-successor' }, at = initial.updatedAt + 1
  if (initial.nativeHandle?.kind !== 'provider') throw Error('The original fixture must retain a native target')
  const nativeTarget = initial.nativeHandle
  const resumed: AgentMuxStoredAgentSession = { ...initial, run: nextRun, retiredRuns: [...initial.retiredRuns, initial.run], updatedAt: at,
    nativeBinding: { source: 'semantic-resume-target' as const, run: nextRun, observedAt: at },
    continuity: { operationId: 'diagnosis-resume', agentSessionId: sid, trigger: 'manual' as const, policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY },
      reason: 'original-native-context', admittedAt: at, observedAt: at, rechecks: 0, kind: 'resumed' as const, previousRun: initial.run,
      newRun: nextRun, nativeTarget, evidence: { kind: 'run-running' as const, observedAt: at } } }
  const rejoin = vi.spyOn(f.client, 'rejoinAgentInputWaiting'), runtime = vi.spyOn(f.services.ingress!, 'inspectInputRuntime')
  const originalRead = f.client.readAgentSession.bind(f.client)
  let readMode: 'normal' | 'missing' | 'unavailable' = 'normal'
  const read = vi.spyOn(f.client, 'readAgentSession').mockImplementation(async id => {
    if (id === sid && readMode === 'missing') return null
    if (id === sid && readMode === 'unavailable') throw new AgentMuxError('PRIVATE_SESSION_OBSERVATION', 'AGENT_SESSION_STORE_READ_UNCONFIRMED')
    return await originalRead(id)
  }), currentRuntime = vi.spyOn(f.client, 'runtimeSubject')
  const store = new MoteChatStore(f.services.database!), configuration = store.configuration(f.target.spaceId)
  const admissions = records.map(row => store.admissionByIngress(row.ingressId))
  async function report(continuity: 'confirmed' | 'unconfirmed' | 'unavailable', target: 'original' | 'changed' | 'missing' | 'unavailable') {
    runtime.mockClear(); read.mockClear(); currentRuntime.mockClear()
    const value = await f.sdk.call('space.mote.chat.diagnose', { target: f.target })
    expect(value.incoming!.rows).toHaveLength(2)
    for (const row of value.incoming!.rows) expect(row.input.runtime, 'canonical original-target relationship must not borrow unrelated Run history')
      .toMatchObject({ target, continuity })
    expect(runtime).toHaveBeenCalledOnce()
    expect(read.mock.calls.filter(call => call[0] === sid)).toHaveLength(1)
    expect(currentRuntime).toHaveBeenCalledExactlyOnceWith({ kind: 'terminal-run', runId: frozen.expectedRun.runId })
    return value
  }
  await report('confirmed', 'original')
  const { continuity: _continuity, ...withoutLink } = resumed
  await f.store.compareAndSwapMetadata(initial, withoutLink)
  await report('unconfirmed', 'changed')
  const retiredOnly = (await f.store.readMetadata(sid))!
  await f.store.compareAndSwapMetadata(retiredOnly, { ...retiredOnly, continuity: { ...resumed.continuity!, operationId: 'diagnosis-wrong-native', nativeTarget: { ...nativeTarget, sessionId: 'different-native-target' } } })
  await report('unconfirmed', 'changed')
  const mismatch = (await f.store.readMetadata(sid))!
  await f.store.compareAndSwapMetadata(mismatch, { ...mismatch, continuity: { ...resumed.continuity!, operationId: 'diagnosis-ambiguous-native' },
    continuityOperations: { 'diagnosis-wrong-native': mismatch.continuity!, 'diagnosis-ambiguous-native': { ...resumed.continuity!, operationId: 'diagnosis-ambiguous-native' } } })
  await report('unconfirmed', 'changed')
  const ambiguous = (await f.store.readMetadata(sid))!, confirmedRun = { runId: 'diagnosis-confirmed-successor' }
  await f.store.compareAndSwapMetadata(ambiguous, { ...ambiguous, run: confirmedRun,
    nativeBinding: { source: 'semantic-resume-target', run: confirmedRun, observedAt: at },
    continuity: { ...resumed.continuity!, operationId: 'diagnosis-confirmed', newRun: confirmedRun } })
  await report('confirmed', 'changed')
  const confirmed = (await f.store.readMetadata(sid))!
  await f.store.compareAndSwapMetadata(confirmed, { ...confirmed, hostId: 'different-host' })
  await report('unconfirmed', 'changed')
  const foreign = (await f.store.readMetadata(sid))!
  await f.store.compareAndSwapMetadata(foreign, { ...initial, updatedAt: foreign.updatedAt + 1 })
  readMode = 'missing'
  await report('unavailable', 'missing')
  readMode = 'unavailable'
  const unavailable = await report('unavailable', 'unavailable')
  expect(JSON.stringify(unavailable)).not.toContain('PRIVATE_SESSION_OBSERVATION')
  read.mockRestore()
  expect((await f.records()).map(row => row.input)).toEqual(records.map(row => row.input))
  expect(records.map(row => store.admissionByIngress(row.ingressId))).toEqual(admissions); expect(store.configuration(f.target.spaceId)).toEqual(configuration)
  expect(rejoin).not.toHaveBeenCalled(); expect(f.start).toHaveBeenCalledOnce(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect(f.wire.effects).toHaveLength(0)
}, 20_000)

it('keeps an actual dispatch-authorized unknown receipt closed without target reads or replay', async () => {
  const f = await fixture(1, 60_000, 'headless', false, 'claude', undefined, undefined, 'feishu', 'local', undefined, true)
  expect(await f.wire.post(f.message('original-unknown'))).toBe(202)
  const record = await f.claimed('original-unknown')
  await vi.waitFor(async () => {
    const receipt = (await f.services.ingress!.inspect({ ingressId: record.ingressId })).inputReceipt
    expect(receipt, JSON.stringify({ status: receipt?.status, waiting: receipt?.control.waiting, errors: f.submissionErrors }))
      .toMatchObject({ status: 'unknown', observation: 'closed', control: { state: 'dispatch-authorized' } })
  }, { timeout: 5_000 })
  await vi.waitFor(() => expect(f.nativeInputs()).toHaveLength(1), { timeout: 5_000 })
  const before = (await f.services.ingress!.inspect({ ingressId: record.ingressId })).inputReceipt!
  const correlation = before.admission!.admission!.native!.plan.clientCorrelation
  expect(nativeInputCorrelationKey(correlation!)).toEqual(before.key)
  // A queue consumer witnesses this input; the no-ACK transport receipt remains unknown.
  const history = await f.client.sessionHistoryPage(record.input!.agentSessionId, { limit: 5 })
  const consumer = history.items.find(item => item.conversation?.nativeInput?.clientCorrelation === correlation)
  expect(consumer?.conversation).toMatchObject({ nativeInput: { clientCorrelation: correlation, queuedSubmissionId: correlation }, adoptedInput: { key: before.key } })
  const after = (await f.services.ingress!.inspect({ ingressId: record.ingressId })).inputReceipt!
  expect(after).toEqual(before)
  expect(after.admission).toMatchObject({ nativeResult: { state: 'unknown', reason: 'native-outcome-unconfirmed' }, admission: { transport: 'native', native: { outcome: 'unknown' } } })
  const runtime = vi.spyOn(f.services.ingress!, 'inspectInputRuntime'), rejoin = vi.spyOn(f.client, 'rejoinAgentInputWaiting')
  const cli = await f.cli('diagnose', { target: f.target }, f.credentials(0))
  expect(cli.incoming.rows[0].input).toMatchObject({ status: 'unknown', controlState: 'dispatch-authorized', receiptObservation: 'closed', runtime: null })
  expect(runtime).not.toHaveBeenCalled(); expect(rejoin).not.toHaveBeenCalled()
  expect((await f.records())[0]!.input).toEqual(record.input)
  expect(f.nativeInputs()).toHaveLength(1); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect(f.start).toHaveBeenCalledOnce(); expect(f.wire.effects).toHaveLength(0)
}, 20_000)
