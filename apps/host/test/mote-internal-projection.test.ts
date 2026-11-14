import { afterEach, expect, it, vi } from 'vitest'
import { appendFile } from 'node:fs/promises'
import { createMoteConversationStartFixture } from './helpers/mote-conversation-start-fixture.js'
import { moteQuickBaseline } from '../../../packages/core/src/mote/preferences.js'

const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function record(value: unknown) { if (process.env.MOTE_PROJECTION_FACTS) await appendFile(process.env.MOTE_PROJECTION_FACTS, JSON.stringify(value) + '\n') }
async function fixture(mode: 'enabled' | 'disabled' | 'paused' = 'enabled') {
  const f = await createMoteConversationStartFixture({ providerId: 'claude' }); closes.push(f.close)
  await record({ kind: 'private-root', root: f.h.root })
  await f.start('original-main'); await f.settledSetup('original-main')
  const main = await f.main.readCurrentMoteMain(f.target), reference = main.current!, session = (await f.h.client.readAgentSession(reference.sessionId))!
  const original = await f.rpc.call('space.mote.preferences.read', { kind: 'quick', target: f.target }), baseline = moteQuickBaseline(original)!
  expect((await f.rpc.call('space.mote.preferences.save', { kind: 'quick', target: f.target, operationId: 'original-policy', baseline,
    values: { ...baseline.defaults, conversationRollover: { kind: 'idle', idleMs: 60000 }, presence: { enabled: true, intervalMs: 1800000 } },
    destination: { kind: 'occurrence', displayWorkspaceId: reference.displayWorkspaceId, groupId: reference.groupId, tabId: reference.tabId, regionId: reference.regionId } })).status).toBe('saved')
  const before = (await f.h.store.readMetadata(session.agentSessionId))!
  const { nativeHandle: _native, nativeBinding: _binding, nativeSourceObservation: _source, nativeConfirmation: _confirmation, observedNativeHandle: _observed,
    nativeTurnEnds: _ends, nativeInteractionEnds: _interactions, nativeSubagents: _subagents, currentActivity: _activity, recoveryActivity: _recoveryActivity, ...withoutNative } = before
  await f.h.store.compareAndSwapMetadata(before, withoutNative); await f.h.inner.registry.load('local')
  const status = f.h.inner.kernel.status
  f.h.inner.kernel.status = vi.fn(async (id: string) => id === session.run.runId ? { ...await status(id), state: { type: 'exited', code: 0, signal: null }, acceptedInputBytes: null } : await status(id))
  const entry = (operationId: string) => ({ target: f.target, reference, expectedRoleRevision: main.roleRevision!, expectedRun: session.run, operationId })
  const unavailable = await f.rpc.call('space.mote.dialogue.recovery.ensure', entry('original-unavailable'))
  expect(unavailable.operation).toMatchObject({ kind: 'unavailable', reason: 'native-handle-unavailable', evidence: { kind: 'run-ended' } })
  if (mode === 'disabled') {
    const read = await f.rpc.call('space.mote.preferences.read', { kind: 'quick', target: f.target }), baseline = moteQuickBaseline(read)!
    expect((await f.rpc.call('space.mote.preferences.save', { kind: 'quick', target: f.target, operationId: 'disable-original-care', baseline,
      values: { ...baseline.defaults, presence: { enabled: false, intervalMs: 1800000 } },
      destination: { kind: 'occurrence', displayWorkspaceId: reference.displayWorkspaceId, groupId: reference.groupId, tabId: reference.tabId, regionId: reference.regionId } })).status).toBe('saved')
  }
  const maintenance = { status: 'paused' as const, schedule: null, issue: null }
  if (mode === 'paused') Object.assign(f.quickPorts, { maintenance: () => maintenance })
  // The qualified baseline above uses the real original Files/Main/Host owners.
  // Now hold only optional discovery; it cannot certify the original settings.
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), catalog = f.quickPorts.catalog, executors = f.quickPorts.executors
  const catalogRead = vi.spyOn(f.quickPorts, 'catalog').mockImplementation(async () => { await held; return catalog() })
  const executorRead = vi.spyOn(f.quickPorts, 'executors').mockImplementation(async () => { await held; return executors() })
  const quickRead = vi.spyOn(f.quick, 'read'), starts = f.h.started.length, writes = f.h.inner.kernel.input.mock.calls.length
  const ensure = vi.spyOn(f.h.client, 'ensureAgentContinuity')
  return { ...f, mainSnapshot: main, reference, session, entry, unavailable, maintenance, release, catalogRead, executorRead, quickRead, starts, writes, ensure }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function independent<T>(f: Fixture, call: () => Promise<T>) {
  const observed: { result?: { value: T } | { error: unknown } } = {}
  const pending = call().then(value => { observed.result = { value } }, error => { observed.result = { error } })
  try {
    // Observe a concrete completion or the actual unwanted discovery attempt.
    // A reverted flag fails on that attempt, never on a test timeout.
    await vi.waitFor(() => expect(observed.result !== undefined || f.catalogRead.mock.calls.length > 0 || f.executorRead.mock.calls.length > 0).toBe(true))
    expect(f.catalogRead, 'Internal Main facts must not ask for locations').not.toHaveBeenCalled()
    expect(f.executorRead, 'Internal Main facts must not ask for Executor choices').not.toHaveBeenCalled()
    const result = observed.result
    expect(result).toBeDefined()
    if (!result) throw Error('The original public operation has not completed')
    return result
  } finally { f.release(); await pending }
}
function unchanged(f: Fixture) {
  expect(f.h.started).toHaveLength(f.starts); expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(f.writes); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
}

it('Main entry completes against original unavailable facts while unrelated location and Executor discovery is held', async () => {
  const f = await fixture(), input = f.entry('later-explicit-entry'), observed = await independent(f, () => f.rpc.call('space.mote.dialogue.recovery.ensure', input))
  expect('value' in observed).toBe(true)
  if (!('value' in observed)) throw observed.error
  expect(observed.value.operation).toMatchObject({ kind: 'unavailable', reason: 'native-handle-unavailable', previousRun: f.session.run, operationId: input.operationId })
  expect(f.quickRead).toHaveBeenCalledWith({ kind: 'quick', target: f.target, includeChoices: false }); unchanged(f)
  await record({ kind: 'entry', input, result: observed.value, discovery: { catalog: f.catalogRead.mock.calls.length, executors: f.executorRead.mock.calls.length }, starts: f.h.started.length, writes: f.h.inner.kernel.input.mock.calls.length })
})

it.each(['disabled', 'paused'] as const)('Main entry preserves the original %s refusal without optional discovery', async mode => {
  const f = await fixture(mode), observed = await independent(f, () => f.rpc.call('space.mote.dialogue.recovery.ensure', f.entry('explicit-after-' + mode)))
  expect('error' in observed).toBe(true)
  if (!('error' in observed)) throw Error('Expected the original explicit maintenance refusal')
  expect(observed.error).toMatchObject({ code: 'MOTE_MAIN_RECOVERY_PAUSED' }); expect(f.ensure).not.toHaveBeenCalled(); unchanged(f)
  const read = await f.rpc.call('space.mote.preferences.read', { kind: 'quick', target: f.target, includeChoices: false })
  if (mode === 'disabled') expect(read.defaults?.presence?.enabled).toBe(false)
  else expect(read.maintenance).toEqual(f.maintenance)
  await record({ kind: 'refusal', mode, code: (observed.error as { code: string }).code, defaults: read.defaults, maintenance: read.maintenance, ensureCalls: f.ensure.mock.calls.length })
})

it('new Query evaluation returns its exact original due without optional discovery or another Start/input', async () => {
  const f = await fixture(), input = { target: f.target, expectedRoleRevision: f.mainSnapshot.roleRevision!, input: { agentSessionId: f.session.agentSessionId,
    expectedRun: f.session.run, operationId: 'separately-new-query', prompt: 'New explicit question only.', admissionIntent: { kind: 'manual-actor' as const }, execution: 'immediate' as const } }
  const observed = await independent(f, () => f.rpc.call('space.mote.dialogue.input.submit', input))
  if (!('value' in observed)) throw observed.error
  expect(observed.value).toMatchObject({ route: null, record: null, input: null, disposition: 'rollover-required', rollover: { status: 'due', decision: {
    policy: { kind: 'continuity-unavailable', idleMs: 60000 }, queryOperationId: input.input.operationId, expectedRoleRevision: f.mainSnapshot.roleRevision,
    continuity: { operationId: f.unavailable.operation!.operationId, previousRun: f.session.run, reason: 'native-handle-unavailable' } } } })
  expect(f.quickRead).toHaveBeenCalledWith({ kind: 'quick', target: f.target, includeChoices: false }); expect(f.ensure).not.toHaveBeenCalled(); unchanged(f)
  await record({ kind: 'due', input, result: observed.value, source: f.unavailable.operation, discovery: { catalog: f.catalogRead.mock.calls.length, executors: f.executorRead.mock.calls.length }, starts: f.h.started.length, writes: f.h.inner.kernel.input.mock.calls.length })
})

it('public requested full preferences still performs original location and Executor discovery', async () => {
  const f = await fixture(), observed: { result?: Awaited<ReturnType<typeof f.quick.read>> } = {}
  const input = { kind: 'quick' as const, target: f.target }, pending = f.rpc.call('space.mote.preferences.read', input).then(value => {
    if (value.kind !== 'quick') throw Error('The original public request returned another projection')
    observed.result = value
  })
  try {
    await vi.waitFor(() => { expect(f.catalogRead).toHaveBeenCalledOnce(); expect(f.executorRead).toHaveBeenCalledOnce() })
    expect(observed.result).toBeUndefined(); f.release(); await pending
    const result = observed.result
    expect(result?.choices?.executors?.some(item => item.id === 'saved')).toBe(true)
    expect(result?.choices?.destinations?.length).toBeGreaterThan(0); expect(f.quickRead).toHaveBeenCalledWith(input); unchanged(f)
    await record({ kind: 'public-discovery', input, choices: result?.choices, discovery: { catalog: f.catalogRead.mock.calls.length, executors: f.executorRead.mock.calls.length } })
  } finally { f.release(); await pending }
})
