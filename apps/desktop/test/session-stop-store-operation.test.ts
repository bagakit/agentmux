// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { sessionStopReceipt } from './helpers/session-stop-receipt'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { beginMoteStartupRecovery } from '../src/renderer/src/lib/mote-session-recovery'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'

const initial = useAppStore.getState(), agent = composerSession('store-stop-agent')
const tab = createWorkbenchTab('store-stop-tab', { kind: 'agent', regionId: 'store-stop-region', phase: 'attached', workspaceId: 'workspace', sessionId: agent.id })
const stop = () => vi.mocked(api.sessions.stop)
const timeout = () => Object.assign(new Error('No response from the Runtime within 60s.'), { code: 'SESSION_STOP_TIMEOUT' })
const stale = () => Object.assign(new Error('Agent Session changed before its Run was stopped.'), { code: 'STALE_AGENT_SESSION' })

beforeEach(() => {
  useAppStore.setState({ ...initial, config: composerConfig, sessions: [agent], tabs: { [tab.id]: tab },
    layouts: { workspace: createWorkspaceLayout('store-stop-group', [tab.id]) }, activeWorkspaceId: 'workspace', closingWorkbenchViews: {}, error: null }, true)
  vi.spyOn(api.sessions, 'stop').mockImplementation(async (control, operationId) => control.kind === 'agent' ? sessionStopReceipt(control, operationId!) : undefined)
})
afterEach(() => { vi.restoreAllMocks(); useAppStore.setState(initial, true) })

it('stops the exact Run with one operation id and answers stopped', async () => {
  expect(await useAppStore.getState().stopSession(agent.id)).toMatchObject({ status: 'stopped', receipt: expect.objectContaining({ agentSessionId: agent.control.agentSessionId, expectedRun: agent.control.run }) })
  expect(stop()).toHaveBeenCalledExactlyOnceWith(agent.control, expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/))
})

it.each(['missing', 'another-session', 'another-run', 'another-operation'] as const)(
  'an Agent Stop with a %s receipt stays unconfirmed and retains its original intent', async kind => {
    stop().mockImplementationOnce(async (control, operationId) => {
      if (kind === 'missing' || control.kind !== 'agent') return undefined
      const receipt = sessionStopReceipt(control, operationId!)
      return kind === 'another-session' ? { ...receipt, agentSessionId: 'another-agent' }
        : kind === 'another-run' ? { ...receipt, expectedRun: { runId: 'another-run' } }
          : { ...receipt, operationId: 'another-operation' }
    })
    const outcome = await useAppStore.getState().stopSession(agent.id)
    const operationId = stop().mock.calls[0]![1]!
    expect(outcome).toMatchObject({ status: 'unconfirmed', operationId })
    expect(useAppStore.getState().sessions).toEqual([agent])
    expect(useAppStore.getState().tabs[tab.id]).toBeTruthy()
    expect(Object.values(useAppStore.getState().agentOperations)).toEqual([expect.objectContaining({
      kind: 'stop', operationId, control: agent.control, phase: 'unconfirmed'
    })])
    expect(await useAppStore.getState().stopSession(agent.id)).toMatchObject({ status: 'stopped' })
    expect(stop().mock.calls[1]).toEqual([agent.control, operationId])
  })

it('a retained Stop receipt settles its canonical operation and keeps it in the returned outcome', async () => {
  stop().mockImplementationOnce(async (control) => control.kind === 'agent'
    ? { ...sessionStopReceipt(control, 'original-stop'), admission: 'retained' } : undefined)
  expect(await useAppStore.getState().stopSession(agent.id)).toMatchObject({ status: 'stopped', receipt: { operationId: 'original-stop' } })
  expect(useAppStore.getState().agentOperations).toEqual({})
})

it('a last-View close keeps the workface when its Agent Stop has no confirmed receipt', async () => {
  stop().mockResolvedValueOnce(undefined)
  await useAppStore.getState().closeTab('workspace', 'store-stop-group', tab.id)
  await vi.waitFor(() => expect(useAppStore.getState().closingWorkbenchViews).toEqual({}))
  const operationId = stop().mock.calls[0]![1]!
  expect(useAppStore.getState().tabs[tab.id]).toBeTruthy()
  expect(useAppStore.getState().sessions).toEqual([agent])
  expect(Object.values(useAppStore.getState().agentOperations)).toEqual([expect.objectContaining({
    operationId, control: agent.control, phase: 'unconfirmed'
  })])
  expect(useAppStore.getState().error).toContain(operationId)
  await useAppStore.getState().closeTab('workspace', 'store-stop-group', tab.id)
  await vi.waitFor(() => expect(stop()).toHaveBeenCalledTimes(2))
  expect(stop().mock.calls[1]).toEqual([agent.control, operationId])
})

it('a pending startup recovery is cancelled, not awaited: the Stop is sent while recovery is still unsettled', async () => {
  const end = beginMoteStartupRecovery()
  try {
    // A recovery that never settles. The old code awaited it before Stop, so Stop was never sent.
    vi.spyOn(useAppStore.getState(), 'recoverSession')
    useAppStore.setState({ recoverSession: vi.fn(() => new Promise<undefined>(() => {})) })
    const { recoverMoteConversationAtStartup } = await import('../src/renderer/src/lib/mote-session-recovery')
    const exited = { ...agent, processState: 'exited' as const }
    useAppStore.setState({ sessions: [exited] })
    vi.spyOn(await import('../src/renderer/src/lib/mote-session-recovery'), 'moteSessionStartupMode').mockReturnValue('ordinary')
    void recoverMoteConversationAtStartup(exited)
    // The job is really registered, so the Stop below meets an unsettled recovery.
    expect(useAppStore.getState().recoverSession).toHaveBeenCalledTimes(1)
    const outcome = await Promise.race([useAppStore.getState().stopSession(agent.id),
      new Promise(resolve => setTimeout(() => resolve('still waiting'), 200))])
    expect(outcome).toMatchObject({ status: 'stopped', receipt: expect.objectContaining({ agentSessionId: agent.control.agentSessionId, expectedRun: agent.control.run }) })
    expect(stop()).toHaveBeenCalledExactlyOnceWith(exited.control, expect.any(String))
  } finally { end() }
})

it('a closing View answers not-sent with the action that works, never a silent return', async () => {
  useAppStore.setState({ closingWorkbenchViews: { [tab.id]: { tabId: tab.id, reservedSessionIds: [agent.id] } as never } })
  const outcome = await useAppStore.getState().stopSession(agent.id)
  expect(outcome).toMatchObject({ status: 'not-sent', reason: 'view-closing' })
  expect(outcome.status !== 'stopped' && outcome.action).toContain('close the View again')
  expect(stop()).not.toHaveBeenCalled()
})

it('a missing Session answers not-sent with the action that works', async () => {
  const outcome = await useAppStore.getState().stopSession('missing-session')
  expect(outcome).toMatchObject({ status: 'not-sent', reason: 'session-missing' })
  expect(outcome.status !== 'stopped' && outcome.action).toContain('Refresh')
  expect(stop()).not.toHaveBeenCalled()
})

it('an unconfirmed Stop answers its operation and stage; stopping again continues that same operation', async () => {
  stop().mockRejectedValueOnce(Object.assign(timeout(), { stage: 'runtime-stop' }))
  const first = await useAppStore.getState().stopSession(agent.id)
  const operationId = stop().mock.calls[0]![1]!
  expect(first).toMatchObject({ status: 'unconfirmed', operationId, stage: 'runtime-stop' })
  expect(first.status === 'unconfirmed' && first.message).toContain(`--operation-id ${operationId}`)
  expect(useAppStore.getState().error).toContain(operationId)
  expect(Object.values(useAppStore.getState().agentOperations)).toEqual([expect.objectContaining({
    kind: 'stop', operationId, control: agent.control, phase: 'unconfirmed', canContinue: false,
    message: expect.stringContaining('runtime-stop (SESSION_STOP_TIMEOUT)')
  })])
  expect(await useAppStore.getState().stopSession(agent.id)).toMatchObject({ status: 'stopped', receipt: expect.objectContaining({ agentSessionId: agent.control.agentSessionId, expectedRun: agent.control.run }) })
  expect(stop().mock.calls[1]).toEqual([agent.control, operationId])
  // After the receipt, a new Stop is a new intent.
  await useAppStore.getState().stopSession(agent.id)
  expect(stop().mock.calls[2]![1]).not.toBe(operationId)
})

it('Core’s STALE_AGENT_SESSION re-reads the Session and answers run-changed; the next Stop is a fresh intent', async () => {
  const refresh = vi.spyOn(useAppStore.getState(), 'refreshSession')
  useAppStore.setState({ refreshSession: vi.fn(async () => undefined) })
  stop().mockRejectedValueOnce(stale())
  const outcome = await useAppStore.getState().stopSession(agent.id)
  expect(outcome).toMatchObject({ status: 'run-changed' })
  expect(outcome.status !== 'stopped' && outcome.message).toContain('The Run changed; stop the current Run')
  expect(useAppStore.getState().refreshSession).toHaveBeenCalledExactlyOnceWith(agent.id)
  await useAppStore.getState().stopSession(agent.id)
  expect(stop().mock.calls[1]![1]).not.toBe(stop().mock.calls[0]![1])
  refresh.mockRestore()
})

it('closing the last View again after an unconfirmed Stop resends the same operation', async () => {
  stop().mockRejectedValueOnce(timeout())
  await useAppStore.getState().closeTab('workspace', 'store-stop-group', tab.id)
  await vi.waitFor(() => expect(stop()).toHaveBeenCalledTimes(1))
  await vi.waitFor(() => expect(useAppStore.getState().closingWorkbenchViews).toEqual({}))
  const operationId = stop().mock.calls[0]![1]!
  expect(operationId).toMatch(/^[A-Za-z0-9]/)
  expect(useAppStore.getState().error).toContain(`--operation-id ${operationId}`)
  expect(useAppStore.getState().tabs[tab.id]).toBeTruthy()
  expect(Object.values(useAppStore.getState().agentOperations)).toEqual([expect.objectContaining({
    kind: 'stop', operationId, control: agent.control, phase: 'unconfirmed'
  })])
  await useAppStore.getState().closeTab('workspace', 'store-stop-group', tab.id)
  await vi.waitFor(() => expect(stop()).toHaveBeenCalledTimes(2))
  expect(stop().mock.calls[1]).toEqual([agent.control, operationId])
})
