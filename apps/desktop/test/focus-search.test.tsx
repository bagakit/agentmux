// @vitest-environment happy-dom
import { fixtureEpoch as _newTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { formatAmuxObjectLink } from '@agentmux/core/sharing'
import { searchFocus } from '../src/renderer/src/lib/focus-search'
import { deriveFocusProjectLanes } from '../src/renderer/src/lib/focus-project-lanes'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { workbenchSelectionCatalog } from '../src/renderer/src/lib/desktop-focus-navigation'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createClientUiRoot } from './helpers/client-ui-render'
import { moteAgent, moteConfig, seedMoteWorkface } from './fixtures/mote-workface'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => createElement('output') }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
const initial = useAppStore.getState()
let container: HTMLDivElement, root: Root
const setQuery = async (query: string) => act(async () => {
 const input = container.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!
 Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, query)
 input.dispatchEvent(new Event('input', { bubbles: true }))
})
const shown = () => [...container.querySelectorAll<HTMLElement>('.focus-context')].map(row => row.dataset.sessionId)
beforeEach(async () => {
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); seedMoteWorkface()
 const workspace = { id: 'ResourceWorkspace', hostId: 'local', name: 'Search project', path: fixturePath('focus-search-project'), kind: 'folder' as const }
 const a = { ...moteAgent('ExactSession', null), workspacePath: workspace.path, nativeSessionId: 'NativeConversation', nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: 'NativeConversation' } }
 const b = { ...moteAgent('OtherSession', null), workspacePath: workspace.path }
 const tab = createWorkbenchTab('ExactTab', { kind: 'agent', phase: 'attached', workspaceId: workspace.id, regionId: 'ExactRegion', sessionId: a.id })
 const file = createWorkbenchTab('FileTab', { kind: 'file', workspaceId: workspace.id, regionId: 'FileRegion', path: 'notes.md' })
 useAppStore.setState({ loading: false, mainSurface: 'agents', config: { ...moteConfig, workspaces: [...moteConfig.workspaces, workspace] }, sessions: [a, b], timelines: {}, agentNames: { ExactSession: 'Investigation' },
  tabs: { [tab.id]: tab, [file.id]: file }, layouts: { [workspace.id]: createWorkspaceLayout('ExactGroup', [tab.id, file.id]), other: createWorkspaceLayout('OtherGroup', [tab.id]) },
  agentFocus: { execution: { sessionId: a.id, history: [] }, pmo: { sessionId: null } }, agentComposerDrafts: { ExactSession: 'Original unsent draft' } })
 vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
 vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: workspace.path })
 vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: null })
 vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
 for (const key of ['launchAgent', 'recover', 'resume', 'stop', 'write', 'interrupt', 'readHistory'] as const) vi.spyOn(api.sessions, key)
 container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.getElementById('agentmux-window-overlay-host')?.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('finds typed links, all original ID axes and text in the mounted Focus consumer without reading bodies', async () => {
 const state = useAppStore.getState(), catalog = workbenchSelectionCatalog(state)
 const location = catalog.locations.find(location => location.regionId === 'ExactRegion')!
 const space = catalog.spaces.find(space => space.spaceId === location.spaceId)!
 expect(space.projectId).toBeTruthy(); expect(space.projectId).not.toBe('ResourceWorkspace')
 await act(async () => useAppStore.setState({ timelines: { ExactSession: { agentSessionId: 'ExactSession', revision: 1, items: [{ id: 'original-working-observation', agentSessionId: 'ExactSession', kind: 'lifecycle', source: 'native-hook', status: 'complete', title: 'Original observation', createdAt: _newTailFixtureEpoch(0, 0, 1), updatedAt: _newTailFixtureEpoch(0, 0, 1), activityState: { run: { runId: 'RetainedOriginalRun' }, state: 'working', stateEnteredAt: _newTailFixtureEpoch(0, 0, 1) } }] } } }))
 await act(async () => root.render(<GlobalFocusSurface workspaceOpen={false} />))
 for (const query of ['ExactSession', 'Session', state.sessions[0]!.control.run.runId, 'NativeConversation', 'RetainedOriginalRun', 'ExactTab', 'ExactRegion', 'ResourceWorkspace', 'ExactGroup', space.projectId!, location.spaceId!, location.zoneId!, 'investigation', workspacePath(state)]) {
  await setQuery(query); expect(shown(), query).toContain('ExactSession')
 }
 for (const target of [{ kind: 'agent', agentSessionId: 'ExactSession' }, { kind: 'tab', tabId: 'ExactTab' }, { kind: 'region', regionId: 'ExactRegion' }, { kind: 'space', spaceId: location.spaceId! }, { kind: 'zone', zoneId: location.zoneId! }] as const) {
  await setQuery(formatAmuxObjectLink(target)); expect(shown(), target.kind).toContain('ExactSession')
 }
 await setQuery('exactsession'); expect(shown()).toEqual([])
 await setQuery('amux://tab/ExactSession'); expect(shown()).toEqual([])
 await setQuery('amux://agent/ExactSession?execute=true'); expect(shown()).toEqual([]); expect(container.textContent).toContain('Choose an amux')
 expect(useAppStore.getState().agentComposerDrafts).toBe(state.agentComposerDrafts); expect(useAppStore.getState().agentFocus).toBe(state.agentFocus)
 for (const key of ['launchAgent', 'recover', 'resume', 'stop', 'write', 'interrupt', 'readHistory'] as const) expect(api.sessions[key]).not.toHaveBeenCalled()
})
function workspacePath(state: ReturnType<typeof useAppStore.getState>) { return state.sessions[0]!.workspacePath }
it('lists resource and repeated exact occurrences and selects only the explicitly chosen reference', async () => {
 const onSelectLocation = vi.fn(), state = useAppStore.getState()
 await act(async () => root.render(<GlobalFocusSurface workspaceOpen={false} onSelectLocation={onSelectLocation} />))
 await setQuery('amux://tab/ExactTab')
 const buttons = [...container.querySelectorAll<HTMLButtonElement>('.focus-search-locations button')]
 expect(buttons).toHaveLength(2); expect(onSelectLocation).not.toHaveBeenCalled()
 await act(async () => buttons[1]!.click()); expect(onSelectLocation).toHaveBeenCalledOnce(); expect(onSelectLocation.mock.calls[0]![0]).toMatchObject({ displayWorkspaceId: 'other', groupId: 'OtherGroup', tabId: 'ExactTab', regionId: 'ExactRegion' })
 await setQuery('OtherGroup'); expect(container.querySelectorAll('.focus-search-locations button')).toHaveLength(1)
 await setQuery('amux://region/FileRegion'); expect(shown()).toEqual([]); expect(container.querySelector('.focus-search-locations')?.textContent).toContain('notes.md')
 expect(useAppStore.getState().tabs).toBe(state.tabs)
})
it('searches every retained member and its native identity, preserving link kinds and missing positions', () => {
 const state = useAppStore.getState(), rows = createFocusProjectionSelector()(state).contexts, lanes = deriveFocusProjectLanes(rows, state.config), catalog = workbenchSelectionCatalog(state)
 const history = ['old-one', 'old-two'].map(sessionId => ({ sessionId, focusedAt: _newTailFixtureEpoch(0, 0, 1), identity: { kind: 'agent' as const, providerId: 'generic', hostId: 'local', name: sessionId, workspacePath: fixturePath('closed'), project: { id: 'retained-project', name: 'Retained' }, topicId: 'OriginalTopic' } }))
 const input = { rows, lanes, catalog: { ...catalog, spaces: [...catalog.spaces, { spaceId: 'empty-space', kind: 'topic' as const, name: 'Empty Topic', hostId: 'local', directoryPath: fixturePath('empty'), projectId: null, topicId: 'EmptyTopic' }] }, history,
  sources: [{ hostId: 'local', agentSessionId: 'old-one', state: 'retired' as const, history: { providerId: 'generic', executorId: 'generic', workspacePath: fixturePath('closed'), createdAt: _newTailFixtureEpoch(0, 0, 1), nativeHandle: { kind: 'provider' as const, providerId: 'generic', sessionId: 'OldNative' } } }],
  retained: [{ key: '["local","retained-project"]', projectId: 'retained-project', name: 'Retained', hostId: 'local', identity: history[0]!.identity, lastFocusedAt: _newTailFixtureEpoch(0, 0, 1), lastActivityAt: null, recent: false, state: 'retired' as const }] }
 for (const query of ['old-two', 'OriginalTopic', 'OldNative', 'amux://agent/old-one']) expect([...searchFocus(query, input).projectKeys]).toEqual(['["local","retained-project"]'])
 expect(searchFocus('amux://space/empty-space', input).unplaced).toMatchObject([{ id: 'empty-space' }])
 expect(searchFocus('amux://agent/old-one', input).sources).toHaveLength(1)
 expect(searchFocus('amux://region/old-one', input).sources).toHaveLength(0)
})
it('keeps equal retained SIDs isolated by original Host and shows only matching native facts', () => {
 const state = useAppStore.getState(), rows = createFocusProjectionSelector()(state).contexts, catalog = workbenchSelectionCatalog(state)
 const source = (hostId: string, native: string) => ({ hostId, agentSessionId: 'SharedSID', state: 'retired' as const, history: { providerId: 'generic', executorId: 'generic', workspacePath: fixturePath(hostId), createdAt: _newTailFixtureEpoch(0, 0, 1), nativeHandle: { kind: 'provider' as const, providerId: 'generic', sessionId: native } } })
 const a = source('host-a', 'NativeA'), b = source('host-b', 'NativeB')
 const input = { rows, lanes: [], catalog, history: [], retained: [], sources: [a, b] }
 expect(searchFocus('NativeA', input).sources).toEqual([a])
 expect(searchFocus('amux://agent/SharedSID', input).sources).toEqual([a, b])
 expect(searchFocus('NativeA', { ...input, rows: [{ ...rows[0]!, id: 'SharedSID', hostId: 'host-a', nativeSessionId: 'NativeA' }] }).sources).toEqual([])
 expect(searchFocus('NativeB', { ...input, rows: [{ ...rows[0]!, id: 'SharedSID', hostId: 'host-a', nativeSessionId: 'NativeA' }] }).sources).toEqual([b])
})

it('does not infer Zone membership from a shared resource Workspace', () => {
 const state = useAppStore.getState(), rows = createFocusProjectionSelector()(state).contexts, catalog = workbenchSelectionCatalog(state)
 const first = catalog.zones[0]!, space = catalog.spaces.find(space => space.spaceId === catalog.bindings.find(binding => binding.zoneId === first.zoneId)?.spaceId)!
 const other = { ...first, zoneId: 'OtherZone' }
 const result = searchFocus('amux://zone/OtherZone', { rows, lanes: [], catalog: { ...catalog, zones: [...catalog.zones, other], bindings: [...catalog.bindings, { zoneId: other.zoneId, spaceId: space.spaceId }] }, sources: [], history: [], retained: [] })
 expect([...result.contextKeys]).toEqual([]); expect(result.locations).toEqual([]); expect(result.unplaced).toMatchObject([{ id: 'OtherZone' }])
})
