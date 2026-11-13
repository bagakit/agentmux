// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-live-terminal /> }))
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { runEndedByRuntimeRestart, sessionExitPresentation } from '../src/renderer/src/lib/session-recovery-banner'
import { agentSessionServiceOutcome } from '../src/renderer/src/lib/service-window-notice'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { sessionStopReceipt } from './helpers/session-stop-receipt'
import { currentNotificationRows, expandNotificationGroups, toggleNotificationCenter, toggleNotificationDetails } from './helpers/notification-center'

const dom = composerDOM()
const ended = () => ({ ...composerSession('ended-agent'), processState: 'interrupted' as const,
  interruptionReason: 'daemon_restart', status: { state: 'disconnected' as const, source: 'run-process' as const, observedAt: 42 } })
const tab = createWorkbenchTab('ended-tab', { regionId: 'ended-region', workspaceId: 'workspace', kind: 'agent', phase: 'attached', sessionId: 'ended-agent' })
beforeEach(() => {
  useAppStore.setState({ sessions: [ended()], pendingAgentLaunches: {}, recoveryCandidates: [], timelines: {},
    tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout('ended-group', [tab.id]) },
    activeWorkspaceId: 'workspace', viewModes: { 'ended-agent': 'terminal' }, agentComposerDrafts: { 'ended-agent': 'Keep this unsent draft' },
    loading: false, runtimeEndpointWarnings: [], runtimeOwnershipWarnings: [], displacedAgentSessionIds: [], environmentWarning: undefined,
    workbenchSaveWarning: null, nameSaveUnconfirmed: null, nameEditFailure: null, notificationEvents: [], noticeReadReceipts: {},
    error: null, lastError: null, errorNoticeContext: null, desktopNavigationNotice: null, agentOperations: {} })
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue({ items: [], source: 'unavailable' } as never)
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
  vi.spyOn(api.sessions, 'stop').mockImplementation(async (control, operationId) => control.kind === 'agent' ? sessionStopReceipt(control, operationId!) : undefined)
  vi.spyOn(api.sessions, 'write').mockRejectedValue(new Error('Fixture never writes input'))
})
const pane = () => dom.render(<SessionPane sessionId="ended-agent" surfaceKind="agent" visible interactiveResize={false}
  linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'ended-group', tabId: tab.id, regionId: 'ended-region' }} />)
const click = async (label: string, scope: ParentNode = document) => {
  const button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)
  expect(button, `Missing action ${label}`).toBeDefined()
  await act(async () => button!.click())
}

it('only the exact confirmed Runtime restart fact presents an ended Run', () => {
  expect(runEndedByRuntimeRestart(ended())).toBe(true)
  for (const session of [{ ...ended(), processState: 'running' as const }, { ...ended(), interruptionReason: 'connection-gap' },
    { ...ended(), interruptionReason: undefined }, { ...ended(), runUnobserved: true }]) {
    expect(runEndedByRuntimeRestart(session)).toBe(false)
    expect(sessionExitPresentation(session)).toBeNull()
  }
  expect(agentSessionServiceOutcome(ended())).toEqual({ completed: true })
  expect(agentSessionServiceOutcome({ ...ended(), runUnobserved: true }).completed).toBe(false)
})

it('the real Pane explains the ended Run and closes through Core with its original operation and Run', async () => {
  await pane()
  expect(dom.container.querySelector('.surface-state__title')?.textContent).toBe('Agent Run ended by Runtime restart')
  expect(dom.container.textContent).toContain('Resume the original conversation or close this Agent')
  expect([...dom.container.querySelectorAll('button')].some(button => /Restore original|Resume/.test(button.textContent ?? ''))).toBe(true)
  await click('Close Agent', dom.container)
  expect(api.sessions.stop).not.toHaveBeenCalled()
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('This Run has already ended')
  await click('Close Agent', document.querySelector('[role="dialog"]')!)
  await vi.waitFor(() => expect(api.sessions.stop).toHaveBeenCalledTimes(1))
  expect(vi.mocked(api.sessions.stop).mock.calls[0]).toEqual([ended().control, expect.any(String)])
  expect(dom.draft('ended-agent')).toBe('Keep this unsent draft')
  expect(api.sessions.write).not.toHaveBeenCalled()
})

it('an unknown interrupted Run keeps its original workface and observation controls', async () => {
  useAppStore.setState({ sessions: [{ ...ended(), runUnobserved: true }] })
  await pane()
  expect(dom.container.textContent).not.toContain('Run ended by Runtime restart')
  expect([...dom.container.querySelectorAll('button')].some(button => button.textContent === 'Close Agent')).toBe(false)
  expect(useAppStore.getState().tabs[tab.id]).toBe(tab)
  expect(dom.draft('ended-agent')).toBe('Keep this unsent draft')
  expect(api.sessions.stop).not.toHaveBeenCalled()
})

it('the global notification keeps the original fact time and exposes exact Resume and Close actions', async () => {
  const recover = vi.spyOn(useAppStore.getState(), 'recoverSession').mockResolvedValue(undefined)
  await dom.render(<GlobalSystemNotices />)
  await toggleNotificationCenter(dom.container, 'open')
  await expandNotificationGroups(dom.container)
  const row = currentNotificationRows(dom.container).find(item => item.textContent?.includes('Agent Run ended by Runtime restart'))!
  expect(row).toBeDefined()
  const time = row.querySelector('time')?.getAttribute('datetime')
  expect(time).toBe(new Date(42).toISOString())
  await click('Resume', row)
  expect(recover).toHaveBeenCalledExactlyOnceWith('ended-agent', undefined, { inputControl: ended().control })
  await toggleNotificationDetails(row)
  expect(row.textContent).toContain('unsent draft are kept')
  await act(async () => useAppStore.setState({ sessions: [{ ...ended(), updatedAt: 9000 }] }))
  expect(currentNotificationRows(dom.container).find(item => item.textContent?.includes('Agent Run ended by Runtime restart'))?.querySelector('time')?.getAttribute('datetime')).toBe(time)
  expect(row.getAttribute('data-unread')).toBe('false')
  await click('Close Agent', row)
  await click('Close Agent', document.querySelector('[role="dialog"]')!)
  await vi.waitFor(() => expect(api.sessions.stop).toHaveBeenCalledTimes(1))
  expect(vi.mocked(api.sessions.stop).mock.calls[0]![0]).toEqual(ended().control)
  expect(api.sessions.write).not.toHaveBeenCalled()
})

it.each(['native-conversation-absent', 'provider-resume-unsupported', 'native-handle-unavailable'] as const)(
  'the notification respects the original Core recovery remedy for %s', async continuityReason => {
    const recover = vi.spyOn(useAppStore.getState(), 'recoverSession').mockResolvedValue(undefined)
    useAppStore.setState({ sessions: [{ ...ended(), status: { ...ended().status, continuity: 'unavailable', continuityReason } }] })
    await dom.render(<GlobalSystemNotices />)
    await toggleNotificationCenter(dom.container, 'open'); await expandNotificationGroups(dom.container)
    const row = currentNotificationRows(dom.container).find(item => item.textContent?.includes('Agent Run ended by Runtime restart'))!
    expect(row).toBeDefined()
    expect([...row.querySelectorAll('button')].map(button => button.textContent)).toContain('View Session')
    expect([...row.querySelectorAll('button')].map(button => button.textContent)).toContain(' Close Agent')
    expect([...row.querySelectorAll('button')].map(button => button.textContent)).not.toContain('Resume')
    expect(recover).not.toHaveBeenCalled(); expect(api.sessions.stop).not.toHaveBeenCalled()
  })
