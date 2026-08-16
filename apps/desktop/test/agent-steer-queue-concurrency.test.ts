import { afterEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, RuntimeEvent, SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore, MAX_AGENT_STEER_QUEUE_ENTRIES } from '../src/renderer/src/store'

const initial = useAppStore.getState()
afterEach(() => { useAppStore.setState(initial, true); vi.restoreAllMocks() })

function agent(id = 's', runId = `${id}-run`): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    id, kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local',
    workspacePath: '/repo', label: 'Agent', createdAt: 1, updatedAt: 1,
    processState: 'running', status: { state: 'working', source: 'native-hook', observedAt: 1 },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: true, replyCorrelation: 'none' },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId } }
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function enqueue(...texts: string[]) {
  for (const text of texts) expect(useAppStore.getState().enqueueAgentSteer('s', text)).toBe(true)
  return useAppStore.getState().agentSteerQueues.s!
}

function readinessEvent(id = 's'): RuntimeEvent {
  const session = agent(id)
  return {
    type: 'core', hostId: 'local', event: {
      type: 'agent-session', session: {
        kind: 'agent', agentSessionId: id, providerId: 'codex', executorId: 'codex',
        hostId: 'local', workspacePath: '/repo', run: session.control.run, retiredRuns: [],
        createdAt: 1, updatedAt: 2, outputCursorBytes: 10,
        terminalPromptReadiness: {
          run: session.control.run, id: `ready-${id}`, source: 'initial-composer',
          outputCursorBytes: 0, readyThroughByte: 10
        }
      }
    }
  }
}

describe('one Session owns one live queue drain', () => {
  it('refuses overflow admission without evicting earlier user messages', () => {
    useAppStore.setState({ sessions: [agent()] })
    for (let index = 0; index < MAX_AGENT_STEER_QUEUE_ENTRIES; index++) {
      expect(useAppStore.getState().enqueueAgentSteer('s', `message ${index}`)).toBe(true)
    }
    const before = useAppStore.getState().agentSteerQueues.s
    expect(before).toHaveLength(MAX_AGENT_STEER_QUEUE_ENTRIES)
    expect(useAppStore.getState().send('s', 'keep this draft')).toBe(false)
    expect(useAppStore.getState().agentSteerQueues.s).toEqual(before)
    expect(useAppStore.getState().error).toContain('queue is full')
  })

  it('send acknowledges queue ownership synchronously while delivery is still pending', async () => {
    useAppStore.setState({ sessions: [agent()] })
    const gate = deferred()
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(() => gate.promise)
    const accepted = useAppStore.getState().send('s', 'accepted into queue')
    const queued = useAppStore.getState().agentSteerQueues.s
    gate.resolve()
    await useAppStore.getState().flushAgentSteerQueue('s')
    expect(accepted).toBe(true)
    expect(queued).toEqual([expect.objectContaining({ text: 'accepted into queue', operationId: expect.any(String) })])
    expect(submit).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()
  })

  it('coalesces concurrent automatic and manual attempts without duplicate submissions', async () => {
    useAppStore.setState({ sessions: [agent()] })
    const [first] = enqueue('first', 'second')
    const gate = deferred()
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementationOnce(() => gate.promise).mockResolvedValue(undefined)
    const automatic = useAppStore.getState().flushAgentSteerQueue('s')
    await Promise.resolve()
    const again = useAppStore.getState().flushAgentSteerQueue('s')
    const manual = useAppStore.getState().sendQueuedAgentSteer('s', first!.operationId)
    gate.resolve()
    await Promise.all([automatic, again, manual])
    expect(submit.mock.calls.map((call) => call[1])).toEqual(['first', 'second'])
    expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()
  })

  it('removes a completed entry by identity even when its stored object was replaced', async () => {
    useAppStore.setState({ sessions: [agent()] })
    const [entry] = enqueue('one')
    const gate = deferred()
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(() => gate.promise)
    const drain = useAppStore.getState().flushAgentSteerQueue('s')
    await Promise.resolve() // The request has entered submitPrompt; changes below race its receipt.
    useAppStore.setState({ agentSteerQueues: { s: [{ ...entry! }] } })
    gate.resolve()
    await drain
    expect(submit).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()
  })

  it('manual delivery of a tail preserves order instead of bypassing its head', async () => {
    useAppStore.setState({ sessions: [agent()] })
    const [, tail] = enqueue('first', 'clicked second')
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
    await useAppStore.getState().sendQueuedAgentSteer('s', tail!.operationId)
    expect(submit.mock.calls.map((call) => call[1])).toEqual(['first', 'clicked second'])
    expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()
  })

  it('retains a readiness wake arriving before a pending refusal is received', async () => {
    useAppStore.setState({ sessions: [agent()] })
    const [entry] = enqueue('retry after readiness')
    const gate = deferred()
    const submit = vi.spyOn(api.sessions, 'submitPrompt')
      .mockImplementationOnce(async () => { await gate.promise; throw new Error('earlier not-ready response') })
      .mockResolvedValue(undefined)
    const drain = useAppStore.getState().flushAgentSteerQueue('s')
    await Promise.resolve()
    useAppStore.getState().applyEvent(readinessEvent())
    gate.resolve()
    await drain
    expect(submit.mock.calls.map((call) => call[2])).toEqual([entry!.operationId, entry!.operationId])
    expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()
  })

  it('does not retry itself when a refused submission publishes a consumed degraded Session', async () => {
    useAppStore.setState({ sessions: [agent()] })
    const [entry] = enqueue('retain without feedback loop')
    const event = readinessEvent()
    if (event.event.type !== 'agent-session') throw new Error('Expected Session fixture')
    event.event.session.terminalPromptReadiness!.consumedBySubmissionId = entry!.operationId
    event.event.session.terminalPromptDelivery = {
      state: 'unverified', mode: 'degraded', reason: 'screen-evidence-gap',
      submissionId: entry!.operationId, run: { runId: 's-run' }, observedAt: 2
    }
    let attempts = 0
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async () => {
      attempts += 1
      // A broken consumer would loop forever; let its third attempt succeed so failure is bounded.
      if (attempts >= 3) return
      useAppStore.getState().applyEvent(event)
      throw new Error('submit phase unavailable')
    })
    await useAppStore.getState().flushAgentSteerQueue('s')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().agentSteerQueues.s).toEqual([
      { ...entry, status: 'deferred', error: 'submit phase unavailable' }
    ])
  })

  it('wakes after an authoritative Session clears its pending interaction without readiness data', async () => {
    useAppStore.setState({ sessions: [{ ...agent(), pendingInteraction: { id: 'question' } } as never] })
    enqueue('after the answer')
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
    await useAppStore.getState().flushAgentSteerQueue('s')
    expect(submit).not.toHaveBeenCalled()
    const event = readinessEvent()
    if (event.event.type !== 'agent-session') throw new Error('Expected Session fixture')
    delete event.event.session.terminalPromptReadiness
    useAppStore.getState().applyEvent(event)
    await vi.waitFor(() => expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined())
    expect(submit.mock.calls.map((call) => call[1])).toEqual(['after the answer'])
    const restored = useAppStore.getState().sessions[0]
    if (restored?.kind !== 'agent') throw new Error('Expected restored Agent')
    expect(restored.pendingInteraction).toBeUndefined()
  })

  it('does not send a tail removed while the head is in flight', async () => {
    useAppStore.setState({ sessions: [agent()] })
    const [, tail] = enqueue('head', 'removed tail')
    const gate = deferred()
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementationOnce(() => gate.promise).mockResolvedValue(undefined)
    const drain = useAppStore.getState().flushAgentSteerQueue('s')
    await Promise.resolve() // The request has entered submitPrompt; changes below race its receipt.
    useAppStore.getState().removeAgentSteer('s', tail!.operationId)
    gate.resolve()
    await drain
    expect(submit.mock.calls.map((call) => call[1])).toEqual(['head'])
    expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()
  })

  it('does not pretend that removing an in-flight entry cancels its accepted bytes', async () => {
    useAppStore.setState({ sessions: [agent()] })
    const [head] = enqueue('in flight')
    const gate = deferred()
    vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(() => gate.promise)
    const drain = useAppStore.getState().flushAgentSteerQueue('s')
    await Promise.resolve() // The request has entered submitPrompt; changes below race its receipt.
    useAppStore.getState().removeAgentSteer('s', head!.operationId)
    const retained = useAppStore.getState().agentSteerQueues.s
    gate.resolve()
    await drain
    expect(retained).toEqual([expect.objectContaining({ operationId: head!.operationId, text: 'in flight' })])
    expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()
  })

  it('reads newly enqueued work after the current submission settles', async () => {
    useAppStore.setState({ sessions: [agent()] })
    enqueue('first')
    const gate = deferred()
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementationOnce(() => gate.promise).mockResolvedValue(undefined)
    const drain = useAppStore.getState().flushAgentSteerQueue('s')
    await Promise.resolve() // The request has entered submitPrompt; changes below race its receipt.
    enqueue('added while sending')
    gate.resolve()
    await drain
    expect(submit.mock.calls.map((call) => call[1])).toEqual(['first', 'added while sending'])
    expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined()
  })

  it('stops at a pending interaction that appeared during submission', async () => {
    useAppStore.setState({ sessions: [agent()] })
    const [, tail] = enqueue('head', 'wait for answer')
    const gate = deferred()
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementationOnce(() => gate.promise).mockResolvedValue(undefined)
    const drain = useAppStore.getState().flushAgentSteerQueue('s')
    await Promise.resolve() // The request has entered submitPrompt; changes below race its receipt.
    useAppStore.setState({ sessions: [{ ...agent(), pendingInteraction: { request: { id: 'question' } } } as never] })
    gate.resolve()
    await drain
    expect(submit.mock.calls.map((call) => call[1])).toEqual(['head'])
    expect(useAppStore.getState().agentSteerQueues.s).toEqual([tail])
  })

  it('does not submit the captured old tail after the Session changes Run', async () => {
    useAppStore.setState({ sessions: [agent()] })
    const [, tail] = enqueue('head', 'old run tail')
    const gate = deferred()
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementationOnce(() => gate.promise).mockResolvedValue(undefined)
    const drain = useAppStore.getState().flushAgentSteerQueue('s')
    await Promise.resolve() // The request has entered submitPrompt; changes below race its receipt.
    useAppStore.setState({ sessions: [agent('s', 'replacement-run')] })
    gate.resolve()
    await drain
    expect(submit.mock.calls.map((call) => call[1])).toEqual(['head'])
    expect(useAppStore.getState().agentSteerQueues.s).toEqual([tail])
  })

  it('retains a stale failed message without blocking the current Run', async () => {
    useAppStore.setState({ sessions: [agent()], agentSteerQueues: { s: [
      { operationId: 'stale', runId: 'old-run', text: 'old words', status: 'failed', error: 'Old Run' }
    ] } })
    enqueue('current words')
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
    await useAppStore.getState().flushAgentSteerQueue('s')
    expect(submit.mock.calls.map((call) => call[1])).toEqual(['current words'])
    expect(useAppStore.getState().agentSteerQueues.s).toEqual([
      { operationId: 'stale', runId: 'old-run', text: 'old words', status: 'failed', error: 'Old Run' }
    ])
  })

  it('keeps automatic refusal on the entry without a global error banner', async () => {
    useAppStore.setState({ sessions: [agent()] })
    const [entry] = enqueue('retained')
    const report = vi.spyOn(useAppStore.getState(), 'reportError')
    vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(new Error('composer not ready'))
    await useAppStore.getState().flushAgentSteerQueue('s')
    await useAppStore.getState().flushAgentSteerQueue('s')
    expect(useAppStore.getState().agentSteerQueues.s).toEqual([
      { ...entry, status: 'deferred', error: 'composer not ready' }
    ])
    expect(report).not.toHaveBeenCalled()
    expect(useAppStore.getState().error).toBeNull()
  })

  it('ignores terminal output and wakes only the Session named by readiness', async () => {
    useAppStore.setState({ sessions: [agent(), agent('other')] })
    enqueue('s message')
    useAppStore.getState().enqueueAgentSteer('other', 'other message')
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
    useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: {
      type: 'terminal-output', agentSessionId: 's', run: { runId: 's-run' }, data: 'output',
      evidence: { source: 'terminal-output', observedAt: 2, run: { runId: 's-run' } }
    } })
    await Promise.resolve()
    expect(submit).not.toHaveBeenCalled()
    useAppStore.getState().applyEvent(readinessEvent())
    await vi.waitFor(() => expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined())
    expect(submit.mock.calls.map((call) => [call[0].agentSessionId, call[1]])).toEqual([['s', 's message']])
    expect(useAppStore.getState().agentSteerQueues.other).toEqual([
      expect.objectContaining({ text: 'other message', status: 'queued' })
    ])
  })

  it('wakes retained intent when an explicit refresh clears an interaction without an event', async () => {
    const running = agent()
    const tab = createWorkbenchTab('tab', {
      regionId: 'region', kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: 's'
    })
    useAppStore.setState({ sessions: [{ ...running, pendingInteraction: { id: 'question' } } as never], tabs: { [tab.id]: tab } })
    const [entry] = enqueue('after refresh')
    vi.spyOn(api.sessions, 'refresh').mockResolvedValue(running)
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
    await useAppStore.getState().refreshSession('s')
    await vi.waitFor(() => expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined())
    expect(submit).toHaveBeenCalledExactlyOnceWith(running.control, 'after refresh', entry!.operationId)
  })

  it('drains a persisted queue when startup restores a healthy snapshot without any event', async () => {
    const running = agent()
    const tab = createWorkbenchTab('restored-tab', {
      regionId: 'restored-region', kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: 's'
    })
    const config: AppConfig = {
      version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {},
      workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }],
      appearance: { terminalTheme: 'graphite' },
      browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
    }
    useAppStore.setState({
      loading: true, restoredWorkbench: {
        tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout('pane', [tab.id]) }
      },
      agentSteerQueues: JSON.parse(JSON.stringify({ s: [
        { operationId: 'persisted-op', runId: 's-run', text: 'survived restart', status: 'queued' }
      ] }))
    })
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.providers, 'list').mockResolvedValue([])
    vi.spyOn(api.sessions, 'onEvent').mockReturnValue(() => {})
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({
      sessions: [running], timelines: { s: { agentSessionId: 's', revision: 0, items: [] } }, recoveryCandidates: []
    })
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
    const dispose = await useAppStore.getState().initialize()
    try {
      await vi.waitFor(() => expect(useAppStore.getState().agentSteerQueues.s).toBeUndefined())
      expect(submit).toHaveBeenCalledExactlyOnceWith(running.control, 'survived restart', 'persisted-op')
      expect(useAppStore.getState().tabs[tab.id]).toEqual(tab)
    } finally { dispose() }
  })
})
