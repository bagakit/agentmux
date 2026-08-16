import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
afterEach(() => { useAppStore.setState(initial, true); vi.restoreAllMocks() })

function agent(id: string, runId: string, processState = 'running') {
  return {
    id,
    kind: 'agent',
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId } },
    status: { state: 'working', observedAt: 1 },
    processState
  }
}

describe('renderer routes every send through Core, retaining nothing of Core’s job', () => {
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
      { operationId: expect.any(String), runId: 'r', text: 'retry me', status: 'deferred', error: 'link dropped' }
    ])
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

  it('two concurrent clients’ distinct prompts each get their own operationId and both are sent', async () => {
    // Each renderer holds its OWN client-local queue; distinct prompts must both reach Core with distinct
    // ids (correct — they are different messages). This models the two-entry case in one store.
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
      { operationId: expect.any(String), runId: 'run-1', text: 'stale', status: 'queued' }
    ])
  })
})

describe('Outbox keeps Host-accepted separate from Provider-consumed/unknown at the UI layer', () => {
  function render(deliverable: boolean): string {
    return renderToStaticMarkup(createElement(ComposerOutbox, {
      queued: [{ id: 'a', text: 'a', status: 'queued', deliverable }, { id: 'b', text: 'b', status: 'queued', deliverable }]
    }))
  }

  it('a live run promises delivery-in-order; it never claims the Agent replied or accepted', () => {
    const markup = render(true)
    expect(markup).toContain('queued for delivery')
    expect(markup).toContain('Messages for the current Run are sent in order as soon as the Agent can accept them.')
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
    expect(markup).toContain('this message targets a Run that is no longer available here')
    expect(markup).toContain('<span>a</span>')
    expect(markup).toContain('<span>b</span>')
  })
})
