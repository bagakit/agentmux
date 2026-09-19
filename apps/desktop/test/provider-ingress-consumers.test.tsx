import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { ComposerOutbox } from '../src/renderer/src/components/ComposerOutbox'

/**
 * T-002 gate: the renderer consumes ONE delivery owner (Core, via api.sessions.submitPrompt) and keeps
 * only its genuinely local concerns — the draft box, the queue-for-later UX, retry-retention, and badge
 * wording. These are the acceptance criteria as behaviour, not a source scan.
 *
 * The store IS the production consumer here: enqueueAgentSteer / flushAgentSteerQueue / send are the real
 * store actions, and the ONLY byte-emitting call they make is api.sessions.submitPrompt (the IPC bridge to
 * Core's single delivery owner). We assert on what reaches that call, so a convergence that re-introduces a
 * second delivery state machine, drops the operationId reuse, or clears an edited draft fails here.
 *
 */

const initial = useAppStore.getState()
let dispose: (() => void) | undefined
beforeAll(async () => { dispose = await useAppStore.getState().initialize() })
afterAll(() => { dispose?.() })
let releasePending: (() => void) | undefined
beforeEach(() => {
  vi.spyOn(api.sessions, 'refresh').mockImplementation(async control => {
    const session = useAppStore.getState().sessions.find(item => item.id === control.agentSessionId)
    if (!session) throw new Error('Private projected Session is unavailable')
    return structuredClone(session)
  })
})
afterEach(async () => {
  releasePending?.(); releasePending = undefined
  await useAppStore.getState().flushAgentSteerQueue('s')
  useAppStore.setState(initial, true); vi.restoreAllMocks()
})

function agent(id: string, runId: string, processState = 'running') {
  return {
    id,
    kind: 'agent',
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId } },
    status: { state: 'working', observedAt: 1 },
    processState,
    promptSubmissionPredecessor: null
  }
}

describe('renderer routes every send through Core, retaining nothing of Core’s job', () => {
  it('binds each queue tail at its first dispatch, after the preceding admission', async () => {
    useAppStore.setState({ sessions: [agent('s', 'r') as never] })
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (_control, _text, operationId) => {
      useAppStore.setState({ sessions: [{ ...agent('s', 'r'), promptSubmissionPredecessor: operationId } as never] })
    })
    expect(useAppStore.getState().enqueueAgentSteer('s', 'head')).toBe(true)
    expect(useAppStore.getState().enqueueAgentSteer('s', 'tail')).toBe(true)
    const original = structuredClone(useAppStore.getState().agentSteerQueues.s!)
    expect(original.map(entry => entry.promptCondition)).toEqual([null, null])
    await useAppStore.getState().flushAgentSteerQueue('s')
    expect(submit.mock.calls.map(call => [call[2], call[3]])).toEqual([
      [original[0]!.operationId, { expectedRun: { runId: 'r' }, afterSubmissionId: null }],
      [original[1]!.operationId, { expectedRun: { runId: 'r' }, afterSubmissionId: original[0]!.operationId }]
    ])
    expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()
  })

  it('saves the first condition before IPC and retains it after lost ACK and later admission', async () => {
    useAppStore.setState({ sessions: [agent('s', 'r') as never], agentComposerDrafts: { s: 'original' } })
    const commit = vi.spyOn(api.ui, 'requestStorageFlush').mockImplementation(async () => {
      const entry = useAppStore.getState().agentSteerQueues.s?.[0]
      if (entry) expect(entry.promptCondition).toEqual({ expectedRun: { runId: 'r' }, afterSubmissionId: null })
    })
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementationOnce(async (_control, _text, operationId) => {
      expect(commit).toHaveBeenCalled()
      expect(useAppStore.getState().agentSteerQueues.s?.[0]?.promptCondition).toEqual({
        expectedRun: { runId: 'r' }, afterSubmissionId: null })
      useAppStore.setState({ sessions: [{ ...agent('s', 'r'), promptSubmissionPredecessor: operationId } as never] })
      throw new Error('ACK lost after Host acceptance')
    }).mockRejectedValue(new Error('Historical delivery is unknown'))
    expect(useAppStore.getState().send('s', 'original')).toBe(true)
    await useAppStore.getState().flushAgentSteerQueue('s')
    const intent = structuredClone(useAppStore.getState().agentSteerQueues.s![0]!)
    useAppStore.setState({ sessions: [{ ...agent('s', 'r'), promptSubmissionPredecessor: 'later-admission' } as never] })
    useAppStore.getState().setAgentComposerDraft('s', 'new unsent draft')
    await useAppStore.getState().sendQueuedAgentSteer('s', intent.operationId)
    expect(submit.mock.calls.map(call => [call[2], call[3]])).toEqual([
      [intent.operationId, intent.promptCondition], [intent.operationId, intent.promptCondition]
    ])
    expect(api.sessions.refresh).toHaveBeenCalledOnce()
    expect(useAppStore.getState().agentSteerQueues.s![0]).toMatchObject({
      operationId: intent.operationId, promptCondition: intent.promptCondition, text: 'original' })
    expect(useAppStore.getState().agentComposerDrafts.s).toBe('new unsent draft')
    expect(useAppStore.getState().sessions.map(session => [session.id, session.control.run.runId])).toEqual([['s', 'r']])
  })

  it('restores a bound intent without preparing it against newer Core facts', async () => {
    useAppStore.setState({ sessions: [{ ...agent('s', 'r'), promptSubmissionPredecessor: 'newer' } as never],
      agentSteerQueues: { s: [{ operationId: 'restored', runId: 'r', text: 'kept', status: 'deferred',
        promptCondition: { expectedRun: { runId: 'r' }, afterSubmissionId: 'original-predecessor' } }] } })
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue()
    await useAppStore.getState().sendQueuedAgentSteer('s', 'restored')
    expect(submit).toHaveBeenCalledWith(expect.any(Object), 'kept', 'restored', {
      expectedRun: { runId: 'r' }, afterSubmissionId: 'original-predecessor'
    }, undefined, { allowUncertainTurn: true })
    expect(api.sessions.refresh).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()
  })

  it('keeps an historical intent with missing conditions unknown instead of sending it anew', async () => {
    useAppStore.setState({ sessions: [agent('s', 'r') as never],
      agentSteerQueues: { s: [{ operationId: 'historical', runId: 'r', text: 'kept', status: 'deferred' }] } })
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue()
    await useAppStore.getState().sendQueuedAgentSteer('s', 'historical')
    expect(submit).not.toHaveBeenCalled()
    expect(api.sessions.refresh).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentSteerQueues.s).toEqual([{ operationId: 'historical', runId: 'r', text: 'kept',
      status: 'deferred', error: expect.stringContaining('original message delivery condition is unknown') }])
    expect(useAppStore.getState().sessions.map(session => [session.id, session.processState])).toEqual([['s', 'running']])
  })

  it('prepares again after a first pre-admission BUSY, while keeping the operation and text', async () => {
    useAppStore.setState({ sessions: [agent('s', 'r') as never] })
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementationOnce(async () => {
      throw Object.assign(new Error('Another owner is active'), { code: 'AGENT_PROMPT_SUBMISSION_BUSY' })
    }).mockResolvedValue()
    expect(useAppStore.getState().send('s', 'kept')).toBe(true)
    await useAppStore.getState().flushAgentSteerQueue('s')
    const intent = useAppStore.getState().agentSteerQueues.s![0]!
    expect(intent.promptCondition).toBeNull()
    useAppStore.setState({ sessions: [{ ...agent('s', 'r'), promptSubmissionPredecessor: 'other-owner-admitted' } as never] })
    await useAppStore.getState().sendQueuedAgentSteer('s', intent.operationId)
    expect(submit.mock.calls.map(call => [call[2], call[3]])).toEqual([
      [intent.operationId, { expectedRun: { runId: 'r' }, afterSubmissionId: null }],
      [intent.operationId, { expectedRun: { runId: 'r' }, afterSubmissionId: 'other-owner-admitted' }]
    ])
    expect(api.sessions.refresh).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()
  })

  it('does not use a later BUSY to refresh a previously unknown intent', async () => {
    useAppStore.setState({ sessions: [agent('s', 'r') as never] })
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValueOnce(new Error('ACK is unknown'))
      .mockRejectedValue(Object.assign(new Error('Another owner is active'), { code: 'AGENT_PROMPT_SUBMISSION_BUSY' }))
    expect(useAppStore.getState().send('s', 'kept')).toBe(true)
    await useAppStore.getState().flushAgentSteerQueue('s')
    const intent = structuredClone(useAppStore.getState().agentSteerQueues.s![0]!)
    useAppStore.setState({ sessions: [{ ...agent('s', 'r'), promptSubmissionPredecessor: 'newer' } as never] })
    await useAppStore.getState().sendQueuedAgentSteer('s', intent.operationId)
    expect(submit.mock.calls.map(call => call[3])).toEqual([intent.promptCondition, intent.promptCondition])
    expect(useAppStore.getState().agentSteerQueues.s![0]!.promptCondition).toEqual(intent.promptCondition)
    expect(api.sessions.refresh).toHaveBeenCalledOnce()
  })

  it('a successful send reaches Core once and then clears the queue (no renderer-side second machine)', async () => {
    useAppStore.setState({ sessions: [agent('s', 'r') as never] })
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)

    expect(useAppStore.getState().send('s', 'do the thing')).toBe(true)
    await vi.waitFor(() => expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined())

    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0]?.[1]).toBe('do the thing')
    // Delivered → the entry is gone. If the renderer kept a parallel "in-flight/accepted" record, this
    // would linger. MUTATION: in flushAgentSteerQueue's success branch (store.ts:4529-4535) skip the
    // delete — the queue stays non-empty → red.
    expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()
  })

  it('admission succeeds even if transport defers the entry for retry', async () => {
    useAppStore.setState({ sessions: [agent('s', 'r') as never] })
    vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(new Error('link dropped'))

    expect(useAppStore.getState().send('s', 'retry me')).toBe(true)
    await vi.waitFor(() => expect(useAppStore.getState().agentSteerQueues.s?.[0]?.status).toBe('deferred'))
    expect(useAppStore.getState().agentSteerQueues.s).toEqual([
      { operationId: expect.any(String), promptCondition: { expectedRun: { runId: 'r' }, afterSubmissionId: null }, runId: 'r', text: 'retry me', status: 'deferred', error: 'link dropped', enqueuedAt: expect.any(Number) }
    ])
  })

  it.each(['accepted', 'unknown'] as const)('a late %s receipt retains the edited draft and the queued intent identity', async result => {
    useAppStore.setState({ sessions: [agent('s', 'r') as never], agentComposerDrafts: { s: 'original' } })
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve; releasePending = resolve })
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementationOnce(async () => {
      await pending
      if (result === 'unknown') throw new Error('Input result is unknown')
    })
    expect(useAppStore.getState().send('s', 'original')).toBe(true)
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    const entry = useAppStore.getState().agentSteerQueues.s![0]!
    // Composer owns clearing its unchanged draft at admission; Store owns only delivery.
    expect(useAppStore.getState().agentComposerDrafts.s).toBe('original')
    useAppStore.getState().setAgentComposerDraft('s', 'new unsent draft')
    const drain = useAppStore.getState().flushAgentSteerQueue('s')
    release(); await drain
    expect(useAppStore.getState().agentComposerDrafts.s).toBe('new unsent draft')
    if (result === 'accepted') expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()
    else {
      expect(useAppStore.getState().agentSteerQueues.s).toEqual([
        { ...entry, status: 'deferred', error: 'Input result is unknown' }
      ])
      submit.mockResolvedValue(undefined)
      await useAppStore.getState().sendQueuedAgentSteer('s', entry.operationId)
      expect(submit.mock.calls.map(call => call[2])).toEqual([entry.operationId, entry.operationId])
      expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()
    }
    expect(useAppStore.getState().agentComposerDrafts.s).toBe('new unsent draft')
    expect(useAppStore.getState().sessions.map(session => [session.id, session.control.run.runId, session.status.state]))
      .toEqual([['s', 'r', 'working']])
  })

  it('auto-retries a deferred item and an explicit Send now reuses the SAME operationId', async () => {
    useAppStore.setState({ sessions: [agent('s', 'r') as never] })
    const ids: string[] = []
    const submit = vi.spyOn(api.sessions, 'submitPrompt')
    submit.mockImplementationOnce(async (_c, _p, operationId) => { ids.push(operationId!); throw new Error('busy') })
    submit.mockImplementationOnce(async (_c, _p, operationId) => { ids.push(operationId!); throw new Error('busy') })
    submit.mockImplementationOnce(async (_c, _p, operationId) => { ids.push(operationId!) })

    useAppStore.getState().enqueueAgentSteer('s', 'once')
    await useAppStore.getState().flushAgentSteerQueue('s') // refused, retained as deferred
    // The auto-flush MUST try again against a live Agent. This assertion used to read
    // `expect(ids).toHaveLength(1)` — it pinned the queue refusing to retry, i.e. the head-of-line block
    // that froze every entry behind a live-Agent refusal.
    await useAppStore.getState().flushAgentSteerQueue('s')
    expect(ids).toHaveLength(2)

    // Explicit "Send now" still reuses the id — the T-002 property this case exists for.
    const operationId = useAppStore.getState().agentSteerQueues.s![0]!.operationId
    await useAppStore.getState().sendQueuedAgentSteer('s', operationId)

    expect(ids).toHaveLength(3)
    // Same id every attempt → Core recognizes the idempotent replay instead of writing three times.
    // MUTATION: mint a fresh id per attempt in enqueueAgentSteer/flush (e.g. crypto.randomUUID() at flush
    // time instead of using entry.operationId, store.ts:4528) — the ids differ → red.
    expect(new Set(ids).size).toBe(1)
  })

  it('two distinct entries in the same queue keep distinct operationIds', async () => {
    // This is one Store queue. Separate public Core instances are exercised in the Core gate;
    // actual Control/Composer consumers are exercised in agent-explicit-steer.test.tsx.
    useAppStore.setState({ sessions: [agent('s', 'r') as never] })
    const ids: string[] = []
    vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (_c, _p, operationId) => { ids.push(operationId!) })

    useAppStore.getState().enqueueAgentSteer('s', 'from client A')
    useAppStore.getState().enqueueAgentSteer('s', 'from client B')
    await useAppStore.getState().flushAgentSteerQueue('s')

    expect(ids).toHaveLength(2)
    // MUTATION: reuse one id across entries (e.g. a module-level constant instead of crypto.randomUUID()
    // per enqueue, store.ts:4509) — ids collide → red, and Core would drop B as a replay of A.
    expect(ids[0]).not.toBe(ids[1])
  })

  it('a steer typed at an old run is NEVER delivered to the run that inherited the agentSessionId', async () => {
    // Run identity is the renderer’s local UX concern (which entries are still deliverable); the actual
    // accept/reject is Core’s, but the renderer must not even ATTEMPT to send a stale entry to a new run.
    useAppStore.setState({ sessions: [agent('s', 'run-1') as never] })
    useAppStore.getState().enqueueAgentSteer('s', 'stale')
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
    useAppStore.setState({ sessions: [agent('s', 'run-2') as never] }) // Resume: same session, new run

    await useAppStore.getState().flushAgentSteerQueue('s')

    // Not one byte goes out, and the stale entry is kept (its words are the user’s to discard, not this
    // loop’s). MUTATION: drop the steerEntryTargetsRun skip in flush (store.ts:4526) — submit is called
    // with the new run → red.
    expect(submit).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentSteerQueues.s).toEqual([
      { operationId: expect.any(String), promptCondition: null, runId: 'run-1', text: 'stale', status: 'queued', enqueuedAt: expect.any(Number) }
    ])
  })
})

describe('Outbox keeps Host-accepted separate from Provider-consumed/unknown at the UI layer', () => {
  function render(deliverable: boolean): string {
    return renderToStaticMarkup(createElement(ComposerOutbox, {
      queued: [{ id: 'a', text: 'a', status: 'queued', deliverable }, { id: 'b', text: 'b', status: 'queued', deliverable }]
    }))
  }

  it('a live Run offers explicit delivery without claiming Provider consumption', () => {
    const markup = render(true)
    expect(markup).toContain('queued for delivery')
    expect(markup).toContain('Send explicitly steers this message, including during the current turn.')
    expect(markup).toContain('It does not send the other queued messages.')
    // "queued for delivery" is Host-accepted intent, NOT proof the Provider consumed anything.
    // MUTATION: change the deliverable-branch copy in ComposerOutbox.tsx to say "replied"/"accepted" —
    // this pair splits → red.
    expect(markup.toLowerCase()).not.toContain('replied')
    expect(markup.toLowerCase()).not.toContain('accepted')
  })

  it('an ended run does not promise delivery and says where the words are kept', () => {
    const markup = render(false)
    expect(markup).not.toContain('queued for delivery')
    expect(markup).toContain('Not sent')
    // MUTATION: collapse the two branches to one optimistic label (ComposerOutbox.tsx) — a
    // non-deliverable queue would read "queued for delivery" → red.
    expect(markup).toContain('the bound Run is unavailable or changed')
    expect(markup).toContain('Its delivery result is unknown; it will not be replayed on another Run.')
    expect(markup).toContain('<span>a</span>')
    expect(markup).toContain('<span>b</span>')
  })
})
