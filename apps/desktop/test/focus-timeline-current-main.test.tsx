const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { act, createElement, useEffect } from 'react'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { expect, it, vi } from 'vitest'
import { appendFileSync } from 'node:fs'
import { createWorkspaceLayout, splitWorkbenchRegion, type WorkspaceLayout } from '@agentmux/layout'
vi.mock('react-resizable-panels', () => createRequire(import.meta.url)(
  '../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
const leaves = vi.hoisted(() => ({ mounts: [] as string[], unmounts: [] as string[] }))
// Keep the actual App/Global/Workbench/Provider tree; replace SessionPane with a local instance/draft/Range probe. This is not ReaderBody or Native PTY evidence.
vi.mock('../src/renderer/src/components/SessionPane', () => ({
  SessionPane: ({ sessionId, linkOrigin }: { sessionId: string; linkOrigin: { tabId: string; regionId: string } }) => {
    const key = `${linkOrigin.tabId}/${linkOrigin.regionId}`
    useEffect(() => { leaves.mounts.push(key); return () => { leaves.unmounts.push(key) } }, [key])
    const draft = useAppStore(state => state.agentComposerDrafts[sessionId] ?? '')
    return createElement('section', { 'data-selection-session': sessionId, 'data-selection-leaf': key },
      createElement('p', {}, 'Original readable content stays here'),
      createElement('textarea', { 'aria-label': `Original draft ${key}`, value: draft, readOnly: true }))
  }
}))
// The Launcher's real warm-shell owner also reaches a PTY painting leaf.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => createElement('div', { 'data-warm-pty-paint-isolated': '' }) }))
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { installNativePopover } from './fixtures/mote-workface'
const initial = useAppStore.getState()
const initialLauncher = useLauncherState.getState()
async function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); window.localStorage.clear()
  useLauncherState.setState({ persistenceIssue: null, sections: {}, drafts: {}, executors: {} })
  leaves.mounts = []; leaves.unmounts = []
  const restorePopover = installNativePopover(), config = await api.config.get(), snapshot = await api.sessions.snapshot()
  const resource = { ...config.workspaces.find(item => item.id === 'workspace-demo')!, path: _hygiene_fixturePath("private/resource-a") }
  const display = { ...resource, id: 'display-b', name: 'Display B', path: _hygiene_fixturePath("private/display-b") }
  const session = { ...snapshot.sessions.find(item => item.id === 'session-codex')!, workspacePath: resource.path }
  const other = { ...snapshot.sessions.find(item => item.id === 'session-claude')!, workspacePath: resource.path }
  expect(session.kind).toBe('agent'); expect(other.kind).toBe('agent')
  const decoy = createWorkbenchTab('decoy-first-tab', { regionId: 'decoy-region', workspaceId: resource.id,
    kind: 'agent', phase: 'attached', sessionId: session.id }, 'Decoy first')
  const exact = createWorkbenchTab('explicit-exact-tab', { regionId: 'exact-r1', workspaceId: resource.id,
    kind: 'file', path: 'selection.txt' }, 'Original mixed Tab')
  exact.regions['exact-r2'] = { regionId: 'exact-r2', workspaceId: resource.id,
    kind: 'agent', phase: 'attached', sessionId: session.id }
  exact.layout = splitWorkbenchRegion(exact.layout, 'exact-r1', 'right', 'exact-r2')
  const first = createWorkspaceLayout('display-first-group', [exact.id])
  const displayLayout: WorkspaceLayout = { ...first, root: { type: 'split', direction: 'horizontal', ratio: .5,
    first: first.root, second: { type: 'leaf', groupId: 'display-exact-group' } },
    groups: [...first.groups, { ...first.groups[0]!, id: 'display-exact-group' }], activeGroupId: first.activeGroupId }
  useAppStore.setState({ ...initial, initialize: async () => () => {}, loading: false,
    config: { ...config, workspaces: [resource, display] }, sessions: [session, other],
    tabs: { [decoy.id]: decoy, [exact.id]: exact },
    layouts: { [resource.id]: createWorkspaceLayout('resource-home-group', [decoy.id, exact.id]), [display.id]: displayLayout },
    mainSurface: 'workbench', activeWorkspaceId: resource.id, toolsOpen: false, projectRailOpen: false,
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } },
    agentComposerDrafts: { [session.id]: 'Original unsent draft' } }, true)
  const seeded = useAppStore.getState()
  const unrelated = Array.from({length: 6}, (_, index) => createWorkbenchTab(`launcher:unrelated-${index}`, {kind: 'launcher', workspaceId: resource.id, regionId: `unrelated-r-${index}`}))
  useAppStore.setState({tabs: {...seeded.tabs, ...Object.fromEntries(unrelated.map(tab => [tab.id, tab]))}, layouts: {...seeded.layouts, [resource.id]: createWorkspaceLayout('resource-home-group', [decoy.id, exact.id, ...unrelated.map(tab => tab.id)])}})
  const reference = { displayWorkspaceId: display.id, groupId: 'display-exact-group', tabId: exact.id, regionId: 'exact-r2' }
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(async () => root.render(createElement(App)))
  expect(container.querySelector('main.main-shell')).not.toBeNull()
  await act(async () => {
    useAppStore.getState().focusRegion(reference.displayWorkspaceId, reference.tabId, reference.regionId, 'pointer', reference.groupId)
    useAppStore.getState().setMainSurface('agents')
  })
  expect(container.querySelector('.focused-tab-workspace')?.getAttribute('data-focus-tab-id')).toBe(exact.id)
  const file = { ...reference, regionId: 'exact-r1' }
  return { container, root, reference, file, resource, display, session, other, exact,
    async chooseFile() {
      const node = container.querySelector<HTMLElement>('.focused-tab-workspace [data-workbench-region-id="exact-r1"]')
      expect(node).not.toBeNull()
      await act(async () => node!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })))
    },
    async close() { await act(async () => root.unmount()); container.remove(); restorePopover()
      useAppStore.setState(initial, true); useLauncherState.setState(initialLauncher, true); window.localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() }
  }
}

const timelineFacts = (f: Awaited<ReturnType<typeof fixture>>, name: string) => {
 const s=useAppStore.getState(), choice=s.workbenchSpaceSelection
 const current=choice?.tabId && choice.regionId ? s.tabs[choice.tabId]?.regions[choice.regionId] : null
 const marked=[...f.container.querySelectorAll<HTMLElement>('[data-focus-timeline-id][data-focus-current="true"]')].map(n=>n.dataset.focusTimelineId)
 if(process.env.AGENTMUX_CURRENT_FACTS) appendFileSync(process.env.AGENTMUX_CURRENT_FACTS,JSON.stringify({name,mainChoice:choice,currentKind:current?.kind,executionMRU:s.agentFocus.execution.sessionId,marked})+'\n')
 return {current,marked}
}
it('exact presented Agent has a current Timeline track before switching to its File sibling',async()=>{
 const f=await fixture(); try {
  const facts=timelineFacts(f,'agent-control')
  expect(facts.current?.kind).toBe('agent')
  expect(facts.marked).toEqual([f.session.id])
 } finally { await f.close() }
})
it('the exact File sibling must not borrow the execution MRU as Timeline current Context',async()=>{
 const f=await fixture(); try {
  await f.chooseFile();const facts=timelineFacts(f,'file-sibling-counter')
  expect(facts.current?.kind).toBe('file')
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(f.session.id)
  expect(facts.marked,'File has no Agent Session; execution MRU cannot stand in for the exact displayed Region').toEqual([])
 } finally { await f.close() }
})

it('closing only the Focus presentation keeps the exact main choice and its Current track',async()=>{
 const f=await fixture();try{
  const choice=useAppStore.getState().workbenchSpaceSelection,execution=useAppStore.getState().agentFocus.execution
  const close=f.container.querySelector<HTMLButtonElement>('[aria-label="Close Focus workspace"]')!;expect(close).not.toBeNull()
  await act(async()=>close.click())
  expect(f.container.querySelector('.focused-tab-workspace')).toBeNull()
  expect(useAppStore.getState().workbenchSpaceSelection).toEqual(choice)
  expect(useAppStore.getState().agentFocus.execution).toEqual(execution)
  expect(timelineFacts(f,'closed-projection').marked).toEqual([f.session.id])
 }finally{await f.close()}
})

for(const kind of ['browser','parent','unknown'] as const) it(`keeps ${kind} main selection from borrowing the execution MRU`,async()=>{
 const f=await fixture();try{
  const browser=kind==='browser'?await api.browser.create('current-browser','https://example.test',f.resource.id):null
  await act(async()=>{
   const state=useAppStore.getState(),choice=state.workbenchSpaceSelection!
   if(kind==='browser')useAppStore.setState({tabs:{...state.tabs,[f.exact.id]:{...state.tabs[f.exact.id]!,regions:{...state.tabs[f.exact.id]!.regions,'exact-r1':{...browser!,regionId:'exact-r1',workspaceId:f.resource.id,kind:'browser',browserId:browser!.id}}}}})
   useAppStore.setState({workbenchSpaceSelection:kind==='browser'?{...choice,regionId:'exact-r1'}:kind==='parent'?{...choice,tabId:null,regionId:null}:{...choice,groupId:'unconfirmed-original-location'}})
  })
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(f.session.id)
  expect(timelineFacts(f,kind).marked).toEqual([])
  expect(f.container.querySelector<HTMLButtonElement>('[aria-label="Locate current Context track"]')!.disabled).toBe(true)
 }finally{await f.close()}
})
