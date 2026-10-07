// @vitest-environment happy-dom
import { fixtureEpoch as _newTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import './helpers/goal-responsibility-product'
import { fixture, semantic, record, mount, settle, evidence, container } from './helpers/goal-responsibility-product'
import { act, createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { observeAgent } from '@agentmux/core'
import { demandExecutionReferences, type DemandDispatch, type DemandProgressInput } from '@agentmux/demand'
import type { GoalDelegationResult } from '@agentmux/core/goal-delegation'
import { RuntimeController } from '../src/main/runtime-controller'
import { GoalDelegationWork } from '../src/renderer/src/components/GoalDelegationWork'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { MoteCurrentWork } from '../src/renderer/src/components/MoteCurrentWork'
import { RegionCurrentDemand } from '../src/renderer/src/components/RegionCurrentDemand'
import { api } from '../src/renderer/src/lib/api'
import { currentDemandIndex, currentDemandKey, updateCurrentDemandIndex } from '../src/renderer/src/lib/goal-current-work'
import { applyGoalDelegationResult } from '../src/renderer/src/lib/goal-delegation-work'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
import { moteGoalContext } from '../src/renderer/src/lib/mote-goals'
import { useAppStore } from '../src/renderer/src/store'
import { PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { moteTopics, scratchWorkspace, seedMoteWorkface } from './fixtures/mote-workface'

describe('responsibility production owners, compiled public CLI and mounted consumers', () => {
  it('reads newly published execution after an early Domain event without detail, then renders exact finite/delegated responsibility and preserves drafts', async () => {
    const f = await fixture()
    const drafts = { original: 'Keep this unsent human draft' }, selection = 'goal'
    useAppStore.setState({ demands: { goal: record((await f.demands.get('goal'))!) }, agentComposerDrafts: drafts, selectedDemandId: selection })
    expect(f.read).not.toHaveBeenCalled()
    await f.finite(); await f.delegate('worker-a'); await f.delegate('worker-b')
    f.statuses.set('worker-c', semantic(f.metadata.get('worker-c')!, 'done'))
    const original = await f.delegate('worker-c')
    await f.flushMain()
    expect(original.result.responsibility.executions.map((row: { execution: { kind: string; operationId: string } }) => [row.execution.kind, row.execution.operationId]))
      .toEqual([['start', 'finite-start'], ['delegation', 'delegate-worker-a'], ['delegation', 'delegate-worker-b'], ['delegation', 'delegate-worker-c']])
    expect(f.read).not.toHaveBeenCalled()
    // Domain notifications arrived while Renderer still had no execution. The actual
    // business receipt adapter must now start one targeted owner read on publication.
    await f.publish()
    await vi.waitFor(() => expect(useAppStore.getState().demands.goal!.responsibility?.executions).toHaveLength(4))
    const loaded = useAppStore.getState().demands.goal!
    expect(loaded.responsibility!.executions.map(row => [row.binding, row.phase])).toEqual([
      ['confirmed', 'executing'], ['confirmed', 'executing'], ['confirmed', 'executing'], ['confirmed', 'stalled']])
    await mount(createElement('div', {}, createElement(GoalDelegationWork, { demand: loaded }),
      createElement(RegionCurrentDemand, { hostId: 'local', agentSessionId: 'worker-c' })))
    const detail = container.querySelector('[data-goal-responsibility="goal"]')!
    expect(detail.textContent).toContain('执行停滞'); expect(detail.textContent).toContain('worker-c')
    expect(detail.textContent).toContain('owner'); expect(container.querySelector('.region-current-demand')!.textContent).toContain('执行停滞')
    expect(useAppStore.getState().agentComposerDrafts).toBe(drafts); expect(useAppStore.getState().selectedDemandId).toBe(selection)
    const target = detail.querySelector<HTMLButtonElement>('button[title="Session worker-c · Host local"]')!
    expect(target).not.toBeNull(); await act(async () => target.click())
    expect(api.ui.openObjectLink).toHaveBeenCalledWith('amux://agent/worker-c')
    const readCount = f.read.mock.calls.length
    await act(async () => f.emit('stranger')); await settle(); expect(f.read).toHaveBeenCalledTimes(readCount)
    expect(f.nativeInputs.map(input => input.messageId)).toEqual(['source-worker-a', 'source-worker-b', 'source-worker-c'])
    expect((await f.demands.get('goal'))!).toMatchObject({ status: 'in_progress', description: 'Original human task\nkept verbatim', alignment: { confirmedAt: null } })
    expect(f.stop).not.toHaveBeenCalled()
    await evidence('early-event-real-cli-mounted-responsibility', await f.proof())
  }, 30_000)

  it('prioritizes a later stalled execution in actual list and Mote compact consumers and exposes every hidden attention count', async () => {
    const f = await fixture(); await f.finite(); await f.delegate('worker-a'); await f.delegate('worker-b')
    f.statuses.set('worker-c', semantic(f.metadata.get('worker-c')!, 'done')); await f.delegate('worker-c'); await f.publish()
    useAppStore.setState({ selectedDemandId: null })
    await mount(createElement(GlobalBoardSurface))
    const compact = container.querySelector('.goals-row [data-goal-responsibility="goal"]')!
    expect(compact).not.toBeNull()
    expect([...compact.querySelectorAll('.goal-responsibility__phase')].map(node => node.textContent)).toEqual(['执行停滞', '执行中'])
    expect(compact.querySelector('.goal-responsibility__execution')!.textContent).toContain('worker-c')
    f.statuses.set('finite-worker', semantic(f.metadata.get('finite-worker')!, 'error'))
    f.statuses.set('worker-a', semantic(f.metadata.get('worker-a')!, 'error'))
    await act(async () => {
      f.emit('finite-worker'); f.emit('worker-a')
      await vi.waitFor(() => expect(useAppStore.getState().demands.goal!.responsibility!.executions.filter(row => row.alert !== null)).toHaveLength(3))
    })
    expect(compact.textContent).toContain('另有 1 项责任待处理')
    expect(compact.querySelectorAll('.goal-responsibility__phase--attention')).toHaveLength(2)
    const goal = useAppStore.getState().demands.goal!
    await mount(null)
    await act(async () => seedMoteWorkface())
    const scope = { workspace: scratchWorkspace, topic: moteTopics.find(item => item.id === PMO_TEAMS_TOPIC_ID)!, rootPath: scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID) }
    const context = moteGoalContext(useAppStore.getState(), scope); expect(context.contentRef).not.toBeNull()
    await act(async () => {
      await f.demands.update('goal', { contentRefs: [context.contentRef!] })
      useAppStore.setState({ demands: { goal: { ...goal, contentRefs: [context.contentRef!] } } })
    })
    await mount(createElement(MoteCurrentWork, { scope }))
    const mote = container.querySelector('.mote-current-work [data-goal-responsibility="goal"]')!
    expect(mote).not.toBeNull(); expect(mote.textContent).toContain('阻塞待处理'); expect(mote.textContent).toContain('另有 1 项责任待处理')
    expect(mote.querySelectorAll('.goal-responsibility__execution')).toHaveLength(2)
    await evidence('compact-list-and-mote-attention-priority', await f.proof())
  }, 30_000)

  it('actual worker progress remains manager review until exact manager verification; related input and wrong Run reopen the original responsibility', async () => {
    const f = await fixture(); await f.finite()
    f.statuses.set('finite-worker', semantic(f.metadata.get('finite-worker')!, 'done'))
    await f.publish()
    const read = (await f.cli('owner', ['goal', 'delegations', '--goal', 'goal'])).result as GoalDelegationResult
    const execution = demandExecutionReferences((await f.demands.get('goal'))!)[0]!
    const update: DemandProgressInput = { operationId: 'worker-wait', execution, expectedScope: read.responsibility!.scope, phase: 'waiting-external',
      summary: 'Original external review', evidence: ['external:original-review'], nextAction: 'Resume the original task after review',
      waiting: { reference: 'external:original-review', resumeWhen: 'The original reviewer answers' } }
    const declared = await f.action('finite-worker', 'progress', { goalId: 'goal', progress: update })
    expect(declared.result.progressUpdates).toHaveLength(1)
    expect(declared.result.progressUpdates[0]).toMatchObject({ author: { kind: 'agent', id: 'finite-worker' }, reportingRunId: 'finite-worker-run', managerVerified: false })
    expect(declared.result.responsibility.executions[0]).toMatchObject({ phase: 'report-review', alert: 'manager-review', nextOwner: { kind: 'manager', agentSessionId: 'owner' } })
    const verified = await f.action('owner', 'progress', { goalId: 'goal', progress: { ...update, operationId: 'manager-verified-wait', expectedScope: declared.result.responsibility.scope } })
    expect(verified.result.responsibility.executions[0]).toMatchObject({ phase: 'waiting-external', alert: null, nextOwner: { kind: 'external' } })
    await f.publish(); await mount(createElement(GoalDelegationWork, { demand: useAppStore.getState().demands.goal! }))
    expect(container.querySelector('[data-goal-responsibility="goal"]')!.textContent).toContain('等待外部条件')
    const active = semantic(f.metadata.get('finite-worker')!, 'working'); active.session.semanticStatus!.currentActivityRevision = 8
    f.statuses.set('finite-worker', active)
    await act(async () => { f.emit('finite-worker'); await vi.waitFor(() => expect(useAppStore.getState().demands.goal!.responsibility!.executions[0]!.phase).toBe('executing')) })
    const other = semantic({ ...f.metadata.get('finite-worker')!, run: { runId: 'replacement-run' } }, 'done')
    f.statuses.set('finite-worker', other)
    await act(async () => { f.emit('finite-worker'); await vi.waitFor(() => expect(useAppStore.getState().demands.goal!.responsibility!.executions[0]!.phase).toBe('unknown')) })
    expect(container.querySelector('[data-goal-responsibility="goal"]')!.textContent).toContain('观察待确认')
    expect((await f.demands.get('goal'))!.dispatches![0]!.runId).toBe('finite-worker-run')
    expect(f.nativeInputs).toEqual([]); expect(f.stop).not.toHaveBeenCalled()
    await evidence('authenticated-progress-native-activity-run-fence', await f.proof())
  }, 30_000)

  it('stationary original idle and native error remain actionable after old observation timestamps, including management error', async () => {
    const f = await fixture(); await f.finite()
    const now = Date.now(), old = semantic(f.metadata.get('finite-worker')!, 'done', now - 2 * 60 * 60_000)
    old.session.semanticStatus!.observedAt = now - 60 * 60_000
    old.observation = observeAgent({ process: 'running', status: old.session.semanticStatus!, timelineCapability: 'complete-events',
      awaitingRequest: false, terminalCapabilityUnverified: false }, now)
    expect(old.observation.stale).toBe(true)
    f.statuses.set('finite-worker', old)
    const idle = (await f.cli('owner', ['goal', 'delegations', '--goal', 'goal'])).result as GoalDelegationResult
    expect(idle.responsibility!.executions[0]).toMatchObject({ phase: 'stalled', alert: 'stalled' })
    const failed = semantic(f.metadata.get('finite-worker')!, 'error', now - 2 * 60 * 60_000)
    failed.session.semanticStatus!.observedAt = now - 60 * 60_000
    failed.observation = observeAgent({ process: 'running', status: failed.session.semanticStatus!, timelineCapability: 'complete-events',
      awaitingRequest: false, terminalCapabilityUnverified: false }, now)
    f.statuses.set('finite-worker', failed); f.statuses.set('owner', semantic(f.metadata.get('owner')!, 'error'))
    const error = (await f.cli('owner', ['goal', 'delegations', '--goal', 'goal'])).result as GoalDelegationResult
    expect(error.responsibility!.executions[0]).toMatchObject({ phase: 'blocked', alert: 'error' })
    expect(error.responsibility!.supervisor).toMatchObject({ agentSessionId: 'owner', hostId: 'local', runId: 'owner-run', state: 'blocked' })
    expect((await f.demands.get('goal'))!.status).toBe('in_progress'); expect(f.stop).not.toHaveBeenCalled()
    await evidence('stationary-observation-and-management-error', await f.proof())
  }, 30_000)

  it('an exact transient index update reads no unrelated Goal getters or record enumeration and retains unrelated consumer references', () => {
    const dispatch: DemandDispatch = { operationId: 'hot-start', hostId: 'local', agentSessionId: 'hot-worker', runId: 'hot-run', execution: 'finite',
      prompt: 'Original hot work', stage: 'confirmed', preparedAt: _newTailFixtureEpoch(0, 0, 1), submittedAt: _newTailFixtureEpoch(0, 0, 2), receipt: { kind: 'core-prompt', itemId: 'prompt:hot-start', createdAt: _newTailFixtureEpoch(0, 0, 3) } }
    const hot: DemandRecord = { id: 'hot', title: 'Original hot task', description: '', status: 'in_progress', priority: 'normal', projectId: null,
      projectName: null, source: 'session', sessionIds: [], createdAt: _newTailFixtureEpoch(0, 0, 1), updatedAt: _newTailFixtureEpoch(0, 0, 2), dispatches: [dispatch] }
    const values: Record<string, DemandRecord> = { hot }
    for (let id = 0; id < 1000; id++) values['unrelated-' + id] = { ...hot, id: 'unrelated-' + id,
      dispatches: [{ ...dispatch, operationId: 'other-' + id, agentSessionId: 'other-worker-' + id, receipt: { ...dispatch.receipt!, itemId: 'prompt:other-' + id } }] }
    let reads = 0, enumerations = 0
    const guarded = new Proxy(values, { ownKeys: target => { enumerations++; return Reflect.ownKeys(target) }, get: (target, property, receiver) => {
      if (typeof property === 'string' && property.startsWith('unrelated-')) reads++
      return Reflect.get(target, property, receiver)
    } })
    const before = currentDemandIndex(guarded), otherKey = currentDemandKey('local', 'other-worker-999'), retained = before.get(otherKey)
    expect(retained).toBeDefined(); expect(before.size).toBe(1001)
    const next = new Proxy({ ...values, hot: { ...hot, title: 'Updated exact task' } }, { ownKeys: target => { enumerations++; return Reflect.ownKeys(target) },
      get: (target, property, receiver) => { if (typeof property === 'string' && property.startsWith('unrelated-')) reads++; return Reflect.get(target, property, receiver) } })
    reads = 0; enumerations = 0
    updateCurrentDemandIndex(guarded, next, ['hot'])
    const after = currentDemandIndex(next)
    expect(after.get(currentDemandKey('local', 'hot-worker'))!.goals[0]!.title).toBe('Updated exact task')
    expect(after.get(otherKey)).toBe(retained); expect(reads).toBe(0); expect(enumerations).toBe(0)
    // The actual public read producer must consume this exact-index update too.
    useAppStore.setState({ demands: next })
    applyGoalDelegationResult({ goalId: 'hot', goalUpdatedAt: _newTailFixtureEpoch(0, 0, 2), diskDurability: 'confirmed', delegations: [], dispatches: [dispatch],
      responsibility: { scope: 'isolated-index-observation', observedAt: Date.now(), supervisor: { agentSessionId: null, state: 'missing', reason: 'Original manager is absent.' },
        executions: [{ execution: { kind: 'start', operationId: dispatch.operationId, hostId: dispatch.hostId, agentSessionId: dispatch.agentSessionId, runId: dispatch.runId },
          binding: 'confirmed', phase: 'stalled', reason: 'Original unreported idle.', alert: 'stalled', basis: { stateEnteredAt: _newTailFixtureEpoch(0, 0, 1), activityRevision: 7, inputSubmissionId: null },
          nextOwner: { kind: 'manager', agentSessionId: null, action: 'Inspect the original task.' } }] } })
    const changed = currentDemandIndex(useAppStore.getState().demands)
    expect(changed.get(currentDemandKey('local', 'hot-worker'))!.goals[0]!.phase).toBe('stalled')
    expect(changed.get(otherKey)).toBe(retained)
  })

  it('management lookup uses the retained exact Host owner without probing an unrelated remote status', async () => {
    const original = { agentSessionId: 'manager', run: { runId: 'manager-run' } }
    const localStatus = vi.fn(async () => ({ session: original, run: original.run })), remoteStatus = vi.fn(() => new Promise(() => {}))
    const port = { rpcClients: () => [
      { hostId: 'local', client: { agentSession: (id: string) => id === 'manager' ? original : null, statusAgent: localStatus } },
      { hostId: 'unrelated-remote', client: { agentSession: () => null, statusAgent: remoteStatus } }
    ] }
    const result = await RuntimeController.prototype.resolveGoalAgent.call(port as unknown as RuntimeController, 'manager')
    expect(result).toMatchObject({ hostId: 'local', status: { session: { agentSessionId: 'manager' } } })
    expect(localStatus).toHaveBeenCalledOnce(); expect(remoteStatus).not.toHaveBeenCalled()
  })
})
