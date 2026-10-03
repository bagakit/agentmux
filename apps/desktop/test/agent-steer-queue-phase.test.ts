const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import type { SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

const initial = useAppStore.getState()
const gates: Array<{ resolve(): void }> = []
const drains: Promise<void>[] = []

function agent(id = 'phase-session'): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    id, kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local',
    workspacePath: _hygiene_fixturePath("repo"), label: 'Agent', createdAt: 1, updatedAt: 1,
    agentSessionUpdatedAt: 1, promptSubmissionPredecessor: null,
    processState: 'running', status: { state: 'working', source: 'native-hook', observedAt: 1 },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: true, replyCorrelation: 'none' },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `${id}-run` } }
  }
}

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  const value = { promise, resolve }
  gates.push(value)
  return value
}

function enqueue(sessionId: string, operationId: string) {
  expect(useAppStore.getState().enqueueAgentSteer(sessionId, `Private fixture ${operationId}`, undefined, operationId)).toBe(true)
  return useAppStore.getState().agentSteerQueues[sessionId]!.find(entry => entry.operationId === operationId)!
}

function send(sessionId: string, operationId: string) {
  const promise = useAppStore.getState().sendQueuedAgentSteer(sessionId, operationId)
  drains.push(promise)
  return promise
}

function expectReleased(sessionId: string) {
  expect(useAppStore.getState().agentSteerInFlight[sessionId]).toBeUndefined()
  expect(useAppStore.getState().agentSteerInFlightPhase[sessionId]).toBeUndefined()
}

beforeEach(async () => {
  // Open the existing real admission write fence, then isolate the private preview Store.
  const dispose = await useAppStore.getState().initialize()
  dispose()
  useAppStore.setState(initial, true)
  vi.spyOn(api.sessions, 'refresh').mockImplementation(async control => {
    const current = useAppStore.getState().sessions.find(session => control.kind === 'agent' && session.id === control.agentSessionId)
    if (!current) throw new Error('Missing private Session fixture')
    return current
  })
})

afterEach(async () => {
  for (const value of gates) value.resolve()
  await Promise.allSettled(drains)
  gates.length = 0
  drains.length = 0
  useAppStore.setState(initial, true)
  vi.restoreAllMocks()
})

describe('the existing queue drain publishes its actual transient phase', () => {
  it('prepares and submits the selected exact intent rather than the older queue head', async () => {
    const session = agent()
    useAppStore.setState({ sessions: [session] })
    const head = enqueue(session.id, 'queue-only-head')
    const selected = enqueue(session.id, 'selected-tail')
    const preparation = gate(), submission = gate()
    const refresh = vi.mocked(api.sessions.refresh).mockImplementation(async () => { await preparation.promise; return session })
    const observed: Array<[string | undefined, string | undefined]> = []
    const release = useAppStore.subscribe(state => observed.push([
      state.agentSteerInFlight[session.id], state.agentSteerInFlightPhase[session.id]
    ]))
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (_control, _text, operationId) => {
      expect(operationId).toBe(selected.operationId)
      expect(useAppStore.getState().agentSteerInFlight[session.id]).toBe(selected.operationId)
      expect(useAppStore.getState().agentSteerInFlightPhase[session.id]).toBe('submitting')
      await submission.promise
    })
    try {
      const drain = send(session.id, selected.operationId)
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
      expect(useAppStore.getState().agentSteerInFlight[session.id]).toBe(selected.operationId)
      expect(useAppStore.getState().agentSteerInFlightPhase[session.id]).toBe('preparing')
      expect(submit).not.toHaveBeenCalled()
      useAppStore.getState().removeAgentSteer(session.id, selected.operationId)
      useAppStore.getState().moveAgentSteer(session.id, selected.operationId, 'up')
      expect(useAppStore.getState().agentSteerQueues[session.id]).toEqual([head, { ...selected, execution: 'default' }])
      preparation.resolve()
      await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
      expect(useAppStore.getState().agentSteerInFlightPhase[session.id]).toBe('submitting')
      const joined = send(session.id, selected.operationId)
      expect(submit).toHaveBeenCalledTimes(1)
      submission.resolve()
      await Promise.all([drain, joined])
      expect(useAppStore.getState().agentSteerQueues[session.id]).toEqual([head])
      expectReleased(session.id)
      expect(observed).toContainEqual([selected.operationId, 'preparing'])
      expect(observed).toContainEqual([selected.operationId, 'submitting'])
      expect(observed.every(([id, phase]) => id === undefined ? phase === undefined : id === selected.operationId && phase !== undefined)).toBe(true)
    } finally { release() }
  })

  it('keeps preparation failure with the original identity and releases both transient facts', async () => {
    const session = agent()
    useAppStore.setState({ sessions: [session] })
    const entry = enqueue(session.id, 'prepare-error')
    const preparation = gate()
    const refresh = vi.mocked(api.sessions.refresh).mockImplementation(async () => {
      await preparation.promise
      throw new Error('Preparation read unavailable')
    })
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
    const drain = send(session.id, entry.operationId)
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(useAppStore.getState().agentSteerInFlightPhase[session.id]).toBe('preparing')
    preparation.resolve()
    await drain
    expect(submit).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentSteerQueues[session.id]).toEqual([
      { ...entry, execution: 'default', status: 'deferred', error: 'Preparation read unavailable' }
    ])
    expectReleased(session.id)
  })

  it('retains unknown submission outcome without leaving a sending phase or changing the operation', async () => {
    const session = agent()
    useAppStore.setState({ sessions: [session] })
    const entry = enqueue(session.id, 'unknown-receipt')
    const submission = gate()
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async () => {
      await submission.promise
      throw new Error('Original input outcome is unknown')
    })
    const drain = send(session.id, entry.operationId)
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    expect(useAppStore.getState().agentSteerInFlight[session.id]).toBe(entry.operationId)
    expect(useAppStore.getState().agentSteerInFlightPhase[session.id]).toBe('submitting')
    submission.resolve()
    await drain
    expect(useAppStore.getState().agentSteerQueues[session.id]).toEqual([
      { ...entry, execution: 'default', promptCondition: { expectedRun: session.control.run, afterSubmissionId: null },
        status: 'deferred', error: 'Original input outcome is unknown' }
    ])
    expectReleased(session.id)
    await useAppStore.getState().flushAgentSteerQueue(session.id)
    expect(submit).toHaveBeenCalledTimes(1)
    expectReleased(session.id)
  })

  it.each(['coded', 'serialized diagnostic'] as const)('retains a real BUSY %s refusal on the exact queued operation', async shape => {
    const session = agent()
    useAppStore.setState({ sessions: [session] })
    const head = enqueue(session.id, 'queue-only-head')
    const entry = enqueue(session.id, 'busy-selected-tail')
    const submission = gate()
    const message = shape === 'coded' ? 'Original preceding submission is still busy'
      : 'Original preceding submission is still busy. Diagnostic: code=AGENT_PROMPT_SUBMISSION_BUSY'
    const refusal = shape === 'coded' ? Object.assign(new Error(message), { code: 'AGENT_PROMPT_SUBMISSION_BUSY' }) : new Error(message)
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (control, text, operationId, condition) => {
      expect(control).toEqual(session.control)
      expect(text).toBe(entry.text)
      expect(operationId).toBe(entry.operationId)
      expect(condition).toEqual({ expectedRun: session.control.run, afterSubmissionId: null })
      await submission.promise
      throw refusal
    })
    const drain = send(session.id, entry.operationId)
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    expect(useAppStore.getState().agentSteerInFlight[session.id]).toBe(entry.operationId)
    expect(useAppStore.getState().agentSteerInFlightPhase[session.id]).toBe('submitting')
    submission.resolve()
    await drain
    const retained = useAppStore.getState().agentSteerQueues[session.id]!
    expect(retained[0]).toEqual(head)
    expect(retained[1]).toEqual({ ...entry, execution: 'default', promptCondition: { expectedRun: session.control.run, afterSubmissionId: null }, status: 'deferred',
      error: message, ...(shape === 'coded' ? { errorCode: 'AGENT_PROMPT_SUBMISSION_BUSY' } : {}) })
    expect(submit).toHaveBeenCalledTimes(1)
    expectReleased(session.id)
  })

  it.each(['recovery', 'storage'] as const)('keeps its original recovery cause while %s is pending', async waiting => {
    const session = agent()
    useAppStore.setState({ sessions: [session] })
    const { runId: _run, ...unbound } = enqueue(session.id, 'unbound-original-cause')
    const original = { ...unbound, status: 'deferred' as const, errorCode: 'ORIGINAL_RECOVERY_CAUSE', error: 'Keep the saved recovery cause.' }
    useAppStore.setState({ agentSteerQueues: { [session.id]: [original] } })
    const preparation = gate()
    const recover = vi.spyOn(useAppStore.getState(), 'recoverSession').mockImplementation(async () => {
      if (waiting === 'recovery') await preparation.promise
      return session
    })
    const flush = vi.spyOn(api.ui, 'requestStorageFlush').mockImplementation(async () => {
      if (waiting === 'storage') await preparation.promise
    })
    const refresh = vi.mocked(api.sessions.refresh).mockImplementation(async () => {
      expect(useAppStore.getState().agentSteerQueues[session.id]![0]).toMatchObject({ errorCode: original.errorCode, error: original.error })
      return session
    })
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(new Error('A new actual submission outcome'))
    const drain = send(session.id, original.operationId)
    await vi.waitFor(() => expect(waiting === 'recovery' ? recover : flush).toHaveBeenCalled())
    expect(useAppStore.getState().agentSteerQueues[session.id]![0]).toMatchObject({
      operationId: original.operationId, text: original.text, errorCode: original.errorCode, error: original.error
    })
    expect(submit).not.toHaveBeenCalled()
    preparation.resolve(); await drain
    expect(refresh).toHaveBeenCalledOnce()
    expect(useAppStore.getState().agentSteerQueues[session.id]![0]!.error).toBe('A new actual submission outcome')
    expectReleased(session.id)
  })

  it.each(['Host', 'Core Session'] as const)('rejects foreign %s preparation facts even when the Run string is equal', async replacement => {
    const session = agent()
    useAppStore.setState({ sessions: [session] })
    const entry = enqueue(session.id, 'foreign-preparation')
    const foreign = { ...session, ...(replacement === 'Host' ? { hostId: 'foreign-host' } : {}),
      control: { ...session.control, ...(replacement === 'Host' ? { hostId: 'foreign-host' } : { agentSessionId: 'foreign-session' }) } }
    vi.mocked(api.sessions.refresh).mockResolvedValue(foreign)
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
    await send(session.id, entry.operationId)
    expect(submit).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentSteerQueues[session.id]).toEqual([expect.objectContaining({
      operationId: entry.operationId, runId: entry.runId, text: entry.text, promptCondition: null
    })])
    expectReleased(session.id)
  })

  it.each(['Host', 'Core Session'] as const)('does not dispatch to a replacement %s while the original preparation is pending', async replacement => {
    const session = agent()
    useAppStore.setState({ sessions: [session] })
    const entry = enqueue(session.id, 'binding-during-preparation')
    const preparation = gate()
    const refresh = vi.mocked(api.sessions.refresh).mockImplementation(async () => { await preparation.promise; return session })
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
    const drain = send(session.id, entry.operationId)
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    useAppStore.setState({ sessions: [{ ...session, ...(replacement === 'Host' ? { hostId: 'replacement-host' } : {}),
      control: { ...session.control, ...(replacement === 'Host' ? { hostId: 'replacement-host' } : { agentSessionId: 'replacement-session' }) } }] })
    preparation.resolve(); await drain
    expect(submit).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentSteerQueues[session.id]).toEqual([expect.objectContaining({
      operationId: entry.operationId, runId: entry.runId, text: entry.text
    })])
    expectReleased(session.id)
  })

  it.each(['replacement Run', 'replacement predecessor', 'replacement Host'] as const)('a late failure cannot decorate the same operation with a %s', async replacement => {
    const session = agent()
    useAppStore.setState({ sessions: [session] })
    const entry = enqueue(session.id, 'late-original-operation')
    const submission = gate()
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async () => {
      await submission.promise
      throw Object.assign(new Error('Late original preparation failure'), { code: 'AGENT_PROMPT_PREPARATION_FAILED' })
    })
    const drain = send(session.id, entry.operationId)
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce())
    const run = replacement === 'replacement Run' ? { runId: 'new-original-session-run' } : session.control.run
    const current = { ...useAppStore.getState().agentSteerQueues[session.id]![0]!, runId: run.runId,
      promptCondition: replacement === 'replacement Host' ? useAppStore.getState().agentSteerQueues[session.id]![0]!.promptCondition : { expectedRun: run, afterSubmissionId: 'new-predecessor' }, error: 'Keep current reason', errorCode: 'CURRENT_OPERATION_CAUSE' }
    useAppStore.setState({ sessions: [{ ...session, ...(replacement === 'replacement Host' ? { hostId: 'other-host' } : {}),
      control: { ...session.control, run, ...(replacement === 'replacement Host' ? { hostId: 'other-host' } : {}) } }],
      agentSteerQueues: { [session.id]: [current] } })
    submission.resolve(); await drain
    expect(useAppStore.getState().agentSteerQueues[session.id]).toEqual([current])
    expect(submit).toHaveBeenCalledOnce()
    expectReleased(session.id)
  })

  it.each(['replacement Run', 'replacement predecessor', 'replacement Host'] as const)('a late ACK cannot remove the same operation with a %s', async replacement => {
    const session = agent()
    useAppStore.setState({ sessions: [session] })
    const entry = enqueue(session.id, 'late-ack-original-operation')
    const submission = gate()
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async () => { await submission.promise })
    const drain = send(session.id, entry.operationId)
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce())
    const run = replacement === 'replacement Run' ? { runId: 'new-original-session-run' } : session.control.run
    const current = { ...useAppStore.getState().agentSteerQueues[session.id]![0]!, runId: run.runId,
      promptCondition: replacement === 'replacement Host' ? useAppStore.getState().agentSteerQueues[session.id]![0]!.promptCondition : { expectedRun: run, afterSubmissionId: 'new-predecessor' }, error: 'Keep new row reason' }
    useAppStore.setState({ sessions: [{ ...session, ...(replacement === 'replacement Host' ? { hostId: 'other-host' } : {}),
      control: { ...session.control, run, ...(replacement === 'replacement Host' ? { hostId: 'other-host' } : {}) } }],
      agentSteerQueues: { [session.id]: [current] } })
    submission.resolve(); await drain
    expect(useAppStore.getState().agentSteerQueues[session.id]).toEqual([current])
    expect(submit).toHaveBeenCalledOnce()
    expectReleased(session.id)
  })

  it('does not mark an interaction-blocked or changed-Run intent as preparing or submitting', async () => {
    const session = agent()
    useAppStore.setState({ sessions: [session] })
    const entry = enqueue(session.id, 'retained-intent')
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
    useAppStore.setState({ sessions: [{ ...session, pendingInteraction: {
      requestId: 'private-request', kind: 'permission', summary: 'Pending decision',
      options: [{ id: 'allow', label: 'Allow' }], observedAt: 1
    } } as Extract<SessionSnapshot, { kind: 'agent' }>] })
    await send(session.id, entry.operationId)
    expect(submit).not.toHaveBeenCalled()
    expectReleased(session.id)
    useAppStore.setState({ sessions: [{ ...session, control: { ...session.control, run: { runId: 'replacement-run' } } }] })
    await send(session.id, entry.operationId)
    expect(submit).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentSteerQueues[session.id]).toEqual([{ ...entry, execution: 'default' }])
    expectReleased(session.id)
  })

  it('releases only the completed Session while another original drain is still submitting', async () => {
    const first = agent('first-session'), second = agent('second-session')
    useAppStore.setState({ sessions: [first, second] })
    const firstEntry = enqueue(first.id, 'first-operation'), secondEntry = enqueue(second.id, 'second-operation')
    const firstSubmission = gate(), secondSubmission = gate()
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (_control, _text, operationId) => {
      await (operationId === firstEntry.operationId ? firstSubmission : secondSubmission).promise
    })
    const firstDrain = send(first.id, firstEntry.operationId), secondDrain = send(second.id, secondEntry.operationId)
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2))
    expect(useAppStore.getState().agentSteerInFlightPhase).toEqual({ [first.id]: 'submitting', [second.id]: 'submitting' })
    firstSubmission.resolve()
    await firstDrain
    expectReleased(first.id)
    expect(useAppStore.getState().agentSteerInFlight[second.id]).toBe(secondEntry.operationId)
    expect(useAppStore.getState().agentSteerInFlightPhase[second.id]).toBe('submitting')
    secondSubmission.resolve()
    await secondDrain
    expectReleased(second.id)
  })

  it('starts a fresh owner during final release without inheriting the prior phase', async () => {
    const session = agent()
    useAppStore.setState({ sessions: [session] })
    const entry = enqueue(session.id, 'first-owner')
    const submission = gate()
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementationOnce(() => submission.promise).mockResolvedValue(undefined)
    let sawInFlight = false, admitted = false
    const release = useAppStore.subscribe(state => {
      if (state.agentSteerInFlight[session.id]) sawInFlight = true
      else if (sawInFlight && !admitted) {
        admitted = true
        expect(state.agentSteerInFlightPhase[session.id]).toBeUndefined()
        const next = enqueue(session.id, 'fresh-owner')
        send(session.id, next.operationId)
      }
    })
    try {
      const drain = send(session.id, entry.operationId)
      await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
      submission.resolve()
      await drain
      await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2))
      await Promise.all(drains)
      expect(submit.mock.calls.map(call => call[2])).toEqual(['first-owner', 'fresh-owner'])
      expect(useAppStore.getState().agentSteerQueues[session.id]).toBeUndefined()
      expectReleased(session.id)
    } finally { release() }
  })

  it('persists queued identity without persisting either in-flight display fact', async () => {
    const session = agent()
    useAppStore.setState({ sessions: [session] })
    const entry = enqueue(session.id, 'persistent-queue-only')
    const submission = gate()
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(() => submission.promise)
    const drain = send(session.id, entry.operationId)
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    const partialize = useAppStore.persist.getOptions().partialize
    expect(partialize).toBeTypeOf('function')
    const persisted = partialize!(useAppStore.getState())
    expect(persisted.agentSteerQueues[session.id]?.map(item => item.operationId)).toEqual([entry.operationId])
    expect(persisted).not.toHaveProperty('agentSteerInFlight')
    expect(persisted).not.toHaveProperty('agentSteerInFlightPhase')
    submission.resolve()
    await drain
    expectReleased(session.id)
  })
})
