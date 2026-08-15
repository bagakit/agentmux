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
  it('keeps the failed prompt queued for retry', async () => {
    const session = { id: 's', kind: 'agent', control: { kind: 'agent', hostId: 'local', agentSessionId: 's', run: { runId: 'r' } }, status: { state: 'working', observedAt: 1 }, processState: 'running' }
    useAppStore.setState({ sessions: [session as never] })
    vi.spyOn(api.sessions, 'respondInteraction').mockResolvedValue(undefined)
    vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(new Error('busy'))
    vi.spyOn(useAppStore.getState(), 'reportError').mockImplementation(() => {})
    useAppStore.getState().enqueueAgentSteer('s', 'retry me')
    await useAppStore.getState().respondInteraction('s', { requestId: 'q', response: { kind: 'permission', decision: 'allow' } } as never)
    expect(useAppStore.getState().agentSteerQueues.s).toEqual([{ operationId: expect.any(String), text: 'retry me' }])
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
