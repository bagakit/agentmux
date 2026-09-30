// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout, findGroup, moveTabToNewGroup } from '@agentmux/layout'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
})
// Only native terminal/editor leaves are replaced. App, Store, Stable Portal and Launcher run.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-terminal-boundary /> }))
vi.mock('../src/renderer/src/components/EditorPane', () => ({ EditorPane: () => <div data-note-editor-boundary /> }))
const observed = vi.hoisted(() => ({ projections: [] as (import('../src/renderer/src/lib/workbench-projection').WorkbenchProjection | undefined)[] }))
vi.mock('../src/renderer/src/components/LauncherSecondarySurfaces', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/renderer/src/components/LauncherSecondarySurfaces')>()
  const { useWorkbenchBrowserPresentation } = await import('../src/renderer/src/lib/workbench-presentation')
  return { LauncherSecondarySurfaces: (props: Parameters<typeof actual.LauncherSecondarySurfaces>[0]) => {
    observed.projections.push(useWorkbenchBrowserPresentation().projection)
    return <actual.LauncherSecondarySurfaces {...props} />
  } }
})
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab, fileTabId } from '../src/renderer/src/lib/workbench-tabs'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
const dom = composerDOM(), session = composerSession()
const first = createWorkbenchTab('first', { kind: 'launcher', regionId: 'first-region', workspaceId: 'workspace' })
const second = createWorkbenchTab('second', { kind: 'launcher', regionId: 'second-region', workspaceId: 'workspace' })
let content = '', path = ''
beforeEach(() => {
  observed.projections = []; content = ''; path = ''; useLauncherState.setState({ sections: { workspace: { note: 'expanded', agents: 'collapsed', terminal: 'collapsed' } }, drafts: { 'region:first-region': { browser: '', note: 'Captured thought' } } })
  useAppStore.setState({ loading: false, initialize: vi.fn(async () => () => {}), config: composerConfig, activeWorkspaceId: 'workspace', mainSurface: 'workbench',
    sessions: [session], tabs: { first, second }, layouts: { workspace: createWorkspaceLayout('g', ['first', 'second']) }, documents: {},
    surveyZoneSelection: null, spaceZoneBindings: {}, spatialRequests: {}, scratchTopicSnapshots: {}, surveyToolsOpen: false,
    error: null, lastError: null, prewarmTerminal: vi.fn(async () => {}), retainedSpatialFocus: null, regionCaretFocus: null,
    agentFocus: { execution: { sessionId: session.id, history: [{ sessionId: session.id, focusedAt: 1 }] }, pmo: { sessionId: null } },
    demands: {}, projectRailOpen: true, toolsOpen: true, workspaceTool: 'agents' })
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined); vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'write').mockImplementation(async (_workspace, input) => { content = input.content; path = input.path; return { status: 'written', revision: 'new' } })
  vi.spyOn(api.files, 'read').mockImplementation(async () => ({ status: 'read', document: { path, content, revision: 'new' } }))
})
afterEach(async () => { await act(async () => useLauncherState.setState({ drafts: {}, sections: {} })) })
async function mountSurvey(multipleGroups = false) {
  if (multipleGroups) useAppStore.setState({ layouts: { workspace: moveTabToNewGroup(useAppStore.getState().layouts.workspace!, second.id, 'g', 'g', 'right', 'second-group') } })
  await dom.render(<App />); await dom.click('[aria-label="Survey: browse and manage pages"]')
  const zoneId = spatialCatalog(useAppStore.getState(), []).tabs.find(tab => tab.tabId === first.id)!.zoneId!
  const row = [...dom.container.querySelectorAll<HTMLElement>('[data-survey-zone-id]')].find(row => row.dataset.surveyZoneId === zoneId)
  expect(row).toBeDefined(); await act(async () => row!.querySelector<HTMLButtonElement>('.survey-item')!.click())
  await dom.click('.global-survey-surface button.workbench-tab[data-workbench-tab-id="first"]')
  expect(useAppStore.getState().surveyZoneSelection?.active?.tabId).toBe(first.id)
  await act(async () => useAppStore.setState({ retainedSpatialFocus: { spaceId: null, zoneId, workspaceId: 'workspace', displayWorkspaceId: 'workspace', groupId: 'g', tabId: first.id, regionId: 'first-region' }, regionCaretFocus: { regionId: 'first-region', nonce: 7 }, workbenchNavigationInputPolicy: 'preserve' }))
  expect(dom.container.querySelector('.global-survey-surface [data-workbench-tab-id="first"] [aria-label="Note draft"]')).not.toBeNull()
  const scopes = observed.projections.filter(projection => projection?.presentationId === 'survey-workbench')
  expect(scopes.length).toBeGreaterThan(0); expect(scopes[scopes.length - 1]?.entity).toEqual({ kind: 'zone', zoneId })
  return snapshot()
}
function snapshot() {
  const state = useAppStore.getState(), layout = state.layouts.workspace!, group = findGroup(layout, 'g')!
  return { activeGroupId: layout.activeGroupId, activeTabId: group.activeTabId, recentTabIds: group.recentTabIds, lastActiveFileByWorkspace: state.lastActiveFileByWorkspace,
    retainedSpatialFocus: state.retainedSpatialFocus, regionCaretFocus: state.regionCaretFocus, workbenchNavigationInputPolicy: state.workbenchNavigationInputPolicy, agentFocus: state.agentFocus, sessions: state.sessions }
}
const receipt = () => useLauncherState.getState().drafts['region:first-region']?.noteCreation
const save = () => dom.click('.global-survey-surface [data-workbench-tab-id="first"] .launcher-note-actions button')
const switchTab = () => dom.click('.global-survey-surface button.workbench-tab[data-workbench-tab-id="second"]')
it('passes the actual projection through the original Stable Portal and selects only Survey', async () => {
  const before = await mountSurvey(); await save()
  expect(receipt()).toMatchObject({ status: 'written', revealed: true, draft: 'Captured thought', presentation: { presentationId: 'survey-workbench' }, target: { workspacePath: '/repo', displayWorkspaceId: 'workspace', groupId: 'g' } })
  expect(useAppStore.getState().surveyZoneSelection?.active?.tabId).toBe(fileTabId('workspace', path))
  expect(snapshot()).toEqual(before); expect(useAppStore.getState().tabs.second).toBe(second)
})
it.each([false, true])('keeps a same-Zone later Tab/Group selection while creation waits (multipleGroups=%s)', async multipleGroups => {
  const before = await mountSurvey(multipleGroups); let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve })
  vi.mocked(api.files.write).mockImplementation(async (_workspace, input) => { content = input.content; path = input.path; await waiting; return { status: 'written', revision: 'new' } })
  await save(); expect(receipt()?.status).toBe('pending'); await switchTab()
  await act(async () => { release(); await waiting })
  expect(receipt()).toMatchObject({ status: 'written', revealed: false, draft: 'Captured thought' }); expect(api.files.read).not.toHaveBeenCalled()
  expect(useAppStore.getState().surveyZoneSelection?.active?.tabId).toBe(second.id)
  expect(useLauncherState.getState().drafts['region:first-region']?.note).toBe('Captured thought'); expect(snapshot()).toEqual(before)
})
it('keeps the later Tab selection when the original openFile read arrives late', async () => {
  const before = await mountSurvey(); let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve })
  vi.mocked(api.files.read).mockImplementation(async () => { await waiting; return { status: 'read', document: { path, content, revision: 'new' } } })
  await save(); expect(api.files.read).toHaveBeenCalledTimes(1); await switchTab()
  await act(async () => { release(); await waiting })
  expect(receipt()).toMatchObject({ status: 'written', revealed: false }); expect(useAppStore.getState().surveyZoneSelection?.active?.tabId).toBe(second.id)
  expect(snapshot()).toEqual(before); expect(api.files.write).toHaveBeenCalledTimes(1)
})

it('offers an explicit same-intent retry after a known creation failure', async () => {
  await mountSurvey(); vi.mocked(api.files.write).mockResolvedValue({ status: 'error', code: 'EACCES', message: 'permission denied' })
  await save(); const failed = receipt()!; expect(failed.status).toBe('error'); expect(api.files.write).toHaveBeenCalledTimes(1)
  vi.mocked(api.files.write).mockImplementation(async (_workspace, input) => { content = input.content; path = input.path; return { status: 'written', revision: 'restored' } })
  const button = [...dom.container.querySelectorAll<HTMLButtonElement>('.global-survey-surface button')].find(button => button.textContent === 'Retry same Note')
  expect(button).toBeDefined(); await act(async () => button!.click())
  expect(receipt()).toMatchObject({ intentId: failed.intentId, noteId: failed.noteId, blockIds: failed.blockIds, path: failed.path, status: 'written', revealed: true })
  expect(api.files.write).toHaveBeenCalledTimes(2); expect(useLauncherState.getState().drafts['region:first-region']?.note).toBe('')
})
