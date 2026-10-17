// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-live-terminal /> }))
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { recoveryExitSession } from './helpers/recovery-exit-fixture'

const dom = composerDOM()
beforeEach(() => {
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue({ items: [], source: 'unavailable' } as never)
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
  vi.spyOn(api.sessions, 'recover').mockRejectedValue(new Error('No fixture lifecycle action is authorized'))
  vi.spyOn(api.sessions, 'write').mockRejectedValue(new Error('No fixture input is authorized'))
})
async function mount(kind = 'recovery-failed') {
  const session = recoveryExitSession(kind)
  const tab = createWorkbenchTab('original-tab', { regionId: 'original-region', workspaceId: 'workspace', kind: 'agent', phase: 'attached', sessionId: session.id })
  useAppStore.setState({ sessions: [session], pendingAgentLaunches: {}, recoveryCandidates: [],
    tabs: { [tab.id]: tab }, activeWorkspaceId: 'workspace', viewModes: { [session.id]: 'terminal' },
    timelines: {}, agentComposerDrafts: { [session.id]: 'Original unsent draft' }, agentSteerQueues: {} })
  await dom.render(<SessionPane sessionId={session.id} surfaceKind="agent" visible interactiveResize={false}
    linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'original-group', tabId: tab.id, regionId: 'original-region' }} />)
  return { session, tab }
}
it('shows the current recovery exit, original phase/count/error and exact identifiers in the actual Pane and Focus', async () => {
  const { session, tab } = await mount()
  expect(dom.container.querySelector('.full-page-loading .surface-state__title')?.textContent).toBe('Recovery process exited')
  const details = [...dom.container.querySelectorAll('details')].find(item => item.textContent?.includes('Retained Run'))!
  await act(async () => details.querySelector('summary')!.click())
  expect(details.open).toBe(true)
  expect(details.textContent).toContain('current-run')
  expect(details.textContent).toContain('Recovery phasepaused')
  expect(details.textContent).toContain('Recovery attempts2 of 2')
  expect(details.textContent).toContain(session.continuity!.error)
  expect(agentContextForSession(session, undefined, undefined, composerConfig.workspaces[0], null).detail)
    .toBe('Recovery process exited · Exit code 1')
  expect([...dom.container.querySelectorAll('button')].some(button => button.textContent?.includes('Restore original'))).toBe(true)
  expect(useAppStore.getState().tabs[tab.id]).toBe(tab)
  expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Original unsent draft')
  expect(api.sessions.recover).not.toHaveBeenCalled(); expect(api.sessions.write).not.toHaveBeenCalled()
})
it.each(['ordinary-exit', 'previous-attempt', 'foreign-session'])('keeps %s separate from a current recovery failure', async kind => {
  const { session } = await mount(kind)
  expect(dom.container.querySelector('.full-page-loading .surface-state__title')?.textContent).toBe('Agent process exited')
  const details = [...dom.container.querySelectorAll('details')].find(item => item.textContent?.includes('Retained Run'))!
  expect(details.textContent).not.toContain('Recovery operation')
  expect(details.textContent).not.toContain('startup request was rejected')
  expect(agentContextForSession(session, undefined, undefined, composerConfig.workspaces[0], null).detail)
    .toBe('Agent process exited · Exit code 1')
})
it('keeps a missing cause explicitly unknown without inventing an error', async () => {
  await mount('unknown-cause')
  expect(dom.container.textContent).toContain('The recovery attempt did not report a specific cause.')
  expect(dom.container.textContent).not.toContain('startup request was rejected')
})
it('uses an exact retained error when no exit code was observed', async () => {
  const { session } = await mount('no-exit-code')
  expect(agentContextForSession(session, undefined, undefined, composerConfig.workspaces[0], null).detail).toBe(session.continuity!.error)
})
it('keeps a healthy Run free of old failure copy and preserves its terminal and draft', async () => {
  const { session } = await mount('healthy')
  expect(dom.container.querySelector('[data-live-terminal]')).not.toBeNull()
  expect(dom.container.querySelector('.full-page-loading .surface-state__title')).toBeNull()
  expect(dom.container.textContent).not.toContain('Recovery process exited')
  expect(dom.container.textContent).not.toContain('startup request was rejected')
  expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Original unsent draft')
})
