// @vitest-environment happy-dom
import { fixturePath as _tailFixturePath, fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act, createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { composerDOM } from './helpers/composer-dom-fixture'

const initial = useAppStore.getState()
const dom = composerDOM()
afterEach(() => {
  useAppStore.setState(initial, true)
  vi.restoreAllMocks()
})
const session = {
  id: 'review-agent',
  kind: 'agent',
  hostId: 'local',
  providerId: 'codex',
  executorId: 'codex',
  workspacePath: _tailFixturePath("tmp/review-fixture"),
  label: 'fixture',
  createdAt: _tailFixtureEpoch(0, 0, 1),
  updatedAt: _tailFixtureEpoch(0, 0, 1),
  agentSessionUpdatedAt: _tailFixtureEpoch(0, 0, 1),
  processState: 'running',
  status: { state: 'working', source: 'native-hook', observedAt: _tailFixtureEpoch(0, 0, 1) },
  capabilities: {
    terminal: true,
    timeline: 'complete-events',
    permission: 'respond',
    providerResume: true,
    replyCorrelation: 'none',
  },
  latestOutputBytes: 0,
  promptSubmissionPredecessor: null,
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'review-agent', run: { runId: 'review-run' } },
} as const
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function waiting(operationId: string) {
  const key = {
    kind: 'prompt' as const,
    agentSessionId: session.id,
    expectedRun: session.control.run,
    submissionId: operationId,
  }
  const ref = { key, waitGeneration: 1 }
  return {
    key,
    ref,
    persistence: 'confirmed' as const,
    control: { ref, state: 'enabled' as const, at: _tailFixtureEpoch(0, 0, 1) },
    admission: null,
    status: 'waiting' as const,
    observation: 'owned' as const,
  }
}
it('keeps manual Sends in author order through the original Core receipt query', async () => {
  useAppStore.setState({
    sessions: [session],
    agentSteerQueues: {},
    agentSteerInFlight: {},
    agentSteerInFlightPhase: {},
  } as never)
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  const firstInspect = deferred<null>()
  vi.spyOn(api.sessions, 'inspectInput')
    .mockImplementationOnce(() => firstInspect.promise)
    .mockResolvedValue(null)
  const submitted: string[] = []
  vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (_control, text, id) => {
    submitted.push(text)
    return waiting(id)
  })
  expect(useAppStore.getState().send(session.id, 'first', undefined, 'manual')).toBe(true)
  expect(useAppStore.getState().send(session.id, 'second', undefined, 'manual')).toBe(true)
  await vi.waitFor(() => expect(api.sessions.inspectInput).toHaveBeenCalledTimes(1))
  expect(submitted).toEqual([])
  expect(useAppStore.getState().agentSteerInFlight[session.id]).toBe(
    useAppStore.getState().agentSteerQueues[session.id]![0]!.operationId,
  )
  firstInspect.resolve(null)
  await vi.waitFor(() => expect(submitted).toEqual(['first', 'second']))
  const intents = useAppStore.getState().agentSteerQueues[session.id]!
  expect(intents.map((item) => item.text)).toEqual(['first', 'second'])
  expect(vi.mocked(api.sessions.submitPrompt).mock.calls.map((call) => call[2])).toEqual(
    intents.map((item) => item.operationId),
  )
})
it('retains the original in-flight marker until Core returns its receipt', async () => {
  useAppStore.setState({
    sessions: [session],
    agentSteerQueues: {},
    agentSteerInFlight: {},
    agentSteerInFlightPhase: {},
  } as never)
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'inspectInput').mockResolvedValue(null)
  const pending = deferred<ReturnType<typeof waiting>>()
  vi.spyOn(api.sessions, 'submitPrompt')
    .mockImplementationOnce(() => pending.promise)
    .mockImplementation(async (_c, _t, id) => waiting(id))
  expect(useAppStore.getState().send(session.id, 'first', undefined, 'manual')).toBe(true)
  await vi.waitFor(() => expect(api.sessions.submitPrompt).toHaveBeenCalledTimes(1))
  const first = useAppStore.getState().agentSteerQueues[session.id]![0]!
  expect(useAppStore.getState().agentSteerInFlight[session.id]).toBe(first.operationId)
  expect(useAppStore.getState().send(session.id, 'second', undefined, 'manual')).toBe(true)
  await Promise.resolve()
  await Promise.resolve()
  expect(api.sessions.submitPrompt).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().agentSteerInFlight[session.id]).toBe(first.operationId)
  pending.resolve(waiting(first.operationId))
  await vi.waitFor(() => expect(api.sessions.submitPrompt).toHaveBeenCalledTimes(2))
  await vi.waitFor(() => expect(useAppStore.getState().agentSteerInFlight[session.id]).toBeUndefined())
})
it('takes two actual Composer steer actions in order without authorizing the queue-only head', async () => {
  useAppStore.setState({
    sessions: [session],
    agentSteerQueues: {},
    agentSteerInFlight: {},
    agentSteerInFlightPhase: {},
    agentComposerDrafts: {},
  } as never)
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  const gate = deferred<null>()
  vi.spyOn(api.sessions, 'inspectInput')
    .mockImplementationOnce(() => gate.promise)
    .mockResolvedValue(null)
  const submitted: string[] = []
  vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (_c, text, id) => {
    submitted.push(text)
    return waiting(id)
  })
  expect(useAppStore.getState().enqueueAgentSteer(session.id, 'queue only', undefined, undefined, 'manual')).toBe(true)
  await dom.render(createElement(AgentSessionComposer, { sessionId: session.id }))
  async function steer(text: string) {
    await act(async () => useAppStore.getState().setAgentComposerDraft(session.id, text))
    const input = dom.container.querySelector<HTMLElement>('[contenteditable="true"]')!
    expect(input.textContent).toBe(text)
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }),
      ),
    )
  }
  await steer('first actual steer')
  await vi.waitFor(() => expect(api.sessions.inspectInput).toHaveBeenCalledTimes(1))
  await steer('second actual steer')
  expect(submitted).toEqual([])
  await act(async () => {
    gate.resolve(null)
    await useAppStore.getState().flushAgentSteerQueue(session.id)
  })
  expect(submitted).toEqual(['first actual steer', 'second actual steer'])
  expect(
    useAppStore.getState().agentSteerQueues[session.id]!.map((item) => [item.text, Boolean(item.inputReceipt)]),
  ).toEqual([
    ['queue only', false],
    ['first actual steer', true],
    ['second actual steer', true],
  ])
  expect(dom.draft(session.id)).toBeUndefined()
})
it('rejoins the original stopped input without minting another submission', async () => {
  useAppStore.setState({
    sessions: [session],
    agentSteerQueues: {},
    agentSteerInFlight: {},
    agentSteerInFlightPhase: {},
  } as never)
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  const original = waiting('original-key')
  original.observation = 'rejoin-needed' as never
  vi.spyOn(api.sessions, 'inspectInput').mockResolvedValue(original)
  const rejoin = vi.spyOn(api.sessions, 'rejoinInputWaiting').mockResolvedValue(original)
  const submit = vi.spyOn(api.sessions, 'submitPrompt')
  expect(
    useAppStore
      .getState()
      .enqueueAgentSteer(session.id, 'original text', undefined, 'original-key', 'manual', undefined, {
        execution: 'immediate',
      }),
  ).toBe(true)
  expect(await useAppStore.getState().sendQueuedAgentSteer(session.id, 'original-key')).toBe('unconfirmed')
  expect(submit).not.toHaveBeenCalled()
  expect(rejoin).toHaveBeenCalledExactlyOnceWith(session.control, original.ref)
  expect(useAppStore.getState().agentSteerQueues[session.id]![0]!.operationId).toBe('original-key')
})
it('reads an old-Run unknown operation using its frozen control without replay or rebinding', async () => {
  useAppStore.setState({
    sessions: [session],
    agentSteerQueues: {},
    agentSteerInFlight: {},
    agentSteerInFlightPhase: {},
  } as never)
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  expect(
    useAppStore
      .getState()
      .enqueueAgentSteer(session.id, 'original unknown', undefined, 'unknown-key', 'manual', undefined, {
        execution: 'immediate',
      }),
  ).toBe(true)
  const original = { ...waiting('unknown-key'), status: 'unknown' as const }
  useAppStore.setState({
    sessions: [{ ...session, control: { ...session.control, run: { runId: 'later-run' } } }],
    timelines: {
      [session.id]: {
        agentSessionId: session.id,
        items: [{ id: 'prompt:unknown-key', kind: 'user_message', agentSessionId: session.id, status: 'complete' }],
      },
    },
  } as never)
  const inspect = vi.spyOn(api.sessions, 'inspectInput').mockResolvedValue(original)
  const submit = vi.spyOn(api.sessions, 'submitPrompt'),
    rejoin = vi.spyOn(api.sessions, 'rejoinInputWaiting')
  expect(await useAppStore.getState().sendQueuedAgentSteer(session.id, 'unknown-key')).toBe('unconfirmed')
  expect(inspect).toHaveBeenCalledExactlyOnceWith(session.control, original.key)
  expect(submit).not.toHaveBeenCalled()
  expect(rejoin).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentSteerQueues[session.id]![0]!).toMatchObject({
    operationId: 'unknown-key',
    runId: 'review-run',
    inputReceipt: original,
  })
})
it('keeps the captured Core input usable after the actual Composer loses its presentation Session', async () => {
  useAppStore.setState({
    sessions: [session],
    agentSteerQueues: {},
    agentSteerInFlight: {},
    agentSteerInFlightPhase: {},
    agentComposerDrafts: { [session.id]: 'retained input' },
  } as never)
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  const inspect = vi.spyOn(api.sessions, 'inspectInput').mockResolvedValue(null)
  const failure = Object.assign(new Error('Original writer unavailable'), {
    code: 'AGENT_PROMPT_PREPARATION_FAILED',
    cause: new Error('Original transport cause'),
  })
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(failure)
  const reports = vi.spyOn(api.sessions, 'recordDeliveryFailure').mockImplementation(async (record) => ({
    logId: record.logId,
    availability: 'found',
    record,
    persistence: 'confirmed',
    issue: null,
  }))
  await dom.render(createElement(AgentSessionComposer, { sessionId: session.id }))
  let removed = false
  const unsubscribe = useAppStore.subscribe((state) => {
    if (!removed && state.agentSteerQueues[session.id]?.length) {
      removed = true
      useAppStore.setState({ sessions: [] })
    }
  })
  try {
    const input = dom.container.querySelector<HTMLElement>('[contenteditable="true"]')!
    expect(input.textContent).toBe('retained input')
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }),
      )
      await vi.waitFor(() => expect(useAppStore.getState().agentSteerQueues[session.id]?.[0]?.logId).toBeDefined())
      await vi.waitFor(() => expect(useAppStore.getState().agentSteerInFlight[session.id]).toBeUndefined())
    })
  } finally {
    unsubscribe()
  }
  const original = useAppStore.getState().agentSteerQueues[session.id]![0]!
  expect(removed).toBe(true)
  expect(useAppStore.getState().sessions).toEqual([])
  expect(submit).toHaveBeenCalledExactlyOnceWith(
    session.control,
    'retained input',
    original.operationId,
    { expectedRun: session.control.run, admissionIntent: { kind: 'manual-actor' } },
    { execution: 'immediate' },
    true,
    undefined,
    undefined,
  )
  expect(reports).toHaveBeenCalledOnce()
  expect(reports.mock.calls[0]![0]).toMatchObject({
    operationId: original.operationId,
    hostId: 'local',
    stage: 'core-submit',
    error: {
      code: failure.code,
      message: failure.message,
      cause: { message: 'Original transport cause' },
    },
  })
  const unknown = { ...waiting(original.operationId), status: 'unknown' as const }
  inspect.mockResolvedValue(unknown)
  const rejoin = vi.spyOn(api.sessions, 'rejoinInputWaiting')
  let result: string | undefined
  await act(async () => {
    result = await useAppStore.getState().sendQueuedAgentSteer(session.id, original.operationId)
  })
  expect(result).toBe('unconfirmed')
  expect(inspect).toHaveBeenLastCalledWith(session.control, unknown.key)
  expect(submit).toHaveBeenCalledOnce()
  expect(rejoin).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentSteerQueues[session.id]![0]).toMatchObject({
    operationId: original.operationId,
    inputReceipt: unknown,
  })
})
