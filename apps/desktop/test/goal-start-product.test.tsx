// @vitest-environment happy-dom
import './helpers/current-demand-product'
import { bridge, demands, directory, client, runtime, session, writes, sourceCli, root, container, manager } from './helpers/current-demand-product'
import { act, Profiler } from 'react'
import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { isAgentMuxRpcMethod, AGENTMUX_RPC_NATIVE_METHODS } from '../../../packages/core/src/public-rpc'
import { api } from '../src/renderer/src/lib/api'
import { GoalStartResponsibilityOwner } from '@agentmux/host/goal-start-responsibility'
import { GoalFiniteStartControl } from '../src/renderer/src/components/GoalFiniteStartControl'
import { useAppStore } from '../src/renderer/src/store'

function FiniteTask({ goalId }: { goalId: string }) {
  const demand = useAppStore(state => state.demands[goalId])
  return demand ? <GoalFiniteStartControl demand={demand} primary /> : null
}

it('visible one-time task → actual preload/Main/Core receipt without confirmation or follow-up authorization; double click submits once', async () => {
  const goal = (await demands.create({ id: 'finite-unconfirmed', title: 'An explicit finite task', sessionIds: [session.agentSessionId], assigneeSessionIds: [session.agentSessionId] })).demand
  await act(async () => { await useAppStore.getState().refreshDemand(goal.id); root.render(<FiniteTask goalId={goal.id} />) })
  const button = [...container.querySelectorAll('button')].find(button => button.textContent?.startsWith('Start with'))!
  expect(button).toBeDefined(); expect(button.disabled).toBe(false)
  await act(async () => { button.click(); button.click() })
  await act(async () => { await vi.waitFor(async () => expect((await demands.get(goal.id))?.dispatches?.[0]?.stage, container.textContent).toBe('confirmed')) })
  const current = (await demands.get(goal.id))!, start = current.dispatches![0]!
  expect(current.dispatches).toHaveLength(1)
  expect(current.alignment).toBeUndefined()
  expect(start).toMatchObject({ execution: 'finite', agentSessionId: session.agentSessionId, runId: session.run.runId })
  const input = await client.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: start.agentSessionId, expectedRun: { runId: start.runId }, submissionId: start.operationId })
  expect(input?.admission).toMatchObject({ acknowledged: true, submissionId: start.operationId })
  expect(manager.list()).toEqual([])
  await act(async () => { await vi.waitFor(() => expect(useAppStore.getState().goalFiniteStartIntents[goal.id]).toBeUndefined()) })
  expect(container.querySelector('a')?.getAttribute('href')).toBe(`#goal-work-${goal.id}`)
  const another = container.querySelector('details')!
  expect(another.open).toBe(false)
  expect(container.querySelector('.goals-button--primary')).toBeNull()
})

it('finite task uses the observed Goal version at the real owner and a stale click writes no Agent input', async () => {
  const before = useAppStore.getState().demands.goal!
  await act(async () => root.render(<GoalFiniteStartControl demand={before} primary />))
  await demands.update('goal', { description: 'Changed after the displayed Goal' })
  const accepted = [...writes]
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent?.startsWith('Start with'))!.click())
  await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain('The Goal changed')) })
  expect(writes).toEqual(accepted)
  expect((await demands.get('goal'))!.dispatches ?? []).toEqual([])
  expect(useAppStore.getState().goalFiniteStartIntents.goal).toBeUndefined()
  expect((await client.agentSession(session.agentSessionId)).run).toEqual(session.run)
})

it('restored unknown operation only reads its original owner; missing owner record does not permit a second input', async () => {
  const before = (await demands.get('goal'))!, original = { goalId: 'goal', operationId: 'retained-unknown-operation', sessionId: session.agentSessionId, expectedUpdatedAt: before.updatedAt, phase: 'may-have-dispatched' as const }
  const accepted = [...writes]
  await act(async () => { useAppStore.setState({ goalFiniteStartIntents: { goal: original } }); root.render(<FiniteTask goalId="goal" />) })
  await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain('outcome remains unknown')) })
  const inspect = [...container.querySelectorAll('button')].find(button => button.textContent === 'Inspect original Start')!
  await act(async () => inspect.click())
  await vi.waitFor(async () => { await act(async () => {}); expect(inspect.disabled).toBe(false) })
  expect(writes).toEqual(accepted)
  expect(await demands.inspectDispatch('goal', original.operationId)).toBeNull()
  expect(useAppStore.getState().goalFiniteStartIntents.goal).toEqual(original)
  expect([...container.querySelectorAll('button')].some(button => button.textContent?.startsWith('Start with'))).toBe(false)
})

it('multiple assignees require an explicit recipient; selection sends nothing and unrelated Session output causes no finite-control commits', async () => {
  await act(async () => root.render(null))
  await demands.update('goal', { assigneeSessionIds: [session.agentSessionId, 'another-retained-agent'] })
  await useAppStore.getState().refreshDemand('goal')
  const goal = useAppStore.getState().demands.goal!
  const renders = vi.fn()
  await act(async () => root.render(<Profiler id="finite" onRender={renders}><GoalFiniteStartControl demand={goal} primary /></Profiler>))
  const submit = [...container.querySelectorAll('button')].find(button => button.textContent === 'Choose an Agent for this task')!
  expect(submit.disabled).toBe(true)
  expect(container.textContent).toContain('Choose who receives this task.')
  const accepted = [...writes]
  await act(async () => (container.querySelector('input[type="radio"]') as HTMLInputElement).click())
  expect(writes).toEqual(accepted)
  expect((container.querySelector('input[type="radio"]') as HTMLInputElement).checked).toBe(true)
  expect([...container.querySelectorAll('button')].find(button => button.textContent?.startsWith('Start with'))?.disabled).toBe(false)
  renders.mockClear()
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, unrelated: { events: [], version: 1 } as never } })))
  expect(renders).not.toHaveBeenCalled()
})

it('a fresh finite task rejected before preparation releases its intent so the restored original Agent can receive the next explicit click', async () => {
  await act(async () => root.render(null))
  const originalSessions = useAppStore.getState().sessions, goal = useAppStore.getState().demands.goal!, accepted = [...writes]
  await act(async () => { useAppStore.setState({ sessions: [] }); root.render(<GoalFiniteStartControl demand={goal} />) })
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent?.startsWith('Start with'))!.click())
  await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).toContain('unconfirmed presentation'); expect(useAppStore.getState().goalFiniteStartIntents.goal).toBeUndefined() })
  expect((await demands.get('goal'))!.dispatches ?? []).toEqual([])
  expect(writes).toEqual(accepted)
  expect((await client.agentSession(session.agentSessionId)).run).toEqual(session.run)
  await act(async () => useAppStore.setState({ sessions: originalSessions }))
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent?.startsWith('Start with'))!.click())
  await vi.waitFor(async () => { await act(async () => {}); expect((await demands.get('goal'))!.dispatches?.[0]?.stage).toBe('confirmed') })
  expect((await demands.get('goal'))!.dispatches).toHaveLength(1)
})

it('original Source CLI finite Start → actual Core prompt receipt → ended original Run → public Goal responsibility → existing Goal proposal remains pending human review', async () => {
  await act(async () => root.render(null))
  expect(isAgentMuxRpcMethod('goal.delegations'), JSON.stringify(Object.keys(AGENTMUX_RPC_NATIVE_METHODS))).toBe(true)
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'start-responsibility.sock'), coreClients: () => [{ hostId: 'local', client }],
    execute: (...args) => bridge.controlOptions.execute(...args), goalDelegations: bridge.controlOptions.goalDelegations })
  await server.start()
  const service = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const owner = new GoalStartResponsibilityOwner(demands, runtime, vi.fn())
  try {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
    const cli = async (args: string[]) => {
      const envelope = JSON.parse((await promisify(execFile)(process.execPath, [sourceCli, '--endpoint', 'unix:' + server.path, ...args], { env: environment, timeout: 15_000 })).stdout)
      expect(envelope.ok).toBe(true); return envelope.result
    }
    const started = await cli(['goal', 'start', '--goal', 'goal', '--session', session.agentSessionId, '--operation-id', 'original-finite-start', '--expected-updated-at', String((await demands.get('goal'))!.updatedAt)])
    const start = (await demands.inspectDispatch('goal', 'original-finite-start'))!
    expect(start).toMatchObject({ execution: 'finite', agentSessionId: session.agentSessionId, runId: session.run.runId, hostId: 'local', stage: 'confirmed', resultBasis: { alignmentRevision: 1, groundingSubmissionId: null } })
    expect(started.goal.dispatches).toEqual([start])
    const input = await client.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: start.agentSessionId, expectedRun: { runId: start.runId }, submissionId: start.operationId })
    expect(input!.admission).toMatchObject({ acknowledged: true, submissionId: start.operationId })
    const accepted = [...writes]
    vi.spyOn(runtime, 'observeOriginalRun').mockResolvedValue({ runId: start.runId, state: 'exited' })
    const observed = await owner.observe((await demands.get('goal'))!, start)
    if (process.env.AGENTMUX_GOAL_START_RECEIPT_DIR) {
      await fs.mkdir(process.env.AGENTMUX_GOAL_START_RECEIPT_DIR, { recursive: true })
      await fs.writeFile(join(process.env.AGENTMUX_GOAL_START_RECEIPT_DIR, 'original-input-diagnostic.json'), JSON.stringify({ start, input, observed }, null, 2) + '\n')
    }
    expect(observed).toMatchObject({ input: { state: 'confirmed', proof: { operationId: start.operationId, prompt: start.prompt, agentSessionId: start.agentSessionId, runId: start.runId, acknowledged: true } }, originalRun: { runId: start.runId, state: 'exited' }, responsibility: 'original-worker-continuation' })
    const work = await cli(['goal', 'delegations', '--goal', 'goal'])
    expect(work.dispatches).toEqual([start])
    expect(work.startObservations).toEqual([expect.objectContaining({ operationId: start.operationId, input: expect.objectContaining({ state: 'confirmed' }), originalRun: { runId: start.runId, state: 'exited' }, responsibility: 'original-worker-continuation' })])
    const rendererRead = await api.demands.delegation('goal.delegations', { goalId: 'goal' })
    expect(rendererRead.startObservations).toEqual(work.startObservations)
    await owner.start()
    await vi.waitFor(async () => expect((await owner.observe((await demands.get('goal'))!, start)).unknown).toContain('same ended'))
    expect(writes).toEqual(accepted)
    expect((await demands.get('goal'))!.delegations).toBeUndefined()
    await service.call('goal.update', { goalId: 'goal', patch: { grounding: { alignmentRevision: 1, summary: 'Original Goal result to review', checks: [{ criterionId: 'real', outcome: 'met', evidence: ['evidence/result.log:7'], note: '' }] } } })
    const result = await cli(['goal', 'delegations', '--goal', 'goal'])
    expect(result.grounding.acceptedAt).toBeNull()
    expect(result.startObservations[0]).toMatchObject({ responsibility: 'goal-result-review', goalResult: { association: 'unknown', basis: 'captured', changedSinceStart: true, grounding: { acceptedAt: null } } })
    expect((await demands.get('goal'))!.status).not.toBe('done')
    expect((await client.agentSession(session.agentSessionId)).run).toEqual(session.run)
    expect(writes).toEqual(accepted)
    const receiptDirectory = process.env.AGENTMUX_GOAL_START_RECEIPT_DIR
    if (receiptDirectory) {
      await fs.mkdir(receiptDirectory, { recursive: true })
      await fs.writeFile(join(receiptDirectory, 'original-public-start-product.json'), JSON.stringify({ schema: 'agentmux.original-finite-start-product.v1',
        proofBoundary: 'Actual Source CLI, Unix RPC, registered Main, Renderer preload/store request handler and Core prompt journal; Electron transport and Native byte IO/screen wait are fixture ports, ended Run observation is explicit. Does not claim a live Provider exit, real process recovery or visual qualification.',
        start, actualCoreInput: input, observed, publicWork: work, rendererRead, goalResult: result, nativeWritesUnchangedAfterExit: accepted }, null, 2) + '\n')
    }
  } finally { owner.dispose(); await service.dispose(); await server.stop() }
})
