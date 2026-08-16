import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentTimelineItem } from '@agentmux/core'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import type { RuntimeEvent, SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

const initial = useAppStore.getState()
afterEach(() => { useAppStore.setState(initial, true); vi.restoreAllMocks() })

function session(): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    id: 's', kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local',
    workspacePath: '/repo', label: 'Agent', createdAt: 1, updatedAt: 1,
    processState: 'running', status: { state: 'working', source: 'native-hook', observedAt: 1 },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: true, replyCorrelation: 'none' },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: 's', run: { runId: 'r' } }
  }
}

function message(operationId: string, overrides: Partial<AgentTimelineItem> = {}): AgentTimelineItem {
  return { id: `prompt:${operationId}`, agentSessionId: 's', kind: 'user_message', status: 'complete',
    source: 'user', title: 'Prompt', content: 'same words', createdAt: 1, updatedAt: 1, ...overrides }
}

function timelineEvent(item: AgentTimelineItem): RuntimeEvent {
  return { type: 'core', hostId: 'local', event: {
    type: 'agent-timeline', agentSessionId: 's', revision: 1,
    mutation: { type: 'append', agentSessionId: 's', item },
    evidence: { source: 'user', observedAt: 2, run: { runId: 'r' } }
  } }
}

const queued = { operationId: 'sent-operation', runId: 'r', text: 'same words', status: 'queued' as const }

describe('pending Outbox converges with durable Core delivery', () => {
  it('restored successful operations leave pending without submitting again, even if the Run ended', async () => {
    const stopped = { ...session(), processState: 'exited' as const }
    useAppStore.setState({ sessions: [stopped],
      agentSteerQueues: JSON.parse(JSON.stringify({ s: [queued] })),
      timelines: JSON.parse(JSON.stringify({ s: { agentSessionId: 's', revision: 1, items: [message(queued.operationId)] } })) })
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
    await useAppStore.getState().flushAgentSteerQueue('s')
    expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()
    expect(submit).not.toHaveBeenCalled()
  })

  it('preserves an identical-text unsent operation and sends only that remaining operation', async () => {
    const unsent = { ...queued, operationId: 'new-operation' }
    useAppStore.setState({ sessions: [session()], agentSteerQueues: { s: [queued, unsent] },
      timelines: { s: { agentSessionId: 's', revision: 1, items: [message(queued.operationId)] } } })
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
    await useAppStore.getState().flushAgentSteerQueue('s')
    expect(submit.mock.calls.map((call) => call[2])).toEqual([unsent.operationId])
    expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()
  })

  it.each([
    { kind: 'assistant_message' as const },
    { status: 'streaming' as const },
    { agentSessionId: 'other' },
    { id: 'native-transcript-message' }
  ])('does not confuse other evidence with delivery: %j', async (overrides) => {
    useAppStore.setState({ sessions: [{ ...session(), processState: 'exited' }], agentSteerQueues: { s: [queued] },
      timelines: { s: { agentSessionId: 's', revision: 1, items: [message(queued.operationId, overrides)] } } })
    await useAppStore.getState().flushAgentSteerQueue('s')
    expect(useAppStore.getState().agentSteerQueues.s).toEqual([queued])
  })

  it('a delivery event clears pending before its RPC returns; a late rejection cannot revive it', async () => {
    useAppStore.setState({ sessions: [session()], agentSteerQueues: { s: [queued] } })
    let reject!: (error: Error) => void
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    const drain = useAppStore.getState().flushAgentSteerQueue('s')
    await Promise.resolve()
    expect(submit).toHaveBeenCalledTimes(1)
    useAppStore.getState().applyEvent(timelineEvent(message(queued.operationId)))
    expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()
    reject(new Error('reply channel disconnected after Core committed delivery'))
    await drain
    expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()
    expect(useAppStore.getState().agentSteerInFlight.s).toBeUndefined()
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('timeline gap recovery clears delivered queue entries without issuing a retry', async () => {
    useAppStore.setState({ sessions: [session()], agentSteerQueues: { s: [queued] } })
    vi.spyOn(api.sessions, 'timeline').mockResolvedValue({ agentSessionId: 's', revision: 2, items: [message(queued.operationId)] })
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
    await useAppStore.getState().resyncTimeline('s')
    expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()
    expect(submit).not.toHaveBeenCalled()
  })

  it('unrelated activity events do not wake a deferred pending send', async () => {
    const pending = { ...queued, status: 'deferred' as const, error: 'not ready' }
    useAppStore.setState({ sessions: [session()], agentSteerQueues: { s: [pending] } })
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
    useAppStore.getState().applyEvent(timelineEvent(message('other-operation', { kind: 'tool_call' })))
    await Promise.resolve()
    expect(useAppStore.getState().agentSteerQueues.s).toEqual([pending])
    expect(submit).not.toHaveBeenCalled()
  })
})
