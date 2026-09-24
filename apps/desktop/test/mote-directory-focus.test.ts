import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import type { ScratchTopicSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { focusLaneForSession, sanitizeAgentFocus } from '../src/renderer/src/lib/agent-focus'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { scratchMoteTopics, scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { useAppStore } from '../src/renderer/src/store'
import { customAgent, customMoteId, customTab, defaultAgent, defaultTab, moteConfig, moteTopics,
  ordinaryAgent, ordinaryTab, ordinaryTopicId, scratchWorkspace, seedMoteWorkface } from './fixtures/mote-workface'

const baseline = useAppStore.getState()
beforeEach(() => { seedMoteWorkface(); useAppStore.setState({ reportError: vi.fn() }) })
afterEach(() => { vi.restoreAllMocks(); useAppStore.setState(baseline, true) })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

describe('shared filesystem Mote identity', () => {
  it('shares one nonempty raw snapshot for every consumer at the same revision', async () => {
    useAppStore.setState({ scratchTopicSnapshots: {} })
    const read = deferred<ScratchTopicSnapshot[]>()
    const list = vi.spyOn(api.scratch, 'listTopics').mockReturnValue(read.promise)
    const { refreshScratchTopics } = useAppStore.getState()
    const jobs = [refreshScratchTopics(SCRATCH_WORKSPACE_ID), refreshScratchTopics(SCRATCH_WORKSPACE_ID), refreshScratchTopics(SCRATCH_WORKSPACE_ID)]
    expect(list).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID)
    read.resolve(moteTopics); await Promise.all(jobs)
    const facts = useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!
    expect(facts.topics).toEqual(moteTopics)
    expect(facts.topics).toHaveLength(4)
    expect(scratchMoteTopics(facts.topics).map(topic => topic.id)).toEqual([PMO_TEAMS_TOPIC_ID, customMoteId, 'launcher:quiet'])
    await refreshScratchTopics(SCRATCH_WORKSPACE_ID)
    expect(list).toHaveBeenCalledOnce()
    expect(focusLaneForSession(customMoteId, facts.topics)).toBe('pmo')
    expect(focusLaneForSession(ordinaryTopicId, facts.topics)).toBe('execution')
  })

  it('ignores late old reads and retains complete SOUL facts beside later read failures', async () => {
    const sessions = useAppStore.getState().sessions
    useAppStore.setState({ scratchTopicSnapshots: {} })
    const old = deferred<ScratchTopicSnapshot[]>(), next = deferred<ScratchTopicSnapshot[]>()
    const list = vi.spyOn(api.scratch, 'listTopics').mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    const pendingOld = useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID)
    useAppStore.setState({ workspaceFileRevisions: { [SCRATCH_WORKSPACE_ID]: 1 } })
    const pendingNext = useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID)
    const fresh = moteTopics.map(topic => topic.id === customMoteId ? { ...topic, title: 'Fresh identity' } : topic)
    next.resolve(fresh); await pendingNext
    const confirmed = useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!
    old.resolve(moteTopics); await pendingOld
    expect(useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]).toBe(confirmed)
    expect(confirmed.topics).toEqual(fresh)
    list.mockResolvedValueOnce(fresh.map(topic => { if (topic.id !== customMoteId) return topic; const { soul: _soul, ...unreadable } = topic; return { ...unreadable, readError: 'SOUL unreadable' } }))
    await useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID, true)
    const failedFile = useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!
    expect(failedFile.topics?.find(topic => topic.id === customMoteId)).toBe(fresh[1])
    expect(failedFile.error).toContain('SOUL unreadable')
    expect(focusLaneForSession(customMoteId, failedFile.topics)).toBe('pmo')
    list.mockRejectedValueOnce(new Error('Directory offline'))
    await useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID, true)
    expect(useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!.topics).toBe(failedFile.topics)
    expect(useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!.error).toContain('Directory offline')
    expect(useAppStore.getState().sessions).toBe(sessions)
  })

  it.each([defaultTab, customTab])('isolates $id through all actual focus owners', tab => {
    const sessionId = tab.id === defaultTab.id ? defaultAgent.id : customAgent.id
    const execution = useAppStore.getState().agentFocus.execution
    expect(execution.history).toHaveLength(1)
    for (const focus of [
      () => useAppStore.getState().focusRegion(SCRATCH_WORKSPACE_ID, tab.id, tab.layout.activeRegionId),
      () => useAppStore.getState().activateTab(SCRATCH_WORKSPACE_ID, 'mote-group', tab.id),
      () => useAppStore.getState().selectSession(sessionId, 'mote-group'),
      () => useAppStore.getState().setViewMode(sessionId, 'terminal'),
      () => useAppStore.getState().focusPmoSession(sessionId)
    ]) {
      focus()
      expect(useAppStore.getState().agentFocus.execution).toEqual(execution)
      expect(useAppStore.getState().agentFocus.pmo.sessionId).toBe(sessionId)
    }
  })

  it.each(['directory', 'session', 'scope'] as const)('preserves original lanes when $unknown facts are unknown', unknown => {
    const original = useAppStore.getState().agentFocus
    if (unknown === 'directory') useAppStore.setState({ scratchTopicSnapshots: {} })
    if (unknown === 'session') useAppStore.setState({ sessions: useAppStore.getState().sessions.filter(session => session.id !== customAgent.id) })
    if (unknown === 'scope') useAppStore.setState({ config: { ...moteConfig, workspaces: [{ ...scratchWorkspace, path: '/other' }] } })
    // The scope case has the same durable Region but an old snapshot. Keep the
    // Session path inside the current scope so it is a Scratch identity, not a Project.
    if (unknown === 'scope') useAppStore.setState({ sessions: [{ ...customAgent, workspacePath: '/other/topic--launcher--analyst' }] })
    useAppStore.getState().focusRegion(SCRATCH_WORKSPACE_ID, customTab.id, 'custom-region')
    useAppStore.getState().activateTab(SCRATCH_WORKSPACE_ID, 'mote-group', customTab.id)
    useAppStore.getState().setViewMode(customAgent.id, 'terminal')
    useAppStore.getState().focusPmoSession(customAgent.id)
    expect(useAppStore.getState().agentFocus).toEqual(original)
    expect(original.execution.history).toEqual([{ sessionId: 'execution-agent', focusedAt: 123 }])
    expect(useAppStore.getState().tabs[customTab.id]).toBeDefined()
  })

  it('keeps restore lanes for unknown identity and records a known ordinary Topic through the same owner', () => {
    useAppStore.setState({ agentFocus: { ...useAppStore.getState().agentFocus, pmo: { sessionId: customAgent.id } } })
    const original = useAppStore.getState().agentFocus
    expect(sanitizeAgentFocus(original, useAppStore.getState().sessions, session => session.id === customAgent.id ? null : 'execution')).toEqual(original)
    useAppStore.getState().focusRegion(SCRATCH_WORKSPACE_ID, ordinaryTab.id, 'ordinary-region')
    const after = useAppStore.getState().agentFocus
    expect(after.execution.sessionId).toBe(ordinaryAgent.id)
    expect(after.execution.history).toEqual([expect.objectContaining({ sessionId: ordinaryAgent.id, focusedAt: expect.any(Number) }), ...original.execution.history])
    expect(after.pmo).toEqual(original.pmo)
  })

  it('invalidates the existing Focus projection when the shared SOUL facts change', () => {
    const select = createFocusProjectionSelector()
    const state = useAppStore.getState()
    const before = select(state)
    expect(before.contexts.map(context => context.id)).toEqual([ordinaryAgent.id, 'execution-agent'])
    const topics = moteTopics.map(topic => { if (topic.id !== customMoteId) return topic; const { soul: _soul, ...ordinary } = topic; return ordinary })
    const ordinary = select({ ...state, scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: {
      scope: scratchTopicsScope(scratchWorkspace), revision: 1, topics, error: null, reading: false
    } } })
    expect(ordinary.contexts.map(context => context.id)).toEqual([customAgent.id, ordinaryAgent.id, 'execution-agent'])
  })

  it('keeps an unknown healthy Scratch Context visible and locatable without guessing its lane', () => {
    useAppStore.setState({ scratchTopicSnapshots: {} })
    const state = useAppStore.getState(), original = state.agentFocus
    const projection = createFocusProjectionSelector()(state)
    const unknown = projection.contexts.find(context => context.id === customAgent.id)
    expect(unknown).toEqual(expect.objectContaining({ id: customAgent.id, workspacePath: customAgent.workspacePath,
      topicId: customMoteId, processState: 'running', state: 'waiting', actionable: true }))
    expect(unknown!.detail).toContain('Mote identity is not confirmed')
    expect(projection.pmoAttention).not.toContain(customAgent.id)
    useAppStore.getState().focusExecutionSession(customAgent.id)
    expect(useAppStore.getState().agentFocus).toEqual(original)
    expect(useAppStore.getState().sessions).toBe(state.sessions)
  })
})
