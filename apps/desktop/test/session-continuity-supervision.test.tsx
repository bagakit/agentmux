// @vitest-environment happy-dom
import { webcrypto } from 'node:crypto'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '@agentmux/core/agent-session-continuity'
import type { AgentMuxContinuityControlInput, AgentMuxContinuityControlResult, AgentMuxContinuityOperation, AgentMuxAgentSession } from '@agentmux/core'
import { ContinuitySupervisionNotice } from '../src/renderer/src/components/ContinuitySupervisionNotice'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { continuitySupervisionPresentation, currentContinuitySupervision } from '../src/renderer/src/lib/continuity-supervision'
import { continuityControlKey } from '../src/renderer/src/lib/continuity-control-intent'
import { sessionServiceNotices } from '../src/renderer/src/lib/session-service-notices'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const routed = (input: AgentMuxContinuityControlInput) => ({ hostId: 'local', result: result(input) })
const dom = composerDOM(), key = continuityControlKey('local', 'original')
function fixture(phase: NonNullable<AgentMuxContinuityOperation['supervision']>['phase'] = 'paused') {
  const session = composerSession('original'), nativeTarget = { kind: 'provider' as const, providerId: 'codex', sessionId: 'same-native' }
  const root: AgentMuxContinuityOperation = { operationId: 'original-intent', agentSessionId: session.id, trigger: 'startup',
    policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY }, previousRun: { runId: 'previous-run' }, newRun: { runId: 'first-attempt' },
    nativeTarget, admittedAt: _historyFixtureEpoch(0, 0, 1), observedAt: _historyFixtureEpoch(0, 0, 2), rechecks: 0, kind: 'resumed', reason: 'interrupted-working',
    evidence: { kind: 'run-ended', state: 'interrupted', observedAt: _historyFixtureEpoch(0, 0, 1) },
    previousInput: { scope: 'typed-prompt', outcome: 'unknown', key: { kind: 'prompt', agentSessionId: session.id, expectedRun: { runId: 'previous-run' }, submissionId: 'original-unknown-input' } },
    supervision: { phase, activeAttemptOperationId: 'context-only-child', attemptCount: 2, attemptLimit: 2, observedAt: _historyFixtureEpoch(0, 0, 3), reason: 'retry-budget-exhausted',
      process: { run: { runId: 'first-attempt' }, state: 'exited', exitCode: 7, observedAt: _historyFixtureEpoch(0, 0, 2) } } }
  const child: AgentMuxContinuityOperation = { ...root, operationId: 'context-only-child', intentOperationId: root.operationId,
    previousRun: root.newRun!, newRun: session.control.run, supervision: undefined, previousInput: undefined }
  return { ...session, nativeHandle: nativeTarget, continuity: child, continuityOperations: { [root.operationId]: root, [child.operationId]: child } }
}
function result(input: AgentMuxContinuityControlInput, session = fixture()): AgentMuxContinuityControlResult {
  const cancelled = input.action === 'cancel', root = session.continuityOperations['original-intent']!
  return { state: 'active', session: { kind: 'agent', agentSessionId: session.id, hostId: session.hostId, run: session.control.run,
    continuity: session.continuity, continuityOperations: session.continuityOperations } as AgentMuxAgentSession,
    receipt: { request: structuredClone(input), outcome: cancelled ? 'cancelled' : 'continued', reason: cancelled ? 'explicit-cancel' : 'explicit-continue',
      activeAttemptOperationId: root.supervision!.activeAttemptOperationId, attemptCount: root.supervision!.attemptCount,
      attemptLimitBefore: 2, attemptLimitAfter: cancelled ? 2 : 2 + input.additionalAttempts, phaseAtCommit: cancelled ? 'cancelled' : 'observing', observedAt: _historyFixtureEpoch(0, 0, 4) } }
}
let dispose: (() => void) | undefined
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); localStorage.clear()
  vi.spyOn(api.config, 'get').mockResolvedValue(composerConfig)
  vi.spyOn(api.providers, 'list').mockResolvedValue({ catalog: [], warnings: [] } as never)
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'refresh').mockImplementation(async () => useAppStore.getState().sessions[0]!)
  dispose = await useAppStore.getState().initialize()
  const session = fixture(), tab = createWorkbenchTab('original-tab', { regionId: 'original-region', kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: session.id })
  useAppStore.setState({ sessions: [session], continuityControlIntents: {}, closingWorkbenchViews: {},
    tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout('original-group', [tab.id]) },
    agentComposerDrafts: { original: 'Original independent unsent draft' }, agentSteerQueues: {}, noticeReadReceipts: {} })
})
afterEach(() => { dispose?.(); dispose = undefined })
const original = () => useAppStore.getState().sessions[0] as ReturnType<typeof fixture>
async function click(text: string) {
  const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text)
  expect(button, text).toBeDefined(); expect(button!.disabled).toBe(false)
  await act(async () => { button!.click(); await new Promise(resolve => setTimeout(resolve, 0)) })
}

it('joins the current child to its original input and keeps running separate from confirmed context', async () => {
  const session = fixture('observing'), projection = continuitySupervisionPresentation(session)!
  expect(projection).not.toBeNull()
  expect(projection.root.operationId).toBe('original-intent'); expect(projection.attempt.intentOperationId).toBe('original-intent')
  expect(projection.detail).toContain('Attempt 2 of 2'); expect(projection.contextDetail).toContain('not yet confirmed')
  expect(projection.processDetail).toContain('does not confirm task progress'); expect(projection.failure).toContain('code 7')
  expect(projection.childInput).toContain('No earlier input, reminder or continuation is resent')
  const notice = sessionServiceNotices(session).find(item => item.id === 'continuity-supervision')!
  expect(notice.notice.notice.restore).toContain('original-unknown-input')
  await dom.render(<><ContinuitySupervisionNotice session={session} /><AgentSessionComposer sessionId="original" /></>)
  expect(dom.container.textContent).toContain('original-unknown-input'); expect(dom.draft('original')).toBe('Original independent unsent draft')
  expect(dom.container.querySelector('[contenteditable="true"]')).not.toBeNull()
})

it('joins native locators without allowing an old target or evidence to confirm the current conversation', () => {
  const session = fixture('settled'), root = session.continuityOperations['original-intent']!
  root.previousInput = { scope: 'typed-prompt', outcome: 'none' }
  root.supervision!.contextEvidence = { source: 'native-hook', run: session.control.run, nativeTarget: session.nativeHandle,
    hookReceiptId: 'context-receipt', observedAt: _historyFixtureEpoch(0, 0, 5) }
  expect(continuitySupervisionPresentation(session)).toBeNull()
  session.nativeHandle = { ...session.nativeHandle, transcriptPath: 'current-locator' }
  expect(continuitySupervisionPresentation(session)).toBeNull() // SID-only evidence may gain its first locator.
  root.nativeTarget = { ...root.nativeTarget!, transcriptPath: 'original-locator' }
  const changed = continuitySupervisionPresentation(session)
  expect(changed).not.toBeNull()
  expect(changed!.contextDetail).toContain('not yet confirmed'); expect(changed!.canCancel).toBe(false); expect(changed!.canContinue).toBe(false)
  root.supervision!.phase = 'paused'
  expect(continuitySupervisionPresentation(session)!.canContinue).toBe(false)
  root.nativeTarget = { ...root.nativeTarget, transcriptPath: 'current-locator' }
  root.supervision!.contextEvidence!.nativeTarget = { ...session.nativeHandle, transcriptPath: 'foreign-locator' }
  expect(continuitySupervisionPresentation(session)!.contextDetail).toContain('not yet confirmed')
  root.supervision!.contextEvidence!.nativeTarget = session.nativeHandle
  expect(continuitySupervisionPresentation(session)!.contextDetail).toContain('confirmed by its native receipt')
  root.supervision!.contextEvidence!.run = { runId: 'foreign-run' }
  expect(continuitySupervisionPresentation(session)!.contextDetail).toContain('not yet confirmed')
  root.nativeTarget = { kind: 'provider', providerId: 'codex', sessionId: 'same-native' }
  session.continuityOperations['context-only-child']!.nativeTarget = { ...session.nativeHandle, transcriptPath: 'different-active-locator' }
  expect(continuitySupervisionPresentation(session)!.canContinue).toBe(false)
  session.continuityOperations['context-only-child']!.nativeTarget = { ...session.nativeHandle }
  delete (session as Partial<typeof session>).nativeHandle
  expect(continuitySupervisionPresentation(session)!.canContinue).toBe(false)
})

it('reads only the current intent and leaves unrelated or fully normal Sessions undisturbed', () => {
  expect(currentContinuitySupervision(composerSession())).toBeNull()
  const session = fixture()
  session.continuityOperations = new Proxy(session.continuityOperations, { ownKeys() { throw new Error('No historical scan may select the current intent') } })
  expect(currentContinuitySupervision(session)?.root.operationId).toBe('original-intent')
  expect(sessionServiceNotices(session).find(item => item.id === 'continuity-supervision')).toBeDefined()
  session.continuity = { ...session.continuity!, newRun: { runId: 'unrelated-run' } }
  session.continuityOperations = { 'original-intent': session.continuityOperations['original-intent']!, 'context-only-child': session.continuity }
  expect(currentContinuitySupervision(session)).toBeNull()
})

it('commits the original packet before dispatch and reuses it after an unknown reply and rehydration', async () => {
  const calls: AgentMuxContinuityControlInput[] = [], dispatchSnapshots: any[] = [], flush = vi.mocked(api.ui.requestStorageFlush)
  const control = vi.spyOn(api.sessions, 'controlContinuity').mockImplementation(async (_host, input) => {
    calls.push(structuredClone(input))
    dispatchSnapshots.push(JSON.parse(localStorage.getItem(useAppStore.persist.getOptions().name)!))
    if (calls.length === 1) throw new Error('Original response lost')
    return routed(input)
  })
  await expect(useAppStore.getState().controlSessionContinuity('original', 'original-intent', 'continue', 2)).rejects.toThrow('Original response lost')
  expect(dispatchSnapshots[0], 'original packet durable before dispatch').not.toBeNull()
  expect(dispatchSnapshots[0].state, 'original authored state durable before dispatch').toBeDefined()
  const packet = structuredClone(calls[0]!), operationId = packet.operationId
  expect(dispatchSnapshots[0].state.continuityControlIntents[key]?.[operationId]?.request).toEqual(packet)
  expect(flush).toHaveBeenCalled(); expect(useAppStore.getState().continuityControlIntents[key]![operationId]!.request).toEqual(packet)
  useAppStore.setState({ continuityControlIntents: {} }); await useAppStore.persist.rehydrate()
  expect(useAppStore.getState().continuityControlIntents[key]![operationId]!.request).toEqual(packet)
  const retry = useAppStore.getState().reconcileSessionContinuityControl('local', 'original', operationId)
  await expect(retry).resolves.toMatchObject({ receipt: { request: packet } })
  expect(calls).toEqual([packet, packet]); expect(control).toHaveBeenCalledTimes(2)
  expect(dispatchSnapshots[1], 'reconciled original packet durable before dispatch').not.toBeNull()
  expect(dispatchSnapshots[1].state.continuityControlIntents[key]?.[operationId]?.request).toEqual(packet)
  expect(useAppStore.getState().continuityControlIntents[key]).toBeUndefined()
  expect(dom.draft('original')).toBe('Original independent unsent draft')
})

it('keeps independent cancellation reachable while the original continuation reader never returns', async () => {
  let release: ((value: ReturnType<typeof routed>) => void) | undefined
  const packets: AgentMuxContinuityControlInput[] = [], stop = vi.spyOn(api.sessions, 'stop'), submit = vi.spyOn(api.sessions, 'submitPrompt')
  const control = vi.spyOn(api.sessions, 'controlContinuity').mockImplementation(async (_host, input) => {
    packets.push(structuredClone(input))
    if (input.action === 'continue') return await new Promise(resolve => { release = resolve })
    return routed(input)
  })
  await dom.render(<ContinuitySupervisionNotice session={original()} />)
  await click('Continue recovery')
  expect(control).toHaveBeenCalledTimes(1); const continued = structuredClone(packets[0]!)
  await click('Cancel automatic recovery')
  expect(control).toHaveBeenCalledTimes(2); expect(packets[1]).toMatchObject({ action: 'cancel', agentSessionId: 'original', intentOperationId: 'original-intent' })
  expect(packets[1]!.operationId).not.toBe(continued.operationId); expect(packets[1]).not.toHaveProperty('additionalAttempts')
  expect(useAppStore.getState().continuityControlIntents[key]?.[continued.operationId]).toBeDefined()
  expect(useAppStore.getState().continuityControlIntents[key]![continued.operationId]!.request).toEqual(continued)
  expect(dom.container.textContent).toContain('Check original continue control')
  expect(stop).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled()
  expect(original().processState).toBe('running'); expect(dom.draft('original')).toBe('Original independent unsent draft')
  await act(async () => { release!(routed(continued)); await new Promise(resolve => setTimeout(resolve, 0)) })
})

it('preserves the packet when durable authoring fails and refuses malformed saved packets without guessing a body', async () => {
  vi.mocked(api.ui.requestStorageFlush).mockRejectedValue(new Error('Original UI storage unavailable'))
  const control = vi.spyOn(api.sessions, 'controlContinuity')
  await expect(useAppStore.getState().controlSessionContinuity('original', 'original-intent', 'cancel')).rejects.toThrow('Original UI storage unavailable')
  expect(control).not.toHaveBeenCalled(); expect(Object.values(useAppStore.getState().continuityControlIntents[key]!)).toHaveLength(1)
  useAppStore.setState({ continuityControlIntents: { [key]: { damaged: { hostId: 'local', request: { action: 'continue' } } as never } } })
  await expect(useAppStore.getState().reconcileSessionContinuityControl('local', 'original', 'damaged')).rejects.toThrow('could not be read')
  expect(control).not.toHaveBeenCalled(); expect(useAppStore.getState().continuityControlIntents[key]).toHaveProperty('damaged')
})

it('does not turn a committed control into unknown when canonical presentation fails or resurrect a closed workface', async () => {
  const control = vi.spyOn(api.sessions, 'controlContinuity').mockImplementation(async (_host, input) => routed(input))
  vi.mocked(api.sessions.refresh).mockRejectedValue(new Error('Original display read failed'))
  const before = original(), tabs = useAppStore.getState().tabs
  const cancelled = useAppStore.getState().controlSessionContinuity('original', 'original-intent', 'cancel')
  await expect(cancelled).resolves.toMatchObject({ receipt: { outcome: 'cancelled' } })
  expect(control).toHaveBeenCalledTimes(1); expect(useAppStore.getState().continuityControlIntents[key]).toBeUndefined()
  expect(original()).toBe(before); expect(useAppStore.getState().tabs).toEqual(tabs)
  let reply: ((value: ReturnType<typeof fixture>) => void) | undefined
  vi.mocked(api.sessions.refresh).mockImplementation(() => new Promise(resolve => { reply = resolve }))
  const second = useAppStore.getState().controlSessionContinuity('original', 'original-intent', 'cancel')
  await vi.waitFor(() => expect(reply).toBeDefined())
  useAppStore.setState({ tabs: {}, sessions: [] })
  reply!({ ...before, control: { ...before.control, run: { runId: 'late-read-run' } } })
  await expect(second).resolves.toMatchObject({ receipt: { outcome: 'cancelled' } })
  expect(useAppStore.getState().sessions).toEqual([]); expect(useAppStore.getState().tabs).toEqual({})
})

it('settles a normative original refusal without blocking new current-Run authorization and keeps both original packets', async () => {
  const packets: AgentMuxContinuityControlInput[] = []
  vi.spyOn(api.sessions, 'controlContinuity').mockImplementation(async (_host, input) => { packets.push(structuredClone(input)); throw Object.assign(new Error('Exact original Run changed'), { code: 'STALE_AGENT_SESSION' }) })
  await expect(useAppStore.getState().controlSessionContinuity('original', 'original-intent', 'continue', 1)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  const first = packets[0]!, after = structuredClone(original()), child = after.continuityOperations['context-only-child']!
  after.control.run = { runId: 'new-current-run' }; child.newRun = after.control.run; after.continuity = child
  useAppStore.setState({ sessions: [after] })
  await expect(useAppStore.getState().controlSessionContinuity('original', 'original-intent', 'continue', 2)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect(packets).toHaveLength(2); expect(packets[1]!.operationId).not.toBe(first.operationId); expect(packets[1]!.expectedRun).toEqual(after.control.run)
  expect(useAppStore.getState().continuityControlIntents[key]![first.operationId]).toMatchObject({ request: first, rejection: { code: 'STALE_AGENT_SESSION' } })
  expect(Object.keys(useAppStore.getState().continuityControlIntents[key]!)).toHaveLength(2)
})

it('accepts Core-local results through the captured remote route and rejects another route or original packet', async () => {
  const remote = fixture(); remote.hostId = 'saved-remote'; remote.control.hostId = 'saved-remote'; useAppStore.setState({ sessions: [remote] })
  const control = vi.spyOn(api.sessions, 'controlContinuity').mockImplementation(async (hostId, input) => ({ hostId, result: result(input) }))
  const accepted = useAppStore.getState().controlSessionContinuity('original', 'original-intent', 'cancel')
  await expect(accepted).resolves.toMatchObject({ state: 'active', session: { hostId: 'local' } })
  control.mockImplementation(async (_hostId, input) => ({ hostId: 'foreign-route', result: result(input) }))
  await expect(useAppStore.getState().controlSessionContinuity('original', 'original-intent', 'cancel')).rejects.toThrow('another Host route')
  const pending = Object.values(useAppStore.getState().continuityControlIntents[continuityControlKey('saved-remote', 'original')]!)[0]!
  control.mockImplementation(async (hostId, input) => ({ hostId, result: result({ ...input, operationId: 'foreign-operation' }) }))
  await expect(useAppStore.getState().reconcileSessionContinuityControl('saved-remote', 'original', pending.request.operationId)).rejects.toMatchObject({ code: 'INVALID_AGENT_CONTINUITY_CONTROL' })
  expect(useAppStore.getState().continuityControlIntents[continuityControlKey('saved-remote', 'original')]![pending.request.operationId]!.request).toEqual(pending.request)
})

it('keeps a locally invalid result unknown instead of promoting parser failure to a terminal owner refusal', async () => {
  const packets: AgentMuxContinuityControlInput[] = []
  vi.spyOn(api.sessions, 'controlContinuity').mockImplementation(async (hostId, input) => { packets.push(structuredClone(input)); return { hostId, result: result({ ...input, operationId: 'bad-response-identity' }) } })
  await expect(useAppStore.getState().controlSessionContinuity('original', 'original-intent', 'continue', 2)).rejects.toMatchObject({ code: 'INVALID_AGENT_CONTINUITY_CONTROL' })
  const request = packets[0]!, retained = useAppStore.getState().continuityControlIntents[key]![request.operationId]!
  expect(retained.request).toEqual(request); expect(retained.rejection).toBeUndefined()
  await expect(useAppStore.getState().controlSessionContinuity('original', 'original-intent', 'continue', 3)).rejects.toThrow('unconfirmed')
  expect(packets).toHaveLength(1)
  await expect(useAppStore.getState().controlSessionContinuity('original', 'original-intent', 'cancel')).rejects.toMatchObject({ code: 'INVALID_AGENT_CONTINUITY_CONTROL' })
  expect(packets).toHaveLength(2); expect(packets[1]!.action).toBe('cancel')
  expect(useAppStore.getState().continuityControlIntents[key]![request.operationId]!.request).toEqual(request)
})

it('allows same-packet recheck and a later lawful control while the first reader is still pending', async () => {
  let release: ((value: ReturnType<typeof routed>) => void) | undefined
  const packets: AgentMuxContinuityControlInput[] = []
  vi.spyOn(api.sessions, 'controlContinuity').mockImplementation(async (hostId, input) => {
    packets.push(structuredClone(input))
    if (packets.length === 1) return await new Promise(resolve => { release = resolve })
    return { hostId, result: result(input) }
  })
  await dom.render(<ContinuitySupervisionNotice session={original()} />)
  await click('Continue recovery'); const first = structuredClone(packets[0]!)
  await click('Check original continue control')
  expect(packets).toEqual([first, first]); expect(useAppStore.getState().continuityControlIntents[key]).toBeUndefined()
  expect(dom.container.textContent).toContain('Earlier continue request receipt confirmed; current recovery status is shown above.')
  await click('Continue recovery')
  expect(packets).toHaveLength(3); expect(packets[2]!.operationId).not.toBe(first.operationId)
  await act(async () => { release!(routed(first)); await new Promise(resolve => setTimeout(resolve, 0)) })
})
