// @vitest-environment happy-dom
import { act, createElement, Profiler } from 'react'
import { createRequire } from 'node:module'
import { beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { workbenchNavigationCatalog } from '../src/renderer/src/lib/workbench-navigation-catalog'
import type { WorkbenchProjection } from '../src/renderer/src/lib/workbench-projection'
import { workbenchProjectionSlotId } from '../src/renderer/src/lib/workbench-projection'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

// Only native PTY painting is replaced; both Workbench shells and SessionPane are real.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => createElement('div', { 'data-original-terminal': '' }) }))
vi.mock('react-resizable-panels', () => createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
const dom = composerDOM(), workspace = composerConfig.workspaces[0]!, session = composerSession('scope-agent')
const tab = createWorkbenchTab('scope-tab', { regionId: 'scope-region', workspaceId: workspace.id, kind: 'agent', phase: 'attached', sessionId: session.id })
const reference = { displayWorkspaceId: workspace.id, groupId: 'owner-group', tabId: tab.id, regionId: tab.layout.activeRegionId }
beforeEach(() => {
  useAppStore.setState({ sessions: [session], tabs: { [tab.id]: tab },
    layouts: { [workspace.id]: createWorkspaceLayout(reference.groupId, [tab.id]), foreign: createWorkspaceLayout('foreign-group', [tab.id]) },
    viewModes: { [session.id]: 'terminal' }, agentComposerDrafts: { [session.id]: 'Original draft' },
    workbenchSpaceSelection: null, activeWorkspaceId: workspace.id })
})
function projection(kind: 'tab' | 'region'): WorkbenchProjection {
  const catalog = workbenchNavigationCatalog(useAppStore.getState())
  expect(catalog.locations.some(location => location.tabId === tab.id && location.groupId === reference.groupId)).toBe(true)
  return { entity: kind === 'tab' ? { kind, tabId: tab.id } : { kind, regionId: reference.regionId },
    presentationId: 'focus-mode-scope', displayWorkspaceId: workspace.id, catalog, selection: [reference], onSelect() {} }
}
async function switchMode(mode: 'terminal' | 'activity', id = session.id) {
  await act(async () => useAppStore.getState().setViewMode(id, mode, { focus: false }))
}
it.each(['tab', 'region'] as const)('does no mode-only render work in a %s projection shell', async kind => {
  const committed = vi.fn()
  await dom.render(<Profiler id="projection" onRender={committed}>
    <WorkspaceWorkbench workspaceId={workspace.id} viewOwnership="projection" projection={projection(kind)} />
  </Profiler>)
  const slot = dom.container.querySelector('.workbench-tab-slot, .workbench-region-slot')!
  expect(slot).not.toBeNull()
  committed.mockClear()
  for (const mode of ['activity', 'terminal', 'activity'] as const) await switchMode(mode)
  await switchMode('activity', 'unrelated-agent')
  expect(committed).not.toHaveBeenCalled()
  expect(slot.isConnected).toBe(true)
  expect(useAppStore.getState().tabs[tab.id]).toBe(tab)
})

it.each(['projection', 'foreign'] as const)('releases mode subscriptions when the same Workbench becomes %s chrome', async next => {
  const committed = vi.fn(), scope = projection('tab')
  const render = (owner: boolean) => dom.render(<Profiler id="changing-scope" onRender={committed}>
    <WorkspaceWorkbench workspaceId={owner || next === 'projection' ? workspace.id : 'foreign'}
      viewOwnership={!owner && next === 'projection' ? 'projection' : 'owner'}
      {...(!owner && next === 'projection' ? { projection: scope } : {})} />
  </Profiler>)
  await render(true)
  expect(dom.container.querySelector('[data-original-terminal]')).not.toBeNull()
  await render(false)
  committed.mockClear()
  await switchMode('activity'); await switchMode('terminal')
  expect(committed).not.toHaveBeenCalled()
})

it('keeps the original resource owner live when its content is displayed in another Workspace', async () => {
  const target = document.createElement('div'); target.id = 'foreign-mode-target'; document.body.append(target)
  const foreignReference = { ...reference, displayWorkspaceId: 'foreign', groupId: 'foreign-group' }
  try {
    const browser = await api.browser.create('owner-scope-page', 'about:blank', workspace.id)
    const split = addWorkbenchRegion(tab, reference.regionId, 'right', { ...browser, kind: 'browser', workspaceId: workspace.id, regionId: 'browser-region', browserId: browser.id })
    useAppStore.setState({ tabs: { [tab.id]: split } })
    const homeId = workbenchProjectionSlotId('workbench-tab-slot', reference)
    await dom.render(<WorkspaceWorkbench workspaceId={workspace.id} viewTargets={{ [tab.id]: [
      { hostId: homeId, active: false, visible: true, surface: 'space', reference },
      { hostId: target.id, active: true, visible: true, surface: 'mote', reference: foreignReference }
    ] }} />)
    const primary = target.querySelector('[data-workbench-primary-tab-id]')!
    const terminal = target.querySelector('[data-original-terminal]')!
    expect(primary).not.toBeNull(); expect(terminal).not.toBeNull()
    expect(document.activeElement).toBe(document.body)
    for (const mode of ['activity', 'terminal', 'activity'] as const) {
      await switchMode(mode)
      // The original owner, not SessionPane's independent mode hook, decides repeatability.
      expect(primary.parentElement?.id).toBe(mode === 'activity' ? homeId : target.id)
      expect(primary.querySelector('.agent-surface')?.getAttribute('data-agent-surface-mode')).toBe(mode)
      expect(primary.querySelector('[data-original-terminal]')).toBe(terminal)
    }
    expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Original draft')
    expect(useAppStore.getState().sessions[0]!.control).toBe(session.control)
  } finally { target.remove() }
})
