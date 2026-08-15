import { afterEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

/**
 * T-008: a retry of the SAME prompt must reach Core with the SAME `operationId`, so the idempotent
 * same-id continuation Core already implements (prompt-submission.ts:186) becomes reachable from the
 * product. The id is a per-attempt correlation key carried on the steer-queue entry — never persisted,
 * never a store invariant. This pins the three properties the change turns on:
 *   (a) a retry of the same prompt reaches core with the same operationId
 *   (b) two different prompts get different ids
 *   (c) the steer queue keeps an entry's id stable across a FAILED flush and its retry
 */

const initial = useAppStore.getState()
afterEach(() => { useAppStore.setState(initial, true); vi.restoreAllMocks() })

function runningAgent(id = 's') {
  return { id, kind: 'agent', control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: 'r' } }, status: { state: 'working', observedAt: 1 }, processState: 'running' }
}

describe('steer queue operationId correlation (T-008)', () => {
  it('(c)+(a) keeps one entry\'s id stable across a failed flush and replays it on retry', async () => {
    useAppStore.setState({ sessions: [runningAgent() as never] })
    vi.spyOn(useAppStore.getState(), 'reportError').mockImplementation(() => {})
    const ids: string[] = []
    const submit = vi.spyOn(api.sessions, 'submitPrompt')
    // First flush rejects (Core busy / link drop) — the entry must be RETAINED for retry.
    submit.mockImplementationOnce(async (_c, _p, operationId) => { ids.push(operationId!); throw new Error('busy') })
    // Retry flush succeeds — must carry the SAME operationId, which is what makes Core recognize the replay.
    submit.mockImplementationOnce(async (_c, _p, operationId) => { ids.push(operationId!) })

    useAppStore.getState().enqueueAgentSteer('s', 'steer me')
    await useAppStore.getState().flushAgentSteerQueue('s')
    // Retained after the failure — same entry, same id still on it.
    expect(useAppStore.getState().agentSteerQueues.s).toEqual([{ operationId: ids[0], text: 'steer me' }])

    await useAppStore.getState().flushAgentSteerQueue('s')
    expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()

    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1]) // (a) retry reused the same id
    expect(ids[0]).toBeTruthy()
  })

  it('(b) two different prompts get two different ids', async () => {
    useAppStore.setState({ sessions: [runningAgent() as never] })
    const ids: string[] = []
    vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (_c, _p, operationId) => { ids.push(operationId!) })

    useAppStore.getState().enqueueAgentSteer('s', 'first prompt')
    useAppStore.getState().enqueueAgentSteer('s', 'second prompt')
    await useAppStore.getState().flushAgentSteerQueue('s')

    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
  })
})
