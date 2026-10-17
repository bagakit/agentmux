// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import * as store from '../src/renderer/src/store'
import { RegionContextMenu } from '../src/renderer/src/components/RegionContextMenu'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useSessionRestart } from '../src/renderer/src/components/SessionRestart'
import { senderTrust, assertSenderTrusted } from '../src/main/ipc-sender-trust'
import { withStopTimeout, sessionRestartTimeoutError } from '../src/shared/session-stop-timeout'
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '@agentmux/core/agent-session-continuity'

const initial = useAppStore.getState(), target = composerSession('restart-target'), other = composerSession('restart-neighbor')
const tab = createWorkbenchTab('restart-tab', { kind: 'agent', regionId: 'restart-region', phase: 'attached', workspaceId: 'workspace', sessionId: target.id })
let root: Root, container: HTMLDivElement
function Scene({ original = target }: { original?: typeof target }) {
  const restart = useSessionRestart()
  return <><button onClick={event => restart.requestRestart(original, 'Original work', event.currentTarget)}>Restart Session…</button>{restart.dialog}</>
}
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
const confirm = () => document.querySelector<HTMLButtonElement>('[role="dialog"] [data-confirm-label]')!
async function open() {
  await act(async () => container.querySelector('button')!.click()); await settle()
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Original work')
}
function result(operationId: string, phase: 'unconfirmed' | 'restarted' | 'not-found' | 'failed' = 'restarted', canRetry = false) {
  return { agentSessionId: target.id, expectedRun: target.control.run, operationId, previousRun: target.control.run,
    phase, canRetry, observedAt: _tailFixtureEpoch(0, 0, 100),
    ...(phase === 'restarted' ? { newRun: { runId: 'replacement-run' }, session: { ...target, control: { ...target.control, run: { runId: 'replacement-run' } } } } : {}) }
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useAppStore.setState({ ...initial, config: composerConfig, sessions: [target, other], loading: false,
    tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout('restart-group', [tab.id]) },
    agentComposerDrafts: { [target.id]: 'Keep this unsent draft', [other.id]: 'Neighbor draft' }, timelines: {}, error: null }, true)
  vi.spyOn(api.sessions, 'restart').mockImplementation(async (_control, operationId) => result(operationId))
  vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'resume').mockResolvedValue(target)
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container); await act(async () => root.render(<Scene />))
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  document.getElementById('agentmux-window-overlay-host')?.remove()
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('opens and cancels without stopping, resuming or restarting; cancellation keeps the workface', async () => {
  const before = useAppStore.getState(); await open()
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Running work will be interrupted')
  await act(async () => document.querySelector<HTMLButtonElement>('.confirmation-dialog__cancel')!.click()); await settle()
  expect(api.sessions.restart).not.toHaveBeenCalled()
  for (const key of ['sessions', 'tabs', 'layouts', 'agentComposerDrafts', 'timelines'] as const) expect(useAppStore.getState()[key]).toBe(before[key])
})

it('restarts one frozen exact Run once and retains Session, neighbor, workface and drafts', async () => {
  const before = useAppStore.getState(); await open()
  await act(async () => { confirm().click(); confirm().click() }); await settle()
  expect(api.sessions.restart).toHaveBeenCalledExactlyOnceWith(target.control, expect.any(String), false)
  expect(api.sessions.stop).not.toHaveBeenCalled(); expect(api.sessions.resume).not.toHaveBeenCalled()
  const after = useAppStore.getState()
  expect(after.sessions.find(item => item.id === target.id)?.control.run.runId).toBe('replacement-run')
  expect(after.sessions.find(item => item.id === other.id)).toBe(other)
  for (const key of ['tabs', 'layouts', 'agentComposerDrafts', 'timelines'] as const) expect(after[key]).toBe(before[key])
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('only checks the original operation after a lost receipt, even after the current Run changes', async () => {
  vi.mocked(api.sessions.restart).mockRejectedValueOnce(new Error('Original reply lost'))
  await open(); await act(async () => confirm().click()); await settle()
  const operationId = vi.mocked(api.sessions.restart).mock.calls[0]![1]
  expect(confirm().textContent).toBe('Check restart')
  await act(async () => useAppStore.setState({ sessions: [{ ...target, control: { ...target.control, run: { runId: 'later-run' } } }, other] }))
  await act(async () => confirm().click()); await settle()
  expect(api.sessions.restart).toHaveBeenNthCalledWith(2, target.control, operationId, true)
  expect(useAppStore.getState().sessions.find(item => item.id === target.id)?.control.run.runId).toBe('later-run')
})

it('an explicit retry uses the same original operation only after Core grants canRetry', async () => {
  vi.mocked(api.sessions.restart).mockImplementationOnce(async (_control, operationId) => result(operationId, 'unconfirmed', true))
  await open(); await act(async () => confirm().click()); await settle()
  const operationId = vi.mocked(api.sessions.restart).mock.calls[0]![1]
  expect(confirm().textContent).toBe('Retry original restart')
  await act(async () => confirm().click()); await settle()
  expect(api.sessions.restart).toHaveBeenNthCalledWith(2, target.control, operationId, false)
})

it('a changed Run before initial confirmation refuses only that stale restart', async () => {
  await open()
  const replacement = { ...target, control: { ...target.control, run: { runId: 'later-run' } } }
  await act(async () => useAppStore.setState({ sessions: [replacement, other] }))
  await act(async () => confirm().click()); await settle()
  expect(api.sessions.restart).not.toHaveBeenCalled()
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('No restart was sent')
  expect(useAppStore.getState().sessions).toEqual([replacement, other])
})

it('rejects an unrelated original-operation receipt without adopting its replacement', async () => {
  vi.mocked(api.sessions.restart).mockImplementationOnce(async () => result('another-operation'))
  const before = useAppStore.getState(); await open(); await act(async () => confirm().click()); await settle()
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('another original Session, Run or operation')
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(confirm().textContent).toBe('Check restart')
})

it('admits the actual trusted restart sender and refuses a lookalike without granting authority', () => {
  const frame = { id: 'original-workbench' }
  expect(() => assertSenderTrusted(senderTrust('sessions:restart', frame, frame))).not.toThrow()
  expect(() => assertSenderTrusted(senderTrust('sessions:restart', { id: frame.id }, frame))).toThrow('Untrusted original Agent Session restart sender')
})

it('releases a stalled restart observer without cancelling or pretending to complete the underlying action', async () => {
  let finish!: (value: string) => void
  const original = new Promise<string>(resolve => { finish = resolve })
  await expect(withStopTimeout(original, 5, sessionRestartTimeoutError)).rejects.toMatchObject({ code: 'SESSION_RESTART_UNCONFIRMED' })
  finish('Original action completed later')
  await expect(original).resolves.toBe('Original action completed later')
})

it('reopens the same retained restart after another continuity observation replaced its current pointer', async () => {
  const original = { operationId: 'retained-original-restart', agentSessionId: target.id, action: 'restart' as const,
    trigger: 'manual' as const, policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY }, previousRun: target.control.run,
    admittedAt: _tailFixtureEpoch(0, 0, 1), observedAt: _tailFixtureEpoch(0, 0, 2), rechecks: 0, kind: 'starting' as const, reason: 'restart-stopping',
    evidence: { kind: 'run-unknown' as const, observedAt: _tailFixtureEpoch(0, 0, 2), message: 'Stop response unconfirmed' } }
  const { action: _restartAction, ...ordinary } = original
  await act(async () => useAppStore.setState({ sessions: [{ ...target,
    continuityOperations: { [original.operationId]: original }, continuity: { ...ordinary, operationId: 'ordinary-observation' } }, other] }))
  await open()
  await act(async () => document.querySelector<HTMLButtonElement>('.confirmation-dialog__cancel')!.click()); await settle()
  await open(); await act(async () => confirm().click()); await settle()
  expect(api.sessions.restart).toHaveBeenCalledExactlyOnceWith(target.control, original.operationId, true)
})


it('keeps a confirmed failed result readable and requires a fresh confirmation before a new restart', async () => {
  vi.mocked(api.sessions.restart).mockImplementationOnce(async (_control, operationId) => ({
    ...result(operationId, 'failed'), newRun: { runId: 'failed-start-run' },
    detail: 'The replacement Run exited during startup.',
    failure: { code: 'AGENT_TERMINAL_HANDSHAKE_FAILED', message: 'Original startup failed', observedAt: _tailFixtureEpoch(0, 0, 100) },
    session: { ...target, control: { ...target.control, run: { runId: 'failed-start-run' } } }
  }))
  await open(); await act(async () => confirm().click()); await settle()
  const originalId = vi.mocked(api.sessions.restart).mock.calls[0]![1]
  expect(confirm().textContent).toBe('Review new restart')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('exited during startup')
  await act(async () => confirm().click()); await settle()
  expect(api.sessions.restart).toHaveBeenCalledTimes(1)
  expect(confirm().textContent).toBe('Restart Session')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Running work will be interrupted')
  await act(async () => confirm().click()); await settle()
  const second = vi.mocked(api.sessions.restart).mock.calls[1]!
  expect(second[0].run.runId).toBe('failed-start-run')
  expect(second[1]).not.toBe(originalId)
  expect(second[2]).toBe(false)
})

it.each(['same-id-other-host', 'presentation-alias'] as const)('restarts the exact original target with %s and retains its operation after a lost receipt', async scenario => {
  const original = { ...target, hostId: 'remote', control: { ...target.control, hostId: 'remote',
    agentSessionId: scenario === 'presentation-alias' ? 'canonical-restart-agent' : target.id, run: { runId: 'remote-original-run' } } }
  const neighbor = scenario === 'presentation-alias' ? composerSession(original.control.agentSessionId) : target
  await act(async () => { useAppStore.setState({ sessions: [neighbor, original] }); root.render(<Scene original={original} />) })
  vi.mocked(api.sessions.restart).mockRejectedValueOnce(new Error('Original reply lost'))
    .mockImplementationOnce(async (_control, operationId) => ({ agentSessionId: original.control.agentSessionId,
      expectedRun: original.control.run, previousRun: original.control.run, operationId,
      phase: 'unconfirmed', canRetry: true, observedAt: _tailFixtureEpoch(0, 0, 100) }))
  const before = useAppStore.getState(); await open(); await act(async () => confirm().click()); await settle()
  expect(api.sessions.restart).toHaveBeenNthCalledWith(1, original.control, expect.any(String), false)
  const operationId = vi.mocked(api.sessions.restart).mock.calls[0]![1]
  await act(async () => useAppStore.setState({ sessions: [neighbor, { ...original, control: { ...original.control, run: { runId: 'later-remote-run' } } }] }))
  await act(async () => confirm().click()); await settle()
  expect(api.sessions.restart).toHaveBeenNthCalledWith(2, original.control, operationId, true)
  expect(confirm().textContent).toBe('Retry original restart')
  for (const key of ['tabs', 'layouts', 'agentComposerDrafts', 'timelines'] as const) expect(useAppStore.getState()[key]).toBe(before[key])
})
it('refuses a newly unobserved Run before confirmation without borrowing a same-ID neighbor', async () => {
  await open(); await act(async () => useAppStore.setState({ sessions: [{ ...target, runUnobserved: true }, other] }))
  const before = useAppStore.getState(); await act(async () => confirm().click()); await settle()
  expect(api.sessions.restart).not.toHaveBeenCalled()
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('No restart was sent')
  expect(useAppStore.getState().sessions).toBe(before.sessions)
})

it.each(['same-id-other-host', 'presentation-alias'] as const)('projects the canonical restart receipt into its original %s presentation only', async scenario => {
  const original = { ...target, hostId: 'remote', control: { ...target.control, hostId: 'remote',
    agentSessionId: scenario === 'presentation-alias' ? 'canonical-restart-agent' : target.id } }
  const neighbor = scenario === 'presentation-alias' ? composerSession(original.control.agentSessionId) : target
  const currentTab = { ...tab, regions: { ...tab.regions, 'restart-region': { ...tab.regions['restart-region']!, sessionId: original.id } } }
  await act(async () => { useAppStore.setState({ sessions: [neighbor, original], tabs: { [tab.id]: currentTab } }); root.render(<Scene original={original} />) })
  vi.mocked(api.sessions.restart).mockImplementationOnce(async (_control, operationId) => ({
    agentSessionId: original.control.agentSessionId, expectedRun: original.control.run, previousRun: original.control.run,
    operationId, phase: 'restarted', canRetry: false, observedAt: _tailFixtureEpoch(0, 0, 100), newRun: { runId: 'remote-restarted-run' },
    session: { ...original, id: original.control.agentSessionId, control: { ...original.control, run: { runId: 'remote-restarted-run' } } }
  }))
  const before = useAppStore.getState(); await open(); await act(async () => confirm().click()); await settle()
  expect(api.sessions.restart).toHaveBeenCalledExactlyOnceWith(original.control, expect.any(String), false)
  expect(useAppStore.getState().sessions).toEqual([neighbor, { ...original, control: { ...original.control, run: { runId: 'remote-restarted-run' } } }])
  expect(useAppStore.getState().sessions[0]).toBe(neighbor)
  for (const key of ['tabs', 'layouts', 'agentFocus', 'agentComposerDrafts', 'timelines'] as const) expect(useAppStore.getState()[key]).toBe(before[key])
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it.each(['same-id-other-host', 'canonical-alias'] as const)('the mounted Region menu uses its exact original execution with %s', async scenario => {
  const canonical = scenario === 'canonical-alias' ? 'canonical-region-agent' : target.id
  const original = { ...target, id: scenario === 'canonical-alias' ? 'region-presentation-alias' : target.id,
    hostId: 'remote', control: { ...target.control, hostId: 'remote', agentSessionId: canonical, run: { runId: 'original-region-run' } } }
  vi.spyOn(store, 'agentRegionExecution').mockReturnValue({ hostId: 'remote', cwd: original.workspacePath })
  vi.mocked(api.sessions.restart).mockImplementationOnce(async (_control, operationId) => ({ agentSessionId: canonical,
    expectedRun: original.control.run, previousRun: original.control.run, operationId,
    phase: 'unconfirmed', canRetry: false, observedAt: _tailFixtureEpoch(0, 0, 100) }))
  await act(async () => {
    useAppStore.setState({ sessions: [composerSession(canonical), original] })
    root.render(<RegionContextMenu tabId={tab.id} regionId="restart-region" agentSessionId={canonical} splitMenu={[]} swapMenu={[]} writeClipboardText={vi.fn()}><button>Original Region</button></RegionContextMenu>)
  })
  await act(async () => container.querySelector('button')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))); await settle()
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Restart Session…')
  expect(item).toBeDefined(); await act(async () => item!.click()); await settle()
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  await act(async () => confirm().click()); await settle()
  expect(api.sessions.restart).toHaveBeenCalledExactlyOnceWith(original.control, expect.any(String), false)
  expect(store.agentRegionExecution).toHaveBeenCalledWith({ tabId: tab.id, regionId: 'restart-region', agentSessionId: canonical })
})
