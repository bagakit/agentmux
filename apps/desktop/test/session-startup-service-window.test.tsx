// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentTerminalInitialization } from '@agentmux/core'
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '@agentmux/core/agent-session-recovery'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-live-terminal>Original terminal</div> }))
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { api } from '../src/renderer/src/lib/api'
import { sessionFrontendPresentation } from '../src/renderer/src/lib/session-recovery-banner'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { workbenchSessionStageHostId, type WorkbenchViewTarget } from '../src/renderer/src/lib/workbench-presentation'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM(), original = composerSession('startup-original')
const observationCode = 'AGENT_NATIVE_INITIALIZATION_OBSERVATION_UNCONFIRMED'
function startup(phase: AgentTerminalInitialization['phase'] = 'failed', step: NonNullable<AgentTerminalInitialization['failure']>['step'] = 'preflight') {
  return { ...original, terminalFrontend: { run: original.control.run, frontendId: 'original-frontend',
    state: 'starting' as const, backendState: 'running' as const, source: 'managed-process' as const, observedAt: 10,
    initialization: { phase, lifecycleOperationId: 'original-initialization', native: { state: 'not-created' as const },
      ...(['failed', 'unknown'].includes(phase) ? { failure: { step, code: phase === 'unknown' ? observationCode : 0,
        message: 'Exact original diagnostic: Request timeout.\nOriginal setup trace is retained.' } } : {}) } } }
}
beforeEach(() => {
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue({ items: [], source: 'unavailable' } as never)
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
  vi.spyOn(api.sessions, 'recover').mockRejectedValue(new Error('Unexpected fixture lifecycle call'))
  vi.spyOn(api.sessions, 'write').mockRejectedValue(new Error('Unexpected fixture input'))
  vi.spyOn(api.sessions, 'launchAgent').mockRejectedValue(new Error('Unexpected fixture create'))
})
afterEach(() => vi.useRealTimers())
async function mount(session = startup(), visible = true) {
  const tab = createWorkbenchTab('original-tab', { regionId: 'original-region', workspaceId: 'workspace', kind: 'agent', phase: 'attached', sessionId: session.id })
  useAppStore.setState({ sessions: [session], tabs: { [tab.id]: tab }, pendingAgentLaunches: {}, recoveryCandidates: [],
    activeWorkspaceId: 'workspace', viewModes: { [session.id]: 'terminal' }, timelines: {},
    agentComposerDrafts: { [session.id]: 'Original unsent thought' }, agentSteerQueues: {} })
  await dom.render(<SessionPane sessionId={session.id} surfaceKind="agent" visible={visible} interactiveResize={false}
    linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'original-group', tabId: tab.id, regionId: 'original-region' }} />)
  return tab
}
function button(label: string) {
  const found = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label)
  expect(found, `Original ${label} action`).toBeDefined()
  return found!
}
function noSideEffects() {
  expect(api.sessions.recover).not.toHaveBeenCalled(); expect(api.sessions.write).not.toHaveBeenCalled(); expect(api.sessions.launchAgent).not.toHaveBeenCalled()
}

it.each([
  ['connection', 'The connection to the agent service did not complete.'],
  ['preflight', 'A required setup check did not complete.'],
  ['native-session', 'The conversation could not finish opening.'],
  ['frontend', 'The terminal could not connect to the conversation.']
] as const)('explains typed %s before the original action and keeps the exact diagnostic visible before identity details', async (step, reason) => {
  const session = startup('failed', step), tab = await mount(session)
  const surface = dom.container.querySelector('.full-page-loading')!, heading = surface.querySelector('.surface-state__heading')!
  expect(heading.textContent).toContain(reason)
  expect(heading.compareDocumentPosition(button('Retry setup')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(surface.getAttribute('data-loading-phase')).toBe('failed')
  expect(surface.querySelector('[data-icon-animation="wait"]')).toBeNull()
  expect(surface.textContent).toContain('The backend is still running. The conversation has not been created yet.')
  expect(surface.textContent).toContain('Checks and continues the original setup')
  const diagnostic = surface.querySelector('.session-frontend-diagnostic')!
  expect(diagnostic, 'Original diagnostic remains reachable').not.toBeNull()
  expect(diagnostic.closest('details')).toBeNull()
  const details = surface.querySelector('details')!
  expect(details).not.toBeNull(); expect(details.open).toBe(false)
  expect(diagnostic.textContent).toContain(session.terminalFrontend.initialization.failure!.message)
  await act(async () => details.querySelector('summary')!.click())
  expect(details.open).toBe(true)
  expect(details.textContent).toContain('original-initialization'); expect(details.textContent).toContain('Startup step' + step); expect(details.textContent).toContain('Diagnostic code0')
  expect(button('Read original output')).toBeDefined()
  expect(useAppStore.getState().tabs[tab.id]).toBe(tab); expect(dom.draft(session.id)).toBe('Original unsent thought')
  noSideEffects()
})

it('keeps typed unknown static and explains the original observer without parsing diagnostic words', async () => {
  const session = startup('unknown')
  await mount(session)
  const surface = dom.container.querySelector('.full-page-loading')!
  expect(surface.getAttribute('data-loading-phase')).toBe('parked'); expect(surface.getAttribute('aria-busy')).toBe('false')
  expect(surface.textContent).toContain('The original request is still being observed.')
  expect(surface.textContent).not.toContain('Agent couldn’t finish starting')
  expect(surface.querySelector('[data-icon-animation="wait"]')).toBeNull()
  expect(surface.querySelector('details')?.textContent).toContain('Startup steppreflight')
  expect(surface.querySelector('details')?.textContent).not.toContain('Failed step')
  expect(button('Check startup')).toBeDefined()
  const unknown = startup('unknown'); unknown.terminalFrontend.initialization.failure!.code = 'different-code' as never
  expect(sessionFrontendPresentation(unknown)?.description).toBe('Startup has not returned a confirmed result. Its outcome is still unknown.')
  const failed = startup('failed'); failed.terminalFrontend.initialization.failure!.message = 'still starting successfully, unknown observation timeout'
  expect(sessionFrontendPresentation(failed)?.phase).toBe('failed')
  noSideEffects()
})

it.each(['preparing', 'creating'] as const)('only %s carries the original visible waiting signal', async phase => {
  await mount(startup(phase))
  expect(dom.container.querySelector('.full-page-loading')?.getAttribute('aria-busy')).toBe('true')
  expect(dom.container.querySelectorAll('[data-icon-animation="wait"]')).toHaveLength(1)
  expect(dom.container.textContent).toContain(phase === 'creating' ? 'Waiting for the original conversation request' : 'Connecting to the agent service')
  noSideEffects()
})

it('retains the same original recovery operation across repeated checks with no input or creation', async () => {
  const recover = vi.spyOn(useAppStore.getState(), 'recoverSession').mockResolvedValue(undefined)
  await mount(startup('unknown'))
  await act(async () => button('Check startup').click())
  await act(async () => button('Check startup').click())
  expect(recover).toHaveBeenCalledTimes(2)
  expect(recover.mock.calls[0]).toEqual([original.id, expect.any(String)])
  expect(recover.mock.calls[1]).toEqual(recover.mock.calls[0])
  expect(dom.container.textContent).toContain('Checks or continues the original setup')
  expect(dom.draft(original.id)).toBe('Original unsent thought')
  expect(api.sessions.write).not.toHaveBeenCalled(); expect(api.sessions.launchAgent).not.toHaveBeenCalled()
})

it('does not cover a usable terminal with a stale or attached initialization failure', async () => {
  const stale = startup(); stale.terminalFrontend.run = { runId: 'old-run' }
  await mount(stale)
  expect(dom.container.querySelector('.full-page-loading')).toBeNull()
  expect(dom.container.querySelector('[data-live-terminal]')).not.toBeNull()
  const attached = { ...startup(), terminalFrontend: { ...startup().terminalFrontend, state: 'attached' as const } }
  await mount(attached as ReturnType<typeof startup>)
  expect(dom.container.querySelector('.full-page-loading')).toBeNull()
  expect(dom.container.querySelector('[data-live-terminal]')).not.toBeNull()
  expect(dom.draft(original.id)).toBe('Original unsent thought')
  noSideEffects()
})

it('forwards hidden visibility from the actual SessionPane without a waiting timer or animation', async () => {
  vi.useFakeTimers()
  const style = vi.spyOn(window, 'getComputedStyle')
  await mount(startup('preparing'), false)
  expect(dom.container.querySelector('.full-page-loading')).not.toBeNull()
  expect(dom.container.querySelector('[data-icon-animation="wait"]')).toBeNull()
  expect(style.mock.calls.filter(([node]) => node.matches('.full-page-loading, .full-page-loading__activity'))).toHaveLength(0)
  await act(async () => vi.advanceTimersByTime(10_000))
  expect(dom.container.querySelector('.full-page-loading__elapsed')?.textContent).toBe('0s')
  noSideEffects()
})

it('keeps a visible recovery presentation waiting while the original location is hidden', async () => {
  await mount(startup('preparing'), false)
  await act(async () => useAppStore.setState({ sessions: [{ ...original, processState: 'interrupted',
    continuity: { operationId: 'original-restore', agentSessionId: original.id, trigger: 'manual',
      policy: DEFAULT_AGENT_CONTINUITY_POLICY, previousRun: original.control.run, admittedAt: 1, observedAt: 2,
      kind: 'starting', reason: 'manual-resume', rechecks: 0, evidence: { kind: 'agent-session-store' } } }] }))
  const target: WorkbenchViewTarget = { hostId: 'visible-secondary', active: true, visible: true,
    reference: { displayWorkspaceId: 'workspace', groupId: 'secondary-group', tabId: 'original-tab', regionId: 'original-region' } }
  const slot = document.createElement('div'); slot.id = workbenchSessionStageHostId(target, 'original-region'); document.body.append(slot)
  try {
    await dom.render(<SessionPane sessionId={original.id} surfaceKind="agent" visible={false} interactiveResize={false}
      presentations={[target]} renderPresentationFrame={content => content}
      linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' }} />)
    expect(dom.container.querySelector('.full-page-loading [data-icon-animation="wait"]')).toBeNull()
    expect(slot.querySelector('.full-page-loading [data-icon-animation="wait"]')).not.toBeNull()
    expect(slot.textContent).toContain('Restoring your session')
    noSideEffects()
  } finally { await dom.render(null); slot.remove() }
})
