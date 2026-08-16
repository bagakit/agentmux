import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { AgentComposer } from '../src/renderer/src/components/AgentComposer'

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
 * vitest cannot run on this machine (Gatekeeper hang); every assertion is written to be correct by
 * inspection and each names the exact production line to mutate.
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

    await useAppStore.getState().send('s', 'do the thing')

    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0]?.[1]).toBe('do the thing')
    // Delivered → the entry is gone. If the renderer kept a parallel "in-flight/accepted" record, this
    // would linger. MUTATION: in flushAgentSteerQueue's success branch (store.ts:4529-4535) skip the
    // delete — the queue stays non-empty → red.
    expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()
  })

  it('a rejected send is RETAINED for retry and send() reports the retention (draft must be kept)', async () => {
    useAppStore.setState({ sessions: [agent('s', 'r') as never] })
    vi.spyOn(useAppStore.getState(), 'reportError').mockImplementation(() => {})
    vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(new Error('link dropped'))

    // send() must THROW so the Composer keeps the draft; the entry must remain queued for the next flush.
    // MUTATION: make flushAgentSteerQueue delete the entry on catch (store.ts:4537-4547) — send() no longer
    // throws and the entry vanishes → both assertions red.
    await expect(useAppStore.getState().send('s', 'retry me')).rejects.toThrow()
    expect(useAppStore.getState().agentSteerQueues.s).toEqual([
      { operationId: expect.any(String), runId: 'r', text: 'retry me' }
    ])
  })

  it('no double-send: a retry replays the SAME operationId, which is Core’s only anti-double-send key', async () => {
    useAppStore.setState({ sessions: [agent('s', 'r') as never] })
    vi.spyOn(useAppStore.getState(), 'reportError').mockImplementation(() => {})
    const ids: string[] = []
    const submit = vi.spyOn(api.sessions, 'submitPrompt')
    submit.mockImplementationOnce(async (_c, _p, operationId) => { ids.push(operationId!); throw new Error('busy') })
    submit.mockImplementationOnce(async (_c, _p, operationId) => { ids.push(operationId!) })

    useAppStore.getState().enqueueAgentSteer('s', 'once')
    await useAppStore.getState().flushAgentSteerQueue('s') // fails, retains
    await useAppStore.getState().flushAgentSteerQueue('s') // retries with same id

    expect(ids).toHaveLength(2)
    // Same id → Core recognizes the idempotent replay instead of writing twice. MUTATION: mint a fresh id
    // per attempt in enqueueAgentSteer/flush (e.g. crypto.randomUUID() at flush time instead of using
    // entry.operationId, store.ts:4528) — the two ids differ → red.
    expect(ids[0]).toBe(ids[1])
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
      { operationId: expect.any(String), runId: 'run-1', text: 'stale' }
    ])
  })
})

describe('badge keeps Host-accepted separate from Provider-consumed/unknown at the UI layer', () => {
  function render(deliverable: boolean): string {
    return renderToStaticMarkup(createElement(AgentComposer, {
      value: '', disabled: false, placeholder: '',
      queued: ['a', 'b'], queueDeliverable: deliverable, onChange: () => {}
    }))
  }

  it('a live run promises delivery-in-order; it never claims the Agent replied or accepted', () => {
    const markup = render(true)
    expect(markup).toContain('queued for delivery')
    expect(markup).toContain('Delivered in this order when the Agent finishes its current turn.')
    // "queued for delivery" is Host-accepted intent, NOT proof the Provider consumed anything.
    // MUTATION: change the deliverable-branch copy in AgentComposer.tsx:300 to say "replied"/"accepted" —
    // this pair splits → red.
    expect(markup.toLowerCase()).not.toContain('replied')
    expect(markup.toLowerCase()).not.toContain('accepted')
  })

  it('an ended run does not promise delivery and says where the words are kept', () => {
    const markup = render(false)
    expect(markup).not.toContain('queued for delivery')
    expect(markup).toContain('not sent')
    // MUTATION: collapse the two branches to one optimistic label (AgentComposer.tsx:284-285) — a
    // non-deliverable queue would read "queued for delivery" → red.
    expect(markup).toContain('kept here')
  })
})
