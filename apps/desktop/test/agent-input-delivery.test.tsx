import { afterEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
const initial = useAppStore.getState()
afterEach(() => { useAppStore.setState(initial, true); vi.restoreAllMocks() })
describe('queued steer delivery', () => {
  it('answers the typed interaction first, then delivers queued prompts in order', async () => {
    const calls: string[] = []
    const session = { id: 's', kind: 'agent', control: { kind: 'agent', hostId: 'local', agentSessionId: 's', run: { runId: 'r' } }, status: { state: 'working', observedAt: 1 }, processState: 'running' }
    useAppStore.setState({ sessions: [session as never] })
    vi.spyOn(api.sessions, 'respondInteraction').mockImplementation(async () => { calls.push('response') })
    vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (_c, prompt) => { calls.push(prompt) })
    useAppStore.getState().enqueueAgentSteer('s', 'first')
    useAppStore.getState().enqueueAgentSteer('s', 'second')
    await useAppStore.getState().respondInteraction('s', { requestId: 'q', response: { kind: 'permission', decision: 'allow' } } as never)
    expect(calls).toEqual(['response', 'first', 'second'])
    expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()
  })
  it('keeps the undelivered prompt queued for retry, not marked dead', async () => {
    const session = { id: 's', kind: 'agent', control: { kind: 'agent', hostId: 'local', agentSessionId: 's', run: { runId: 'r' } }, status: { state: 'working', observedAt: 1 }, processState: 'running' }
    useAppStore.setState({ sessions: [session as never] })
    vi.spyOn(api.sessions, 'respondInteraction').mockResolvedValue(undefined)
    vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(new Error('busy'))
    useAppStore.getState().enqueueAgentSteer('s', 'retry me')
    await useAppStore.getState().respondInteraction('s', { requestId: 'q', response: { kind: 'permission', decision: 'allow' } } as never)
    // `deferred`, not `failed`: the session's processState is 'running', so the Agent is alive and this
    // rejection is our own step not completing. Asserting `failed` here pinned the inverse — a live
    // Agent's message judged terminal, which also head-of-line-blocked everything behind it.
    expect(useAppStore.getState().agentSteerQueues.s).toEqual([{ operationId: expect.any(String), runId: 'r', text: 'retry me', status: 'deferred', error: expect.any(String) }])
  })
})

  it('does not report success as failure when an identical prompt was already queued', async () => {
    const session = { id: 's', kind: 'agent', control: { kind: 'agent', hostId: 'local', agentSessionId: 's', run: { runId: 'r' } }, status: { state: 'working', observedAt: 1 }, processState: 'running' }
    useAppStore.setState({ sessions: [session as never] })
    vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
    useAppStore.getState().enqueueAgentSteer('s', 'same')
    await expect(useAppStore.getState().send('s', 'same')).resolves.toBeUndefined()
    expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()
  })
