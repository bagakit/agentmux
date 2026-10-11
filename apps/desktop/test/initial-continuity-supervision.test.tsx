// @vitest-environment happy-dom
import { webcrypto } from 'node:crypto'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '@agentmux/core/agent-session-continuity'
import type { AgentMuxAgentSession, AgentMuxContinuityControlInput, AgentMuxContinuityControlResult, AgentMuxContinuityOperation } from '@agentmux/core'
import { ContinuitySupervisionNotice } from '../src/renderer/src/components/ContinuitySupervisionNotice'
import { currentContinuitySupervision, continuitySupervisionPresentation } from '../src/renderer/src/lib/continuity-supervision'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const dom = composerDOM()
function fixture(): ReturnType<typeof composerSession> & { continuity: AgentMuxContinuityOperation; continuityOperations: Record<string, AgentMuxContinuityOperation> } {
  const session = composerSession('original')
  const root: AgentMuxContinuityOperation = { operationId: 'waiting-intent', agentSessionId: session.id, trigger: 'startup',
    policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY }, previousRun: session.control.run,
    admittedAt: _historyFixtureEpoch(0, 0, 1), observedAt: _historyFixtureEpoch(0, 0, 2), rechecks: 0, kind: 'pending', reason: 'active-delay', nextActionAt: _historyFixtureEpoch(0, 120, 0),
    evidence: { kind: 'run-ended', state: 'exited', exitCode: 7, observedAt: _historyFixtureEpoch(0, 0, 1) },
    supervision: { phase: 'observing', activeAttemptOperationId: 'waiting-intent', attemptCount: 0, attemptLimit: 4,
      observedAt: _historyFixtureEpoch(0, 0, 2), reason: 'initial-wait' } }
  return { ...session, processState: 'exited' as const, status: { state: 'exited' as const, source: 'run-process' as const, observedAt: _historyFixtureEpoch(0, 0, 1), exitCode: 7 },
    continuity: root, continuityOperations: { [root.operationId]: root } }
}
const original = () => useAppStore.getState().sessions[0] as ReturnType<typeof fixture>
function cancelled(input: AgentMuxContinuityControlInput): AgentMuxContinuityControlResult {
  const session = original(), root = session.continuityOperations['waiting-intent']!
  return { state: 'active', session: { kind: 'agent', agentSessionId: session.id, hostId: 'local', run: session.control.run,
    continuity: root, continuityOperations: session.continuityOperations } as AgentMuxAgentSession,
    receipt: { request: structuredClone(input), outcome: input.action === 'cancel' ? 'cancelled' : 'unchanged',
      reason: input.action === 'cancel' ? 'explicit-cancel' : 'already-active', activeAttemptOperationId: root.operationId,
      attemptCount: 0, attemptLimitBefore: 4, attemptLimitAfter: 4, phaseAtCommit: input.action === 'cancel' ? 'cancelled' : 'observing', observedAt: _historyFixtureEpoch(0, 0, 3) } }
}
let dispose: (() => void) | undefined
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); localStorage.clear()
  vi.spyOn(api.config, 'get').mockResolvedValue(composerConfig)
  vi.spyOn(api.providers, 'list').mockResolvedValue({ catalog: [], warnings: [] } as never)
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'refresh').mockImplementation(async () => original())
  dispose = await useAppStore.getState().initialize()
  const session = fixture(), tab = createWorkbenchTab('original-tab', { regionId: 'original-region', kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: session.id })
  useAppStore.setState({ sessions: [session], continuityControlIntents: {}, closingWorkbenchViews: {}, tabs: { [tab.id]: tab },
    layouts: { workspace: createWorkspaceLayout('original-group', [tab.id]) }, agentComposerDrafts: { original: 'Original unsent draft' }, noticeReadReceipts: {} })
})
afterEach(() => { dispose?.(); dispose = undefined })

it('shows an unstarted automatic intent and its original next check without inventing an attempt', async () => {
  const projection = continuitySupervisionPresentation(original())
  expect(projection).not.toBeNull(); expect(projection!.waitingForInitialAttempt).toBe(true)
  expect(currentContinuitySupervision(original())!.targetChanged).toBe(true)
  await dom.render(<ContinuitySupervisionNotice session={original()} />)
  expect(dom.container.textContent).toContain('Waiting for initial recovery')
  expect(dom.container.textContent).toContain('No recovery attempt has started.')
  expect(dom.container.textContent).toContain('active-delay · initial-wait')
  expect(dom.container.textContent).toContain('Next recovery check:')
  expect(dom.container.textContent).not.toContain('Next automatic attempt:')
  expect(dom.container.querySelector('[aria-label="Additional recovery attempts"]')).toBeNull()
  expect(dom.container.textContent).not.toContain('Continue recovery')
})

it('keeps mounted metadata cancellation reachable without native identity and sends the durable exact original packet', async () => {
  const packets: AgentMuxContinuityControlInput[] = [], saved: any[] = []
  const stop = vi.spyOn(api.sessions, 'stop'), input = vi.spyOn(api.sessions, 'submitPrompt')
  vi.spyOn(api.sessions, 'controlContinuity').mockImplementation(async (hostId, packet) => {
    packets.push(structuredClone(packet)); saved.push(JSON.parse(localStorage.getItem(useAppStore.persist.getOptions().name)!))
    return { hostId, result: cancelled(packet) }
  })
  const before = original(), tabs = useAppStore.getState().tabs
  await dom.render(<ContinuitySupervisionNotice session={before} />)
  const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === 'Cancel automatic recovery')
  expect(button, 'unconfirmed native identity must not remove metadata cancellation').toBeDefined(); expect(button!.disabled).toBe(false)
  await act(async () => { button!.click(); await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(packets).toHaveLength(1); expect(packets[0]).toMatchObject({ action: 'cancel', agentSessionId: 'original', intentOperationId: 'waiting-intent', expectedRun: before.control.run })
  expect(packets[0]).not.toHaveProperty('additionalAttempts')
  expect(saved[0], 'original cancel packet durable before dispatch').not.toBeNull()
  expect(JSON.stringify(saved[0].state.continuityControlIntents)).toContain(packets[0]!.operationId)
  expect(stop).not.toHaveBeenCalled(); expect(input).not.toHaveBeenCalled()
  expect(original()).toBe(before); expect(useAppStore.getState().tabs).toEqual(tabs); expect(dom.draft('original')).toBe('Original unsent draft')
  expect(dom.container.textContent).toContain('Original cancel request receipt confirmed')
})

it('keeps the zero-attempt pause truthful while the original metadata continuation can still reach its owner', async () => {
  original().continuity!.supervision!.phase = 'paused'; original().continuity!.reason = 'provider-unverified'
  original().continuity!.supervision!.reason = 'initial-policy-wait'
  const packets: AgentMuxContinuityControlInput[] = []
  vi.spyOn(api.sessions, 'controlContinuity').mockImplementation(async (hostId, packet) => {
    packets.push(structuredClone(packet)); return { hostId, result: cancelled(packet) }
  })
  await dom.render(<ContinuitySupervisionNotice session={original()} />)
  expect(dom.container.textContent).toContain('Initial recovery paused'); expect(dom.container.textContent).toContain('provider-unverified')
  expect(dom.container.textContent).not.toContain('Additional attempts')
  // This public metadata control remains valid despite the incomplete native observation.
  // Its receipt confirms the owner's decision, not a Native Start or task progress.
  await expect(useAppStore.getState().controlSessionContinuity('original', 'waiting-intent', 'continue', 1)).resolves.toMatchObject({ receipt: { outcome: 'unchanged', attemptCount: 0 } })
  expect(packets).toHaveLength(1); expect(packets[0]).toMatchObject({ action: 'continue', additionalAttempts: 1,
    agentSessionId: 'original', intentOperationId: 'waiting-intent', expectedRun: original().control.run })
})

it('does not apply the initial metadata exception to another Run, child, manual intent or admitted attempt', async () => {
  const session = original(), root = session.continuity!
  const control = vi.spyOn(api.sessions, 'controlContinuity')
  await expect(useAppStore.getState().controlSessionContinuity('original', 'different-intent', 'cancel')).rejects.toThrow('original recovery intent changed')
  root.agentSessionId = 'different-session'
  expect(currentContinuitySupervision(session)).toBeNull()
  await expect(useAppStore.getState().controlSessionContinuity('original', root.operationId, 'cancel')).rejects.toThrow('original recovery intent changed')
  root.agentSessionId = session.id
  for (const trigger of ['manual', 'input'] as const) {
    root.trigger = trigger; expect(currentContinuitySupervision(session)!.waitingForInitialAttempt).toBe(false)
    await expect(useAppStore.getState().controlSessionContinuity('original', root.operationId, 'cancel')).rejects.toThrow('original recovery intent changed')
  }
  root.trigger = 'startup'; root.newRun = session.control.run
  expect(currentContinuitySupervision(session)!.waitingForInitialAttempt).toBe(false)
  delete root.newRun; root.supervision!.attemptCount = 1
  expect(currentContinuitySupervision(session)!.waitingForInitialAttempt).toBe(false)
  root.supervision!.attemptCount = 0; root.supervision!.activeAttemptOperationId = 'other-child'
  session.continuityOperations['other-child'] = { ...root, operationId: 'other-child', intentOperationId: root.operationId, supervision: undefined }
  expect(currentContinuitySupervision(session)!.waitingForInitialAttempt).toBe(false)
  root.supervision!.activeAttemptOperationId = root.operationId; root.previousRun = { runId: 'another-run' }
  expect(currentContinuitySupervision(session)).toBeNull()
  expect(control).not.toHaveBeenCalled()
})

it('keeps a cancelled initial intent visibly cancelled while its native target remains unknown', async () => {
  original().continuity!.supervision!.phase = 'cancelled'; original().continuity!.supervision!.reason = 'explicit-control'
  delete original().continuity!.nextActionAt
  await dom.render(<ContinuitySupervisionNotice session={original()} />)
  expect(dom.container.textContent).toContain('Automatic recovery cancelled')
  expect(dom.container.textContent).toContain('No recovery attempt has started.')
  expect(dom.container.textContent).not.toContain('Waiting for initial recovery')
  expect(dom.container.textContent).not.toContain('Cancel automatic recovery')
  expect(dom.container.textContent).not.toContain('Next recovery check:')
})
