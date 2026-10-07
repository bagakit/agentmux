// @vitest-environment happy-dom
import './helpers/current-demand-product'
import { bridge, demands, directory, client, manager, root, container, config, session, writes, snapshot, sourceCli, runtime } from './helpers/current-demand-product'
import { act, Profiler } from 'react'
import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { AgentRegionHeader } from '../src/renderer/src/components/AgentRegionHeader'
import { RegionCurrentDemand } from '../src/renderer/src/components/RegionCurrentDemand'
import { GoalDetail } from '../src/renderer/src/components/GoalDetail'
import { EMPTY_GOAL_ACKNOWLEDGEMENT } from '../src/renderer/src/components/GoalAlignment'
import { regionExecutionHost } from '../src/renderer/src/lib/region-execution-host'
import { currentDemandIndex, currentDemandKey } from '../src/renderer/src/lib/goal-current-work'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { runDemandCli } from '../../../packages/demand/src/cli'

async function publicGoal() {
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'work.sock'), coreClients: () => [{ hostId: 'local', client }], execute: (...args) => bridge.controlOptions.execute(...args) })
  await server.start()
  const service = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  return { server, service }
}
it.each(['finite', 'continue'] as const)('Current Demand: actual public %s Start alone records original input and Region focuses the same Goal without input', async execution => {
  const { server, service } = await publicGoal()
  try {
    await act(async () => root.render(null))
    const originalRun = structuredClone(session.run), sourceId = 'local:current-demand-presentation'
    useAppStore.setState({ sessions: [{ ...snapshot, id: sourceId }], timelines: { [sourceId]: await client.sessionTimeline(session.agentSessionId) } })
    await demands.addActivity('goal', { kind: 'execution', message: 'Ordinary activity cannot start work.', actorId: null })
    await useAppStore.getState().refreshDemand('goal')
    expect(currentDemandIndex(useAppStore.getState().demands).has(currentDemandKey('local', session.agentSessionId))).toBe(false)
    const started = await service.call('goal.start', { goalId: 'goal', sessionId: session.agentSessionId, operationId: 'actual-business-start', ...(execution === 'continue' ? { continuation: { intervalMs: 60_000, alignmentRevision: 1 } } : {}) })
    expect(started.receipt.sessionId).toBe(session.agentSessionId)
    const inspected = await service.call('goal.inspect', { goalId: 'goal' })
    expect(inspected.goal!.dispatches).toEqual([expect.objectContaining({ operationId: 'actual-business-start', agentSessionId: session.agentSessionId, hostId: 'local', runId: originalRun.runId, execution, stage: 'confirmed', receipt: { kind: 'core-prompt', itemId: 'prompt:actual-business-start', createdAt: expect.any(Number) } })])
    expect((await demands.get('goal'))!.dispatches).toEqual(inspected.goal!.dispatches)
    const accepted = [...writes], originalDraft = 'Keep this unsent original draft.'
    useAppStore.getState().setAgentComposerDraft(sourceId, originalDraft)
    function Consumer() {
      const selected = useAppStore(state => state.selectedDemandId), goal = useAppStore(state => state.demands.goal)!
      return <><AgentRegionHeader name="Original Agent" executorLabel="Original Executor" sessionId={sourceId} sessionKind="agent" executionHost={regionExecutionHost(snapshot)} regionId="original-region" readOnly={false} nativeSession={{ ...snapshot, id: sourceId }} onHistory={undefined} />
        {selected === 'goal' ? <GoalDetail demand={{ ...goal, sessions: [], workspacePath: null }} onClose={() => {}} onOpenMote={() => {}} onGrill={() => {}} onGrounding={() => {}} acknowledgementFeedback={EMPTY_GOAL_ACKNOWLEDGEMENT} onAcknowledgementFeedbackChange={() => {}} moteError={null} onRetryMote={() => {}} /> : null}</>
    }
    await act(async () => root.render(<Consumer />))
    const badge = container.querySelector<HTMLButtonElement>('.region-current-demand button')!
    expect(badge?.textContent).toContain('Original useful work')
    expect(container.querySelector('.agent-region-header__name')!.textContent).toBe('Original Agent')
    expect(container.querySelector('.agent-region-header__more')).not.toBeNull()
    await act(async () => badge.click())
    await vi.waitFor(() => expect(useAppStore.getState().selectedDemandId).toBe('goal'))
    expect(container.querySelector('.goals-detail')).not.toBeNull()
    expect(useAppStore.getState().agentComposerDrafts[sourceId]).toBe(originalDraft)
    expect(writes).toEqual(accepted); expect((await client.agentSession(session.agentSessionId)).run).toEqual(originalRun)
    expect((await demands.get('goal'))!.dispatches).toEqual(inspected.goal!.dispatches)
    const render = vi.fn()
    await act(async () => root.render(<Profiler id="current" onRender={render}><RegionCurrentDemand agentSessionId={session.agentSessionId} hostId="local" /></Profiler>))
    const initialRenders = render.mock.calls.length
    await act(async () => {
      for (let index = 0; index < 20; index++) useAppStore.setState(state => ({
        sessions: [...state.sessions, { ...snapshot, id: `unrelated-${index}`, control: { ...snapshot.control, agentSessionId: `unrelated-${index}` } }],
        timelines: { ...state.timelines, unrelated: { agentSessionId: 'unrelated', revision: index, items: [] } },
        demands: { ...state.demands, unrelated: { ...state.demands.goal!, id: 'unrelated', title: `Unrelated ${index}`, dispatches: [] } }
      }))
    })
    expect(render.mock.calls).toHaveLength(initialRenders)
    expect(manager.list()).toHaveLength(execution === 'continue' ? 1 : 0)
  } finally { await service.dispose(); await server.stop() }
})

it.each(['finite', 'continue'] as const)('Current Demand: actual public %s lost Core reply retains unknown original input; the same OP reconciles without bytes or retargeting', async execution => {
  const { server, service } = await publicGoal()
  try {
    await act(async () => root.render(null))
    const sourceId = 'local:unknown-business-presentation', originalRun = structuredClone(session.run)
    useAppStore.setState({ sessions: [{ ...snapshot, id: sourceId }], timelines: { [sourceId]: await client.sessionTimeline(session.agentSessionId) } })
    const real = runtime.submitPrompt.bind(runtime)
    vi.spyOn(runtime, 'submitPrompt').mockImplementationOnce(async (...args) => {
      await real(...args)
      throw Object.assign(new Error('The private original Core input reply was lost.'), { code: 'CONTROL_UNAVAILABLE' })
    })
    const input = { goalId: 'goal', sessionId: session.agentSessionId, operationId: 'actual-original-unknown', ...(execution === 'continue' ? { continuation: { intervalMs: 60_000, alignmentRevision: 1 } } : {}) }
    await expect(service.call('goal.start', input)).rejects.toThrow('reply was lost')
    const accepted = [...writes], original = (await service.call('goal.inspect', { goalId: 'goal' })).goal!.dispatches![0]!
    expect(accepted.length).toBeGreaterThan(0); expect(original).toMatchObject({ stage: 'unknown', operationId: input.operationId, agentSessionId: session.agentSessionId, hostId: 'local', runId: originalRun.runId }); expect(original.receipt).toBeUndefined()
    expect(useAppStore.getState().agentSteerQueues[sourceId]).toEqual([expect.objectContaining({ goalDispatch: { goalId: 'goal', operationId: input.operationId }, awaitingExplicitSend: true })])
    expect(currentDemandIndex(useAppStore.getState().demands).get(currentDemandKey('local', session.agentSessionId))).toMatchObject({ state: 'unconfirmed', goals: [{ confirmed: false, pending: 'unknown' }] })
    await demands.update('goal', { assigneeSessionIds: [], supervisorSessionId: null })
    useAppStore.getState().setAgentComposerDraft(sourceId, 'Original later draft remains.')
    const expectedStartedAt = execution === 'continue' ? manager.list()[0]!.initialDelivery!.startedAt : original.preparedAt
    const replay = await service.call('goal.start', input), confirmed = replay.goal.dispatches![0]!
    expect(replay.receipt).toMatchObject({ sessionId: session.agentSessionId, startedAt: expectedStartedAt })
    const { issue: _issue, ...frozen } = original
    expect(confirmed).toMatchObject({ ...frozen, stage: 'confirmed', receipt: { kind: 'core-prompt', itemId: `prompt:${input.operationId}`, createdAt: expect.any(Number) } })
    expect(confirmed.issue).toBeUndefined(); expect(writes).toEqual(accepted)
    expect(useAppStore.getState().agentSteerQueues[sourceId] ?? []).toEqual([])
    expect(useAppStore.getState().agentComposerDrafts[sourceId]).toBe('Original later draft remains.')
    expect((await client.agentSession(session.agentSessionId)).run).toEqual(originalRun)
    if (execution === 'continue') expect(replay.continuation?.initialDelivery?.state).toBe('confirmed')
    const revision = (await demands.snapshot()).revision
    const again = await service.call('goal.start', input)
    expect(again.receipt.startedAt).toBe(expectedStartedAt)
    expect((await demands.snapshot()).revision).toBe(revision); expect(writes).toEqual(accepted)
    await expect(service.call('goal.start', { ...input, sessionId: 'unrelated-responsible-session' })).rejects.toThrow()
    expect(writes).toEqual(accepted); expect((await demands.get('goal'))!.dispatches).toEqual([confirmed])
    const timeline = await client.sessionTimeline(session.agentSessionId)
    expect(timeline.items.filter(item => item.id === `prompt:${input.operationId}`)).toHaveLength(1)
  } finally { await service.dispose(); await server.stop() }
})

it.each(['finite', 'continue'] as const)('Current Demand: actual Source CLI %s Start, inspect and ls read the same durable dispatch; ordinary update cannot forge it', async execution => {
  const { server, service } = await publicGoal()
  try {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
    const inspectHelp = (await promisify(execFile)(process.execPath, [sourceCli, 'goal', 'inspect', '--help'], { env: environment, timeout: 15_000 })).stdout
    const startHelp = (await promisify(execFile)(process.execPath, [sourceCli, 'goal', 'start', '--help'], { env: environment, timeout: 15_000 })).stdout
    const skill = (await promisify(execFile)(process.execPath, [sourceCli, 'goal', '--help'], { env: environment, timeout: 15_000 })).stdout
    expect(inspectHelp).toContain('saved Start dispatch stages'); expect(inspectHelp).toContain('original Core input references')
    expect(startHelp).toContain('retry the same OP'); expect(skill).toContain('saved Start dispatch stages'); expect(skill).toContain('retry the same OP')
    const run = async (args: string[]) => {
      const envelope = JSON.parse((await promisify(execFile)(process.execPath, [sourceCli, '--endpoint', 'unix:' + server.path, ...args], { env: environment, timeout: 15_000 })).stdout)
      expect(envelope.ok).toBe(true); return envelope.result
    }
    const sourceId = 'local:source-cli-presentation'
    useAppStore.setState({ sessions: [{ ...snapshot, id: sourceId }], timelines: { [sourceId]: await client.sessionTimeline(session.agentSessionId) } })
    const args = ['goal', 'start', '--goal', 'goal', '--session', session.agentSessionId, '--operation-id', 'actual-cli-dispatch', ...(execution === 'continue' ? ['--continue-ms', '60000', '--alignment-revision', '1'] : [])]
    const started = await run(args), accepted = [...writes], revision = (await demands.snapshot()).revision
    const inspected = await run(['goal', 'inspect', '--goal', 'goal']), listed = await run(['goal', 'ls'])
    expect(inspected.goal!.dispatches).toEqual(started.goal.dispatches)
    expect(listed.goals.find((goal: { id: string }) => goal.id === 'goal').dispatches).toEqual(inspected.goal!.dispatches)
    const output: string[] = []
    expect(await runDemandCli(['--root', demands.root, 'show', '--id', 'goal'], { stdout: value => output.push(value) })).toBe(0)
    expect(JSON.parse(output[0]!).demand.dispatches).toEqual(inspected.goal!.dispatches)
    expect(inspected.goal!.dispatches).toEqual([expect.objectContaining({ stage: 'confirmed', execution, agentSessionId: session.agentSessionId, hostId: 'local', runId: session.run.runId })])
    await expect(service.call('goal.update', { goalId: 'goal', patch: { dispatches: [] } } as never)).rejects.toThrow()
    await expect(demands.update('goal', { dispatches: [] } as never)).rejects.toThrow('actual Goal Start')
    await expect(demands.create({ id: 'forged', title: 'Forged', dispatches: inspected.goal!.dispatches } as never)).rejects.toThrow('actual Goal Start')
    expect((await run(args)).receipt).toEqual(started.receipt)
    expect((await demands.snapshot()).revision).toBe(revision); expect(writes).toEqual(accepted)
  } finally { await service.dispose(); await server.stop() }
})

it('Current Demand: two actual confirmed Goals remain ambiguous and each Region item focuses its exact detail; history is not current execution', async () => {
  const { server, service } = await publicGoal()
  try {
    await act(async () => root.render(null))
    const sourceId = 'local:multiple-presentation'
    useAppStore.setState({ sessions: [{ ...snapshot, id: sourceId }], timelines: { [sourceId]: await client.sessionTimeline(session.agentSessionId) } })
    await demands.create({ id: 'second', title: 'Second actual business result', description: 'Finish the second exact result.', assigneeSessionIds: [session.agentSessionId], sessionIds: [session.agentSessionId] })
    await demands.create({ id: 'history', title: 'Historical association only', sessionIds: [session.agentSessionId], status: 'in_progress' })
    await service.call('goal.start', { goalId: 'goal', sessionId: session.agentSessionId, operationId: 'first-business-input' })
    await service.call('goal.start', { goalId: 'second', sessionId: session.agentSessionId, operationId: 'second-business-input' })
    await useAppStore.getState().refreshDemand('history')
    const accepted = [...writes], before = (await demands.snapshot()).revision
    expect(currentDemandIndex(useAppStore.getState().demands).get(currentDemandKey('local', session.agentSessionId))).toMatchObject({ state: 'ambiguous', goals: [{ goalId: 'goal', confirmed: true }, { goalId: 'second', confirmed: true }] })
    await act(async () => root.render(<RegionCurrentDemand agentSessionId={session.agentSessionId} hostId="local" />))
    expect(container.textContent).toContain('2 Goals · work is ambiguous')
    for (const [id, title] of [['second', 'Second actual business result'], ['goal', 'Original useful work']]) {
      await act(async () => container.querySelector<HTMLButtonElement>('button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
      await vi.waitFor(() => expect(document.querySelector('.region-current-demand-menu')).not.toBeNull())
      const item = [...document.querySelectorAll<HTMLElement>('.region-current-demand-menu [role="menuitem"]')].find(item => item.textContent?.includes(title!))!
      await act(async () => item.click())
      await vi.waitFor(() => expect(useAppStore.getState().selectedDemandId).toBe(id))
      expect(writes).toEqual(accepted)
    }
    useAppStore.setState(state => ({ selectedDemandId: null, agentFocus: { ...state.agentFocus, execution: { sessionId: sourceId, history: [] } } }))
    await act(async () => root.render(<GlobalBoardSurface />))
    expect(container.querySelector('[data-demand-id="history"]')?.getAttribute('data-session-context')).toBeNull()
    expect(container.querySelector('[data-demand-id="history"]')?.textContent).not.toContain('Current execution')
    expect(container.querySelector('[data-demand-id="goal"]')?.textContent).toContain('Multiple confirmed Goals')
    expect((await demands.snapshot()).revision).toBe(before); expect(writes).toEqual(accepted)
  } finally { await service.dispose(); await server.stop() }
})

it('Current Demand: Main freezes exact Host Session Run OP and prompt; a wrong receipt remains unknown while ordinary manual input stays usable', async () => {
  const operationId = 'frozen-business-operation', reference = { goalId: 'goal', operationId }, originalRun = structuredClone(session.run)
  const intent = { operationId, agentSessionId: session.agentSessionId, hostId: 'local', runId: session.run.runId, execution: 'finite' as const, prompt: 'The frozen original business prompt.' }
  await expect(api.demands.prepareGoalStart('goal', { ...intent, runId: 'wrong-run' })).rejects.toThrow('Run changed')
  await expect(api.demands.prepareGoalStart('goal', { ...intent, agentSessionId: 'unrelated-session' })).rejects.toThrow('responsible Agent')
  await api.demands.prepareGoalStart('goal', intent)
  const control = snapshot.control, accepted = [...writes]
  for (const [wrongControl, wrongOperation, wrongPrompt] of [[{ ...control, hostId: 'wrong-host' }, operationId, intent.prompt], [{ ...control, agentSessionId: 'wrong-session' }, operationId, intent.prompt], [control, 'wrong-operation', intent.prompt], [control, operationId, 'A changed prompt.'], [{ ...control, run: { runId: 'wrong-run' } }, operationId, intent.prompt]] as const)
    await expect(api.sessions.submitPrompt(wrongControl, wrongPrompt, wrongOperation, { expectedRun: originalRun, afterSubmissionId: null }, undefined, undefined, undefined, undefined, undefined, undefined, reference)).rejects.toThrow()
  expect(writes).toEqual(accepted)
  const read = runtime.sessionTimeline.bind(runtime)
  const timelineObservation = vi.spyOn(runtime, 'sessionTimeline').mockImplementation(async target => {
    const actual = await read(target)
    return { ...actual, items: actual.items.map(item => item.id === `prompt:${operationId}` ? { ...item, content: 'A different input cannot confirm this Goal.' } : item) }
  })
  await expect(api.sessions.submitPrompt(control, intent.prompt, operationId, { expectedRun: originalRun, afterSubmissionId: null }, undefined, undefined, undefined, undefined, undefined, undefined, reference)).rejects.toThrow('unconfirmed')
  expect((await api.demands.inspectDispatch(reference))?.stage).toBe('unknown')
  expect(currentDemandIndex({ goal: (await demands.get('goal'))! }).get(currentDemandKey('local', session.agentSessionId))).toMatchObject({ state: 'unconfirmed' })
  timelineObservation.mockRestore()
  await api.sessions.submitPrompt(control, 'Ordinary manual input remains available.', 'manual-input-after-observation-gap', { expectedRun: originalRun, afterSubmissionId: operationId }, { allowUncertainTurn: true })
  expect(writes.join('')).toContain('Ordinary manual input remains available.')
  await api.demands.reconcileDispatch(reference)
  expect((await api.demands.inspectDispatch(reference))?.stage).toBe('confirmed')
  const revision = (await demands.snapshot()).revision, original = (await api.demands.inspectDispatch(reference))!
  await demands.prepareDispatch('goal', intent)
  await expect(demands.recordDispatchPhase('goal', operationId, { stage: 'unknown', issue: 'A later observation cannot regress the original receipt.' })).resolves.toMatchObject({ demand: { dispatches: [original] } })
  expect((await demands.snapshot()).revision).toBe(revision); expect(await api.demands.inspectDispatch(reference)).toEqual(original)
  await demands.create({ id: 'other', title: 'Other Goal', assigneeSessionIds: [session.agentSessionId] })
  await expect(demands.prepareDispatch('other', intent)).rejects.toThrow('another Goal')
  await expect(demands.prepareDispatch('goal', { ...intent, prompt: 'Changed' })).rejects.toThrow('another Goal')
  expect((await client.agentSession(session.agentSessionId)).run).toEqual(originalRun)
})
