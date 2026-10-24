// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-live-terminal /> }))
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { pendingAgentLaunchStorageWait, reduceAgentSessionLaunchAttached, runtimeDiagnosticNotice } from '../src/renderer/src/lib/session-state'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { agentCreationFixture } from './helpers/agent-creation-fixture'
import type { RuntimeEvent } from '../src/shared/contracts'

const dom = composerDOM(), sid = 'storage-wait-original', tabId = 'storage-tab', regionId = 'storage-region'
function event(hostId = 'local', agentSessionId = sid, message = 'ENOSPC: original Session journal is full. Next attempt in 1 second.'): RuntimeEvent {
  return { hostId, event: { type: 'agent-error', agentSessionId, code: 'AGENT_CREATION_WAITING_FOR_STORAGE', message,
    evidence: { source: 'agentmux', observedAt: 1 } } }
}
beforeEach(() => {
  const tab = createWorkbenchTab(tabId, { regionId, kind: 'agent', phase: 'launching', sessionId: sid, workspaceId: 'workspace' })
  useAppStore.setState({ config: composerConfig, sessions: [], tabs: { [tabId]: tab }, layouts: {}, timelines: {}, viewModes: {},
    recoveryCandidates: [], notificationEvents: [], error: null, lastError: null, errorNoticeContext: null,
    pendingAgentLaunches: { [sid]: { request: { executorId: 'codex', hostId: 'local', createOperationId: 'original-operation',
      prompt: 'Original submitted prompt' }, events: [], overflowed: false } }, agentComposerDrafts: { [sid]: 'Keep my unsent draft' } })
  vi.spyOn(api.sessions, 'launchAgent')
  vi.spyOn(api.sessions, 'creation').mockRejectedValue(new Error('Original creation record is not available yet'))
})
async function mount(readOnly = false) {
  await dom.render(<SessionPane sessionId={sid} surfaceKind="agent" visible readOnly={readOnly} interactiveResize={false}
    linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'original-group', tabId, regionId }} />)
}
async function receive(incoming: RuntimeEvent) { await act(async () => useAppStore.getState().applyEvent(incoming)) }

it('routes the original storage wait through actual Store and Pane, keeps read failures secondary, then settles on actual creation projection', async () => {
  const original = useAppStore.getState(), notice = event()
  await mount(); await receive(notice)
  const window = dom.container.querySelector('.service-window')
  expect(window?.getAttribute('role')).toBe('status')
  expect(window?.textContent).toContain(notice.event.type === 'agent-error' ? notice.event.message : '')
  expect(window?.textContent).toContain('The original Session, request and initial prompt are retained')
  expect(window?.textContent).not.toContain('has not started')
  expect(window?.textContent).toContain('will continue automatically')
  expect(window?.querySelector('.surface-state__title')?.textContent ?? window?.textContent).toContain('Waiting for storage')
  const details = window?.querySelector('details')
  expect(details).not.toBeNull(); expect(details!.open).toBe(false)
  await act(async () => details!.querySelector('summary')!.click())
  expect(details!.open).toBe(true)
  expect(details!.textContent).toContain('ENOSPC: original Session journal is full')
  expect(dom.container.textContent).toContain('Original submitted prompt')
  expect(useAppStore.getState().notificationEvents).toEqual([])
  expect(useAppStore.getState().error).toBeNull()
  const check = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Check original')
  expect(check).toBeDefined(); await act(async () => check!.click())
  expect(api.sessions.creation).toHaveBeenCalledWith('local', sid)
  expect(dom.container.textContent).toContain('ENOSPC: original Session journal is full')
  expect(dom.container.textContent).toContain('Latest read: Original creation record is not available yet')
  expect(api.sessions.launchAgent).not.toHaveBeenCalled()
  expect(useAppStore.getState().tabs).toBe(original.tabs)
  expect(useAppStore.getState().agentComposerDrafts).toBe(original.agentComposerDrafts)
  await receive(event('local', sid, 'EDQUOT: original journal quota is exhausted. Next attempt in 2 seconds.'))
  expect(dom.container.textContent).toContain('EDQUOT: original journal quota is exhausted')
  expect(dom.container.textContent).not.toContain('ENOSPC: original Session journal is full')
  const session = composerSession(sid)
  await act(async () => useAppStore.setState(state => reduceAgentSessionLaunchAttached(state, regionId, {
    created: agentCreationFixture(session), session, timeline: { agentSessionId: sid, revision: 0, items: [] }, projectionFailures: []
  }).state))
  expect(dom.container.querySelector('[data-live-terminal]')).not.toBeNull()
  expect(dom.container.textContent).not.toContain('journal quota is exhausted')
  expect(useAppStore.getState().pendingAgentLaunches[sid]).toBeUndefined()
  expect(useAppStore.getState().notificationEvents).toEqual([])
  await receive(notice)
  expect(useAppStore.getState().notificationEvents).toEqual([])
  expect(dom.container.textContent).not.toContain('will continue automatically')
  expect(runtimeDiagnosticNotice(useAppStore.getState(), event('another-host'))?.message).toContain('another-host')
})

it('keeps uncertain preparation facts neutral in the original pending Region without admitting a new launch', async () => {
  const original = useAppStore.getState()
  await mount()
  await receive(event('local', sid, 'Storage is unavailable while checking the original creation. Its result is not confirmed.'))
  const notice = dom.container.querySelector('.service-window')
  expect(notice?.textContent).toContain('Its result is not confirmed')
  expect(notice?.textContent).toContain('The original request and initial prompt are kept')
  expect(notice?.textContent).not.toContain('has not started')
  expect(dom.container.textContent).toContain('Original submitted prompt')
  expect([...dom.container.querySelectorAll('button')].some(button => button.textContent?.trim() === 'Check original')).toBe(true)
  expect(useAppStore.getState().tabs).toBe(original.tabs)
  expect(useAppStore.getState().agentComposerDrafts).toBe(original.agentComposerDrafts)
  expect(useAppStore.getState().pendingAgentLaunches[sid]?.request?.createOperationId).toBe('original-operation')
  expect(api.sessions.launchAgent).not.toHaveBeenCalled()
})

it.each(['wrong-host', 'wrong-session', 'no-pending', 'accepted'] as const)('keeps diagnostics without a matching active pending owner: %s', kind => {
  const state = useAppStore.getState(), incoming = event(kind === 'wrong-host' ? 'another-host' : 'local', kind === 'wrong-session' ? 'another-session' : sid)
  const session = composerSession(sid)
  const pending = kind === 'no-pending' ? undefined : { ...state.pendingAgentLaunches[sid]!, events: [incoming],
    ...(kind === 'accepted' ? { created: agentCreationFixture(session) } : {}) }
  const projection = { ...state, pendingAgentLaunches: pending ? { [sid]: pending } : {} }
  expect(pendingAgentLaunchStorageWait(pending, sid)).toBeUndefined()
  expect(runtimeDiagnosticNotice(projection, incoming)?.message).toContain('original Session journal is full')
})

it('shows the same notice in a read-only presentation without creating recovery or retry ownership', async () => {
  await receive(event()); await mount(true)
  expect(dom.container.textContent).toContain('will continue automatically')
  expect([...dom.container.querySelectorAll('button')].some(button => button.textContent?.includes('Check original'))).toBe(false)
  expect(api.sessions.launchAgent).not.toHaveBeenCalled()
})

it('settles only on the original Core retry-stopped event, retaining the final unknown diagnostic', async () => {
  await mount(); await receive(event())
  const stopped = event('another-host')
  if (stopped.event.type !== 'agent-error') throw new Error('Expected fixture diagnostic')
  stopped.event.code = 'AGENT_CREATION_RESOURCE_RETRY_STOPPED'
  stopped.event.message = 'Automatic creation retry ended. Original operation result is unknown.'
  await receive(stopped)
  expect(dom.container.textContent).toContain('will continue automatically')
  expect(useAppStore.getState().error).toContain('another-host')
  await receive({ ...stopped, hostId: 'local' })
  expect(dom.container.textContent).not.toContain('will continue automatically')
  expect(useAppStore.getState().error).toContain('Original operation result is unknown')
  expect(useAppStore.getState().pendingAgentLaunches[sid]?.request?.createOperationId).toBe('original-operation')
  expect(api.sessions.launchAgent).not.toHaveBeenCalled()
})
