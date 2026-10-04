// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { appendFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { seedMoteWorkface, executionAgent, defaultAgent, moteTopics, installNativePopover } from './fixtures/mote-workface'
import { api } from '../src/renderer/src/lib/api'
import { addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { useAppStore } from '../src/renderer/src/store'
import { startWorkfaceFileFixture } from './helpers/workface-file-fixture'
import { regionIdA, regionIdB, targetSid, tabId } from './helpers/workface-control-fixture'
import { mainRegionReference } from '../src/renderer/src/lib/desktop-focus-navigation'
import { createSessionProjectFileContextSelector } from '../src/renderer/src/lib/session-project-file-context'
import { sessionFileRegionAvailable } from '../src/renderer/src/lib/session-link-opening'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { App } from '../src/renderer/src/App'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingClose } from '../src/renderer/src/lib/pmo-teams-topic-floating'
const initial = useAppStore.getState()
async function fixture(surface: 'mote' | 'space') {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear(); const restorePopover = installNativePopover()
  useAppStore.setState(initial, true); seedMoteWorkface()
  const state = useAppStore.getState(), original = state.tabs['default-tab']!
  const agent = addWorkbenchRegion(original, 'default-region', 'right', { kind: 'agent', phase: 'attached', workspaceId: original.workspaceId, regionId: 'local-agent', sessionId: executionAgent.id })
  const tab = addWorkbenchRegion(agent, 'default-region', 'down', { kind: 'file', workspaceId: original.workspaceId, regionId: 'main-file', path: 'original.md' })
  const session = { ...executionAgent, pendingInteraction: { kind: 'question' as const, responseUnavailableReason: 'This request needs its original terminal confirmation', id: 'original-question', agentSessionId: executionAgent.id,
    evidence: { source: 'native-hook' as const, observedAt: 3, run: executionAgent.control.run, hookReceiptId: 'original-question' }, questions: [{ id: 'next', title: 'Next?', prompt: 'Choose next', options: [{ id: 'yes', label: 'Continue' }] }] } }
  useAppStore.setState({ tabs: { ...state.tabs, [tab.id]: tab }, mainSurface: 'agents',
    sessions: state.sessions.map(item => item.id === session.id ? session : item), viewModes: { [session.id]: 'terminal' } })
  const main = { displayWorkspaceId: original.workspaceId, groupId: 'mote-group', tabId: tab.id, regionId: 'main-file' }
  const reference = { ...main, regionId: 'local-agent' }
  expect(useAppStore.getState().selectMainRegion(main)).toBe(true)
  const before = useAppStore.getState(), container = document.createElement('div'); document.body.append(container); const root = createClientUiRoot(container)
  await act(async () => root.render(createElement(WorkbenchPresentationContext.Provider, { value: { active: true, retainedRegionId: null, surface, reference,
    onSelectRegion(regionId) { useAppStore.getState().focusRegion(reference.displayWorkspaceId, reference.tabId, regionId, surface === 'mote' ? 'floating-pointer' : 'pointer', reference.groupId) } } },
    createElement(SessionPane, { sessionId: session.id, surfaceKind: 'agent', visible: true, interactiveResize: false,
      linkOrigin: { workspaceId: original.workspaceId, tabGroupId: 'mote-group', tabId: tab.id, regionId: reference.regionId, sessionId: session.id } }))))
  return { container, before, main, reference, async close() { await act(async () => root.unmount()); container.remove(); restorePopover(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear() } }
}
for (const surface of ['mote', 'space'] as const) {
  it(`actual SessionPane ${surface} interaction Open terminal consumes its presentation selection cause`, async () => {
    const f = await fixture(surface)
    try {
      const button = [...f.container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Open terminal')
      expect(button).toBeTruthy(); await act(async () => button!.click())
      const after = useAppStore.getState()
      expect(after.workbenchSpaceSelection).toMatchObject({ workspaceId: f.main.displayWorkspaceId, groupId: f.main.groupId, tabId: f.main.tabId,
        regionId: surface === 'mote' ? f.main.regionId : f.reference.regionId })
      if (surface === 'mote') expect(after.agentFocus.execution).toBe(f.before.agentFocus.execution)
    } finally { await f.close() }
  })
  it(`actual SessionPane ${surface} close history consumes its presentation selection cause`, async () => {
    const f = await fixture(surface)
    try {
      const more = f.container.querySelector<HTMLButtonElement>('.agent-region-header__more'); expect(more).not.toBeNull()
      await act(async () => more!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 })))
      const item = [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find(node => node.textContent?.includes('Conversation history'))
      expect(item).toBeTruthy(); await act(async () => item!.click())
      await vi.waitFor(() => expect(f.container.querySelector('button[aria-label="Return to Terminal"]')).not.toBeNull())
      const back = f.container.querySelector<HTMLButtonElement>('button[aria-label="Return to Terminal"]')!
      await act(async () => back.click())
      const after = useAppStore.getState()
      expect(after.workbenchSpaceSelection?.regionId).toBe(surface === 'mote' ? f.main.regionId : f.reference.regionId)
      if (surface === 'mote') expect(after.agentFocus.execution).toBe(f.before.agentFocus.execution)
    } finally { await f.close() }
  })
}


for (const [mainSurface, destination, kind] of [['workbench', 'right', 'file'], ['agents', 'right', 'file'], ['agents', 'tab', 'file'], ['agents', 'system', 'file'], ['agents', 'right', 'http']] as const) {
  it(`actual sidecar Markdown over ${mainSurface} keeps its existing explicit ${kind} ${destination} scope`, async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear(); useAppStore.setState(initial, true)
    const privateWorkface = await startWorkfaceFileFixture(), restorePopover = installNativePopover()
    const main = { displayWorkspaceId: 'display', groupId: 'display-group', tabId, regionId: regionIdA }
    const reference = { ...main, regionId: regionIdB }
    const origin = { workspaceId: reference.displayWorkspaceId, tabGroupId: reference.groupId, tabId, regionId: regionIdB, sessionId: targetSid }
    const path = 'src/sidecar.md', state = useAppStore.getState()
    useAppStore.setState({ config: { ...state.config!, focus: { ...state.config?.focus, recentActivityHours: state.config?.focus?.recentActivityHours ?? 48, linkDestination: 'region' } }, mainSurface,
      agentFocus: { execution: { sessionId: targetSid, reference: main, history: [{ sessionId: targetSid, focusedAt: 1 }] }, pmo: { sessionId: null } },
      viewModes: { [targetSid]: 'activity' }, timelines: { [targetSid]: { agentSessionId: targetSid, revision: 1,
        items: [{ id: 'original-sidecar-reply', agentSessionId: targetSid, kind: 'assistant_message', title: 'Original reply',
          content: kind === 'file' ? '[source](./src/sidecar.md)' : '[source](https://example.test/sidecar)', source: 'native-hook', status: 'complete', createdAt: 100, updatedAt: 100 }] } } })
    expect(useAppStore.getState().selectMainRegion(main)).toBe(true)
    const before = useAppStore.getState(), context = createSessionProjectFileContextSelector(targetSid, origin)(before)
    expect(sessionFileRegionAvailable(origin, context)).toBe(true)
    const system = vi.spyOn(api.files, 'openSystem').mockResolvedValue(undefined)
    const container = document.createElement('div'); document.body.append(container); const root = createClientUiRoot(container)
    const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve() }
    try {
      await act(async () => { root.render(createElement(WorkbenchPresentationContext.Provider, { value: { active: true, retainedRegionId: null, surface: 'mote', reference,
        onSelectRegion(regionId) { useAppStore.getState().focusRegion(reference.displayWorkspaceId, reference.tabId, regionId, 'floating-pointer', reference.groupId) } } },
        createElement(SessionPane, { sessionId: targetSid, surfaceKind: 'agent', visible: true, interactiveResize: false, linkOrigin: origin }))); await flush() })
      const disclosure = container.querySelector<HTMLDetailsElement>('details.activity-feed__observations')
      if (disclosure) await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event('toggle')); await flush() })
      const source = container.querySelector<HTMLButtonElement>(kind === 'file' ? 'button.md-link--file' : 'button.md-link'); expect(source).not.toBeNull()
      await act(async () => { source!.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true })); await flush() })
      expect(mainRegionReference(useAppStore.getState().workbenchSpaceSelection)).toEqual(main)
      expect(useAppStore.getState().agentFocus.execution).toBe(before.agentFocus.execution)
      const button = document.querySelector<HTMLButtonElement>(`button[data-destination="${destination}"]`)
      expect(button).not.toBeNull(); expect(button!.disabled).toBe(false)
      await act(async () => { button!.click(); await flush() })
      const after = useAppStore.getState(), file = Object.values(after.tabs).flatMap(tab => Object.values(tab.regions)).find(region => kind === 'file' ? region.kind === 'file' && region.path === path : region.kind === 'browser' && region.url === 'https://example.test/sidecar')
      expect(after.agentFocus.execution).toBe(before.agentFocus.execution)
      expect(after.agentComposerDrafts).toEqual(before.agentComposerDrafts); privateWorkface.noLifecycle()
      if (destination === 'system') {
        expect(system).toHaveBeenCalledWith('resource', path)
        expect(mainRegionReference(after.workbenchSpaceSelection)).toEqual(main)
      } else {
        expect(file).toBeDefined()
        if (destination === 'right') {
          expect(after.tabs[tabId]!.regions[file!.regionId]).toBe(file)
          if (kind === 'http') { expect(mainRegionReference(after.workbenchSpaceSelection)).toEqual(main); expect(after.mainSurface).toBe(mainSurface); expect(after.tabs[tabId]!.layout.activeRegionId).toBe(file!.regionId) }
          else expect(after.mainSurface).toBe('workbench')
        }
        else { expect(after.mainSurface).toBe('workbench'); expect(mainRegionReference(after.workbenchSpaceSelection)?.regionId).toBe(file!.regionId) }
      }
    } finally {
      await act(async () => root.unmount()); container.remove(); restorePopover(); await privateWorkface.stop()
      document.getElementById('agentmux-window-overlay-host')?.remove()
      useAppStore.setState(initial, true); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals()
    }
  })
}


it.each(['immediate', 'immediate-source', 'later-region', 'later-tab'] as const)('actual App and SessionPane sidecar HTTP %s preserves main and follows only its current local View', async completion => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear(); requestPmoTeamsTopicFloatingClose()
  const restorePopover = installNativePopover(), initialLauncher = useLauncherState.getState()
  useAppStore.setState({ ...initial, initialize: async () => () => {}, loading: false }, true); seedMoteWorkface()
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(moteTopics)
  vi.spyOn(api.scratch, 'ensureMote').mockResolvedValue(moteTopics[0]!)
  const state = useAppStore.getState(), original = state.tabs['default-tab']!
  const sourceTab = completion === 'immediate-source' ? addWorkbenchRegion(original, 'default-region', 'right', { kind: 'agent', phase: 'attached', workspaceId: original.workspaceId, regionId: 'other-sidecar-agent', sessionId: executionAgent.id }) : original
  const tab = addWorkbenchRegion(sourceTab, 'default-region', 'down', { kind: 'file', workspaceId: original.workspaceId, regionId: 'app-main-file', path: 'main.md' })
  useAppStore.setState({ tabs: { ...state.tabs, [tab.id]: tab }, mainSurface: 'agents', projectRailOpen: false, toolsOpen: false,
    config: { ...state.config!, focus: { recentActivityHours: 48, linkDestination: 'region' } },
    viewModes: { [defaultAgent.id]: 'activity', [executionAgent.id]: 'activity' }, timelines: { [defaultAgent.id]: { agentSessionId: defaultAgent.id, revision: 1, items: [{ id: 'sidecar-http-speech', agentSessionId: defaultAgent.id, kind: 'assistant_message', title: 'Original reply', content: '[source](https://example.test/app-sidecar)', source: 'native-hook', status: 'complete', createdAt: 100, updatedAt: 100 }] } },
    sessions: state.sessions.map(session => session.id === defaultAgent.id && session.kind === 'agent' ? { ...session, pendingInteraction: { kind: 'question', id: 'app-question', agentSessionId: session.id,
      evidence: { source: 'native-hook', observedAt: 3, run: session.control.run, hookReceiptId: 'app-question' }, questions: [{ id: 'next', title: 'Next?', prompt: 'Choose next', options: [{ id: 'go', label: 'Continue' }] }] } } : session) })
  const main = { displayWorkspaceId: original.workspaceId, groupId: 'mote-group', tabId: tab.id, regionId: 'app-main-file' }
  expect(useAppStore.getState().selectMainRegion(main)).toBe(true)
  const container = document.createElement('div'); document.body.append(container); const root = createClientUiRoot(container)
  const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve() }
  const mainWrites: unknown[] = []
  const off = useAppStore.subscribe((next,old) => { if (next.workbenchSpaceSelection !== old.workbenchSpaceSelection) mainWrites.push(next.workbenchSpaceSelection) })
  try {
    await act(async () => { root.render(createElement(App)); await flush() })
    const before = useAppStore.getState()
    const attention = container.querySelector<HTMLButtonElement>('.focus-pmo-attention'); expect(attention).not.toBeNull()
    await act(async () => { attention!.click(); await flush() })
    const panel = document.querySelector<HTMLElement>('[data-pmo-teams-topic-floating]'); expect(panel).not.toBeNull()
    const disclosure = panel!.querySelector<HTMLDetailsElement>('details.activity-feed__observations')
    expect(disclosure).not.toBeNull()
    await act(async () => { disclosure!.open = true; disclosure!.dispatchEvent(new Event('toggle')); await flush() })
    if (completion === 'immediate-source') await act(async () => { const sibling = panel!.querySelector<HTMLElement>('[data-workbench-region-id=other-sidecar-agent]'); expect(sibling).not.toBeNull(); sibling!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 })); await flush() })
    const link = panel!.querySelector<HTMLButtonElement>('button.md-link'); expect(link).not.toBeNull()
    let release!: (value: Awaited<ReturnType<typeof api.browser.create>>) => void
    if (completion.startsWith('later-')) vi.spyOn(api.browser, 'create').mockImplementation(() => new Promise(resolve => { release = resolve }))
    await act(async () => { link!.click(); await flush() })
    const pending = Object.values(useAppStore.getState().tabs[tab.id]!.regions).find(region => region.kind === (completion.startsWith('immediate') ? 'browser' : 'launcher'))
    expect(pending, panel!.textContent ?? 'empty sidecar').toBeDefined()
    if (completion === 'later-region') await act(async () => { const region = panel!.querySelector<HTMLElement>('[data-workbench-region-id=default-region]'); expect(region).not.toBeNull(); region!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 })); await flush() })
    if (completion === 'later-tab') await act(async () => { panel!.querySelector<HTMLButtonElement>('button[data-workbench-tab-id="neighbor-tab"]')!.click(); await flush() })
    if (completion.startsWith('later-')) await act(async () => { release({ id: pending!.regionId, navigationId: 'private-sidecar-navigation', profileId: 'private-profile', url: 'https://example.test/app-sidecar', title: 'Sidecar page', loading: false, canGoBack: false, canGoForward: false, viewport: 'responsive', error: null, driving: false, appLinkPrompt: null }); await flush() })
    expect(useAppStore.getState().tabs[tab.id]!.regions[pending!.regionId]!.kind).toBe('browser')
    expect(mainRegionReference(useAppStore.getState().workbenchSpaceSelection), JSON.stringify({completion,main,after:useAppStore.getState().workbenchSpaceSelection})).toEqual(main)
    expect(useAppStore.getState().mainSurface).toBe('agents')
    expect(useAppStore.getState().agentFocus.execution).toBe(before.agentFocus.execution)
    expect(useAppStore.getState().agentComposerDrafts).toEqual(before.agentComposerDrafts)
    if (completion.startsWith('immediate')) {
      expect(readPmoTeamsTopicFloatingState()?.reference?.regionId).toBe(pending!.regionId)
      expect(panel!.querySelector(`[data-workbench-region-id="${pending!.regionId}"].workbench-region--active`)).not.toBeNull()
    } else if (completion === 'later-region') expect(useAppStore.getState().tabs[tab.id]!.layout.activeRegionId).toBe('default-region')
    else expect(panel!.dataset.moteTargetTab).toBe('neighbor-tab')
    expect(mainWrites).toEqual([])
    appendFileSync(process.env.AGENTMUX_RETURN_FACTS!, JSON.stringify({ name: 'actual-app-sidecar-completion', completion, main, mainAfter: mainRegionReference(useAppStore.getState().workbenchSpaceSelection), mainWrites, mainSurface: useAppStore.getState().mainSurface, browserRegion: pending!.regionId, localActiveRegion: useAppStore.getState().tabs[tab.id]!.layout.activeRegionId, floating: readPmoTeamsTopicFloatingState(), actualBrowserActive: Boolean(panel!.querySelector(`[data-workbench-region-id="${pending!.regionId}"].workbench-region--active`)), executionPreserved: useAppStore.getState().agentFocus.execution === before.agentFocus.execution, draftsPreserved: JSON.stringify(useAppStore.getState().agentComposerDrafts) === JSON.stringify(before.agentComposerDrafts), terminalPaintIsolated: true })+'\n')
  } finally {
    off(); requestPmoTeamsTopicFloatingClose(); await act(async () => root.unmount()); container.remove(); restorePopover();
    useAppStore.setState(initial, true); useLauncherState.setState(initialLauncher, true); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  }
})
