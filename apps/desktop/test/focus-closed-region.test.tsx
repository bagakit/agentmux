const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'
import { seedMoteWorkface, defaultAgent, executionAgent, moteTopics } from './fixtures/mote-workface'
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
import { addWorkbenchRegion, createWorkbenchTab, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { createHash } from 'node:crypto'
import { desktopSpatialGraph, desktopWorkbenchFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { useAppStore, prepareRendererUpdate } from '../src/renderer/src/store'
import { mainFocusPresentation } from '../src/renderer/src/lib/focus-tab-projection'
import { desktopSpaceSelectionAfterClose } from '../src/renderer/src/lib/desktop-focus-navigation'
import * as spatialControl from '../src/renderer/src/lib/space-agent-control'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { requestPmoTeamsTopicFloatingClose } from '../src/renderer/src/lib/pmo-teams-topic-floating'
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

const record = (f: Awaited<ReturnType<typeof fixture>>, name: string, before: ReturnType<typeof useAppStore.getState>, extra = {}) => {
 const state=useAppStore.getState(), choice=state.workbenchSpaceSelection
 const region=choice?.tabId && choice?.regionId ? state.tabs[choice.tabId]?.regions[choice.regionId] : null
 const recovery=f.container.querySelector('.focus-location-recovery')
 appendFileSync(process.env.AGENTMUX_CLOSED_REGION_FACTS!,JSON.stringify({name,choiceBefore:before.workbenchSpaceSelection,choiceAfter:choice,mainRegionPresent:Boolean(region),tabActive:state.tabs[f.exact.id]?.layout.activeRegionId,
  projection:f.container.querySelector('.focused-tab-workspace')?.getAttribute('data-focus-tab-id')??null,
  recoveryText:recovery?.textContent??null,choiceLabels:[...f.container.querySelectorAll('.focus-location-choice')].map(node=>node.textContent),
  executionPreserved:state.agentFocus.execution===before.agentFocus.execution,draftsPreserved:state.agentComposerDrafts===before.agentComposerDrafts,...extra})+'\n')
}
it('foreign current File close: original remaining Region keeps exact display Group, without known-close recovery directory',async()=>{
 const f=await fixture();try{
  await f.chooseFile();const before=useAppStore.getState();
  await act(async()=>before.closeRegion(f.resource.id,f.exact.id,f.file.regionId));record(f,'foreign-current-file',before)
  const state=useAppStore.getState();expect(state.tabs[f.exact.id]?.regions[f.file.regionId]).toBeUndefined()
  expect(state.agentFocus.execution).toBe(before.agentFocus.execution)
  expect(state.workbenchSpaceSelection).toMatchObject({workspaceId:f.display.id,groupId:f.file.groupId,tabId:f.exact.id,regionId:f.reference.regionId})
  expect(f.container.querySelector('.focus-location-recovery')).toBeNull()
 }finally{await f.close()}
})
it('same-workspace current Region close: keep original Tab/Group even when another Group is globally active',async()=>{
 const f=await fixture();try{
  await act(async()=>useAppStore.getState().selectMainRegion({...f.file,displayWorkspaceId:f.resource.id,groupId:'resource-home-group'},useAppStore.getState().workbenchSpaceSelection))
  // Retained/display Groups do not become global layout active merely by Focus projection.
  const s=useAppStore.getState();const old=s.layouts[f.resource.id]!;
  useAppStore.setState({layouts:{...s.layouts,[f.resource.id]:{...old,activeGroupId:'unrelated-global-group',root:{type:'split',direction:'horizontal',ratio:.5,first:old.root,second:{type:'leaf',groupId:'unrelated-global-group'}},groups:[...old.groups,{...old.groups[0]!,id:'unrelated-global-group',tabOrder:['decoy-first-tab'],activeTabId:'decoy-first-tab'}]}}})
  const before=useAppStore.getState();await act(async()=>before.closeRegion(f.resource.id,f.exact.id,f.file.regionId));record(f,'same-resource-original-group',before)
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({workspaceId:f.resource.id,groupId:'resource-home-group',tabId:f.exact.id,regionId:f.reference.regionId})
  expect(f.container.querySelector('.focus-location-recovery')).toBeNull()
 }finally{await f.close()}
})
it('closing noncurrent Region preserves the exact main Agent and mounted projection',async()=>{
 const f=await fixture();try{
  const before=useAppStore.getState();await act(async()=>before.closeRegion(f.resource.id,f.exact.id,f.file.regionId));record(f,'noncurrent-file',before)
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
  expect(f.container.querySelector('.focused-tab-workspace')).not.toBeNull();expect(f.container.querySelector('.focus-location-recovery')).toBeNull()
 }finally{await f.close()}
})
it('only Launcher Tab close is a known empty parent, not an unconfirmed Region',async()=>{
 const f=await fixture();try{
  const only=createWorkbenchTab('launcher:only-original',{kind:'launcher',workspaceId:f.resource.id,regionId:'only-original-region'})
  await act(async()=>{
   useAppStore.setState({tabs:{[only.id]:only},layouts:{[f.resource.id]:createWorkspaceLayout('only-original-group',[only.id])},workbenchSpaceSelection:null})
   useAppStore.getState().selectMainRegion({displayWorkspaceId:f.resource.id,groupId:'only-original-group',tabId:only.id,regionId:'only-original-region'},null)
  })
  const before=useAppStore.getState();await act(async()=>{await before.closeTab(f.resource.id,'only-original-group',only.id)})
  record(f,'only-launcher-tab',before,{onlyTabPresent:Boolean(useAppStore.getState().tabs[only.id])})
  expect(useAppStore.getState().tabs[only.id]).toBeUndefined()
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({tabId:null,groupId:null,regionId:null})
  expect(f.container.querySelector('.focus-location-recovery'),'confirmed empty parent must not claim unavailable Region').toBeNull()
 }finally{await f.close()}
})
it('one-Region lower owner remains a no-op; it is not proof of the sole-Tab UI close route',async()=>{
 const f=await fixture();try{
  const before=useAppStore.getState(),single=before.tabs['decoy-first-tab']!
  await act(async()=>before.closeRegion(f.resource.id,single.id,'decoy-region'));record(f,'sole-region-lower-noop',before)
  expect(useAppStore.getState().tabs[single.id]).toBe(single);expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
 }finally{await f.close()}
})
it('closing a noncurrent Launcher Tab retains the original main reference and MRU',async()=>{
 const f=await fixture();try{
  await f.chooseFile();const before=useAppStore.getState();await act(async()=>{await before.closeTab(f.resource.id,'resource-home-group','launcher:unrelated-0')});record(f,'noncurrent-launcher-tab',before)
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection);expect(useAppStore.getState().agentFocus.execution).toBe(before.agentFocus.execution)
  expect(f.container.querySelector('.focus-location-recovery')).toBeNull()
 }finally{await f.close()}
})
it('sidecar local active sibling close preserves surviving main File and original MRU',async()=>{
 const f=await fixture();try{
  await f.chooseFile();await act(async()=>useAppStore.getState().focusRegion(f.display.id,f.exact.id,f.reference.regionId,'floating-pointer',f.reference.groupId));
  const before=useAppStore.getState();await act(async()=>before.closeRegion(f.resource.id,f.exact.id,f.reference.regionId));record(f,'sidecar-local-nonmain-agent',before)
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection);expect(useAppStore.getState().agentFocus.execution).toBe(before.agentFocus.execution)
  expect(f.container.querySelector('.focus-location-recovery')).toBeNull();expect(f.container.querySelector('.focus-toolbar__identity')?.textContent).toContain('File')
 }finally{await f.close()}
})

it('actual original sole File Tab close button commits a normal parent and preserves other Group members',async()=>{
 const f=await fixture();try{
  const only=createWorkbenchTab('sole-file-tab',{kind:'file',workspaceId:f.resource.id,regionId:'sole-file-region',path:'selection.txt'},'Only File')
  const peer=createWorkbenchTab('launcher:remaining-peer',{kind:'launcher',workspaceId:f.resource.id,regionId:'peer-region'})
  const layout=createWorkspaceLayout('sole-file-group',[only.id]);const peerGroup={...layout.groups[0]!,id:'remaining-group',tabOrder:[peer.id],activeTabId:peer.id}
  await act(async()=>{
   useAppStore.setState({tabs:{[only.id]:only,[peer.id]:peer},layouts:{[f.resource.id]:{...layout,root:{type:'split',direction:'horizontal',ratio:.5,first:layout.root,second:{type:'leaf',groupId:peerGroup.id}},groups:[...layout.groups,peerGroup]}},workbenchSpaceSelection:null})
   useAppStore.getState().selectMainRegion({displayWorkspaceId:f.resource.id,groupId:layout.groups[0]!.id,tabId:only.id,regionId:'sole-file-region'},null)
   useAppStore.getState().setMainSurface('workbench')
  })
  const button=f.container.querySelector<HTMLElement>('[data-tab-id="sole-file-tab"] .workbench-tab__close') ?? [...f.container.querySelectorAll<HTMLElement>('.workbench-tab__close')].find(node=>node.getAttribute('aria-label')==='Close Only File')
  expect(button,'real original Tab close control').not.toBeUndefined();expect(button).not.toBeNull()
  const before=useAppStore.getState();await act(async()=>button!.click());await act(async()=>useAppStore.getState().setMainSurface('agents'))
  record(f,'sole-file-ui-parent-members',before)
  expect(useAppStore.getState().tabs[only.id]).toBeUndefined();expect(useAppStore.getState().tabs[peer.id]).toBe(peer)
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({tabId:null,groupId:null,regionId:null})
  expect(f.container.querySelector('.focus-location-recovery')).toBeNull()
  expect(f.container.querySelector('.focused-tab-workspace [data-workbench-empty-zone]')).toBeNull()
  expect(f.container.querySelector('.focused-tab-workspace')?.textContent).toContain('Choose a Tab')
  expect(f.container.querySelector('.focused-tab-workspace')?.textContent).toContain('New Tab')
  expect(useAppStore.getState().agentFocus.execution).toBe(before.agentFocus.execution)
 }finally{await f.close()}
})
it('surviving sibling probe node, nonempty draft and Range stay while the closed File instance is released',async()=>{
 const f=await fixture();try{
  const node=f.container.querySelector<HTMLElement>('.focused-tab-workspace [data-selection-leaf="explicit-exact-tab/exact-r2"]')!;
  expect(node).not.toBeNull();const draft=node.querySelector('textarea')!;expect(draft.value).toBe('Original unsent draft')
  const text=node.querySelector('p')!.firstChild!,range=document.createRange();range.setStart(text,0);range.setEnd(text,8);const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range)
  const before=useAppStore.getState();await act(async()=>before.closeRegion(f.resource.id,f.exact.id,f.file.regionId));
  expect(node.isConnected).toBe(true);expect(f.container.querySelector('.focused-tab-workspace [data-selection-leaf="explicit-exact-tab/exact-r2"]')).toBe(node)
  expect(node.querySelector('textarea')).toBe(draft);expect(draft.value).toBe('Original unsent draft');expect(selection.getRangeAt(0)).toBe(range);expect(selection.toString()).toBe('Original')
  expect(f.container.querySelector('.focused-tab-workspace [data-workbench-region-id="exact-r1"]')).toBeNull()
 }finally{await f.close()}
})
it('real Browser close failure keeps original Region and later explicit main choice',async()=>{
 const f=await fixture();try{
  const snapshot=await api.browser.create('close-browser','https://example.test',f.resource.id)
  const s=useAppStore.getState(),tab=s.tabs[f.exact.id]!;await act(async()=>useAppStore.setState({tabs:{...s.tabs,[tab.id]:{...tab,regions:{...tab.regions,'exact-r1':{...snapshot,kind:'browser',workspaceId:f.resource.id,regionId:'exact-r1',browserId:snapshot.id}}}}}))
  await act(async()=>useAppStore.getState().selectMainRegion(f.file,useAppStore.getState().workbenchSpaceSelection))
  let reject!:(error:Error)=>void;const pending=new Promise<void>((_,fail)=>{reject=fail});vi.spyOn(api.browser,'close').mockReturnValueOnce(pending)
  const before=useAppStore.getState();let closing!:Promise<void>;await act(async()=>{closing=before.closeRegion(f.resource.id,f.exact.id,'exact-r1')})
  await act(async()=>useAppStore.getState().selectMainRegion(f.reference,useAppStore.getState().workbenchSpaceSelection));const later=useAppStore.getState().workbenchSpaceSelection
  await act(async()=>{reject(new Error('Private Browser close unavailable'));await closing});record(f,'browser-close-failed-later-choice',before)
  expect(useAppStore.getState().tabs[tab.id]!.regions['exact-r1']).toBeDefined();expect(useAppStore.getState().workbenchSpaceSelection).toBe(later)
  expect(useAppStore.getState().agentFocus.execution).toBe(before.agentFocus.execution);expect(f.container.querySelector('.focus-location-recovery')).toBeNull()
 }finally{await f.close()}
})
it('late successful Browser close cannot replace a later selected remaining Region',async()=>{
 const f=await fixture();try{
  const snapshot=await api.browser.create('late-close-browser','https://example.test',f.resource.id)
  const s=useAppStore.getState(),tab=s.tabs[f.exact.id]!;await act(async()=>useAppStore.setState({tabs:{...s.tabs,[tab.id]:{...tab,regions:{...tab.regions,'exact-r1':{...snapshot,kind:'browser',workspaceId:f.resource.id,regionId:'exact-r1',browserId:snapshot.id}}}}}))
  await act(async()=>useAppStore.getState().selectMainRegion(f.file,useAppStore.getState().workbenchSpaceSelection))
  let resolve!:()=>void;const pending=new Promise<void>(done=>{resolve=done});vi.spyOn(api.browser,'close').mockReturnValueOnce(pending)
  const before=useAppStore.getState();let closing!:Promise<void>;await act(async()=>{closing=before.closeRegion(f.resource.id,f.exact.id,'exact-r1')})
  await act(async()=>useAppStore.getState().selectMainRegion(f.reference,useAppStore.getState().workbenchSpaceSelection));const later=useAppStore.getState().workbenchSpaceSelection
  await act(async()=>{resolve();await closing});record(f,'browser-close-success-later-choice',before)
  expect(useAppStore.getState().tabs[tab.id]!.regions['exact-r1']).toBeUndefined();expect(useAppStore.getState().workbenchSpaceSelection).toBe(later)
  expect(f.container.querySelector('.focused-tab-workspace')?.getAttribute('data-focus-tab-id')).toBe(tab.id)
 }finally{await f.close()}
})
it('unknown exact occurrence offers only the same original unnamed Launcher and human display names',async()=>{
 const f=await fixture();try{
  const s=useAppStore.getState(),tab=s.tabs['launcher:unrelated-0']!,reference={displayWorkspaceId:f.resource.id,groupId:'resource-home-group',tabId:tab.id,regionId:'unrelated-r-0'}
  await act(async()=>useAppStore.getState().selectMainRegion(reference,s.workbenchSpaceSelection))
  const selected=useAppStore.getState().workbenchSpaceSelection!;
  await act(async()=>useAppStore.setState({workbenchSpaceSelection:{...selected,groupId:'not-yet-confirmed-original-group'}}))
  const choices=[...f.container.querySelectorAll<HTMLButtonElement>('.focus-location-choice')];expect(choices).toHaveLength(1)
  expect(choices[0]!.textContent).toContain('New Tab');expect(choices[0]!.textContent).not.toContain('launcher:');expect(choices[0]!.title).toContain(tab.id)
  expect(f.container.querySelector('.focus-location-recovery')).not.toBeNull();expect(useAppStore.getState().workbenchSpaceSelection?.groupId).toBe('not-yet-confirmed-original-group')
  expect(mainFocusPresentation(selected,useAppStore.getState().tabs,null,()=>{})).toMatchObject({projection:null,references:[],issue:expect.any(String)})
 }finally{await f.close()}
})
it('closing another display placement of the same Tab preserves the exact surviving main binding',async()=>{
 const f=await fixture();try{
  const before=useAppStore.getState();await act(async()=>{await before.closeTab(f.display.id,'display-first-group',f.exact.id)});record(f,'same-tab-other-placement',before)
  expect(useAppStore.getState().tabs[f.exact.id]).toBeDefined();expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
  expect(f.container.querySelector('.focus-location-recovery')).toBeNull()
 }finally{await f.close()}
})
it('confirmed unbound Zone parent uses the original entity even with null Space and no relationship',async()=>{
 const f=await fixture();try{
  const state=useAppStore.getState(),catalog=spatialCatalog(state,[]),choice={...state.workbenchSpaceSelection!,spaceId:null,tabId:null,groupId:null,regionId:null}
  const unbound={...catalog,bindings:catalog.bindings.filter(binding=>binding.zoneId!==choice.zoneId),locations:catalog.locations.map(location=>location.zoneId===choice.zoneId?{...location,spaceId:null}:location)}
  const p=mainFocusPresentation(choice,state.tabs,unbound,()=>{})
  expect(unbound.zones.some(zone=>zone.zoneId===choice.zoneId&&!zone.issue)).toBe(true)
  expect(p).toMatchObject({issue:null,references:[],projection:{entity:{kind:'zone',zoneId:choice.zoneId},selectionMode:'occurrence',selection:[]}})
 }finally{await f.close()}
})
it('neutral exact Tab with null Zone and Space still follows its actual surviving Region',async()=>{
 const f=await fixture();try{
  await f.chooseFile();const before=useAppStore.getState(),choice={...before.workbenchSpaceSelection!,spaceId:null,zoneId:null}
  await act(async()=>before.closeRegion(f.resource.id,f.exact.id,f.file.regionId));const state=useAppStore.getState()
  const after=desktopSpaceSelectionAfterClose(choice,state,{workspaceId:f.resource.id,tabId:f.exact.id,regionId:f.file.regionId})
  expect(after).toMatchObject({spaceId:null,zoneId:null,tabId:f.exact.id,groupId:f.file.groupId,regionId:f.reference.regionId})
  const original=spatialCatalog(state,[]),catalog={...original,tabs:original.tabs.map(tab=>tab.tabId===f.exact.id?{...tab,zoneId:null}:tab),locations:original.locations.map(location=>location.tabId===f.exact.id?{...location,zoneId:null,spaceId:null}:location)}
  expect(mainFocusPresentation(after,state.tabs,catalog,()=>{}).issue).toBeNull()
 }finally{await f.close()}
})

it('nested close preserves surviving original nodes and releases the explicitly removed Region only',async()=>{
 const f=await fixture();try{
  const current=useAppStore.getState(),tab=addWorkbenchRegion(current.tabs[f.exact.id]!,f.file.regionId,'down',{kind:'agent',phase:'attached',workspaceId:f.resource.id,regionId:'exact-r3',sessionId:f.other.id})
  await act(async()=>useAppStore.setState({tabs:{...current.tabs,[tab.id]:tab}}))
  const original=f.container.querySelector('.focused-tab-workspace [data-selection-leaf="explicit-exact-tab/exact-r2"]')!,third=f.container.querySelector('.focused-tab-workspace [data-selection-leaf="explicit-exact-tab/exact-r3"]')!;expect(original).not.toBeNull();expect(third).not.toBeNull()
  await f.chooseFile();await act(async()=>useAppStore.getState().closeRegion(f.resource.id,tab.id,f.file.regionId))
  expect(original.isConnected).toBe(true);expect(third.isConnected).toBe(true);expect(leaves.unmounts).not.toContain('explicit-exact-tab/exact-r2');expect(leaves.unmounts).not.toContain('explicit-exact-tab/exact-r3')
  await act(async()=>useAppStore.getState().closeRegion(f.resource.id,tab.id,'exact-r3'))
  expect(original.isConnected).toBe(true);expect(third.isConnected).toBe(false);expect(leaves.unmounts.filter(key=>key==='explicit-exact-tab/exact-r3')).toHaveLength(1)
  expect(useAppStore.getState().tabs[tab.id]?.regions['exact-r3']).toBeUndefined();expect(useAppStore.getState().workbenchSpaceSelection?.regionId).toBe(f.reference.regionId)
 }finally{await f.close()}
})
it('actual App retained known parent stays usable with a persistent nonblocking directory failure notice',async()=>{
 const f=await fixture();try{
  const only=createWorkbenchTab('launcher:directory-parent',{kind:'launcher',workspaceId:f.resource.id,regionId:'directory-parent-region'})
  await act(async()=>{useAppStore.setState({tabs:{[only.id]:only},layouts:{[f.resource.id]:createWorkspaceLayout('directory-parent-group',[only.id])},workbenchSpaceSelection:null});useAppStore.getState().selectMainRegion({displayWorkspaceId:f.resource.id,groupId:'directory-parent-group',tabId:only.id,regionId:'directory-parent-region'},null)})
  await act(async()=>{await useAppStore.getState().closeTab(f.resource.id,'directory-parent-group',only.id)})
  const empty=f.container.querySelector('.focused-tab-workspace [data-workbench-empty-zone]')!;expect(empty).not.toBeNull();const originalChoice=useAppStore.getState().workbenchSpaceSelection
  const originalCatalog=spatialControl.spatialCatalog
  vi.spyOn(spatialControl,'spatialCatalog').mockImplementation((...args)=>{if(new Error().stack?.includes('/App.tsx'))throw new Error('Private directory observation failure');return originalCatalog(...args)})
  await act(async()=>useAppStore.setState({tabs:{...useAppStore.getState().tabs}}))
  expect(f.container.querySelector('.focused-tab-workspace')?.textContent).toContain('Private directory observation failure')
  expect(f.container.querySelector('.focused-tab-workspace [data-workbench-empty-zone]')).toBe(empty)
  expect(empty.querySelector('button[aria-label="New Tab"]')).not.toBeNull();expect(useAppStore.getState().workbenchSpaceSelection).toBe(originalChoice)
  await act(async()=>useAppStore.setState({sessions:[...useAppStore.getState().sessions]}))
  expect(f.container.querySelector('.focused-tab-workspace')?.textContent).toContain('Private directory observation failure')
  expect(f.container.querySelectorAll('.focus-location-choice')).toHaveLength(0)
 }finally{await f.close()}
})

it('original typed private Unix RPC and actual CLI read and navigate the exact post-close Region and parent',async()=>{
 const f=await fixture(),directory=await mkdtemp(_hygiene_fixturePath("tmp/amx-close-public-")),seen:string[]=[]
 const server=new AgentMuxControlServer({execute(request){seen.push(request.operation);return useAppStore.getState().executeControl(request)}},join(directory,'control.sock'))
 let rpc:Awaited<ReturnType<typeof connectAgentMuxRpc>>|undefined
 const cli=async(args:string[])=>{
  let result:{stdout:string;stderr:string},exitCode=0
  try{result=await promisify(execFile)(process.execPath,[process.env.AGENTMUX_CLOSED_REGION_CLI!,'--endpoint',`unix:${server.path}`,...args],{timeout:10000,env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENTMUX_')&&!key.startsWith('CTXMUX_'))),AGENTMUX_STATE_DIRECTORY:join(directory,'state'),AGENTMUX_RUNTIME_DIRECTORY:join(directory,'runtime')}})}
  catch(error){const failure=error as {code:number;stdout:string;stderr:string};appendFileSync(process.env.AGENTMUX_CLOSED_REGION_FACTS!,JSON.stringify({name:'cli-failure-envelope',args,code:failure.code,stdout:failure.stdout,stderr:failure.stderr})+'\n');expect(args.slice(0,2)).toEqual(['space','focus']);expect(failure.code).toBe(1);result=failure;exitCode=failure.code}
  expect(result.stderr).toBe('');const response=JSON.parse(result.stdout);expect(response.ok).toBe(true)
  if(exitCode===1)expect(response.result.partial).toBe(true)
  appendFileSync(process.env.AGENTMUX_CLOSED_REGION_FACTS!,JSON.stringify({name:'actual-cli',args,exitCode,receipt:response})+'\n')
  return response.result
 }
 try{
  useAppStore.setState({initialize:initial.initialize});await initializeSpatialControlFixture();useAppStore.setState({initialize:async()=>()=>{}})
  await server.start();rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}})
  await f.chooseFile();await act(async()=>useAppStore.getState().closeRegion(f.resource.id,f.exact.id,f.file.regionId))
  const after=useAppStore.getState().workbenchSpaceSelection
  const read=await rpc.call('app.inspect',{});expect((read.observation as {desktop:{selection:{space:unknown}}}).desktop.selection.space).toEqual(after)
  const inspected=await rpc.call('space.inspect',{target:{tabId:f.exact.id}});expect(inspected.catalog.regions.map(region=>region.regionId)).toEqual([f.reference.regionId])
  expect((await cli(['app','inspect'])).observation.desktop.selection.space).toEqual(after)
  expect((await cli(['space','inspect','--tab',f.exact.id])).catalog.regions.map((region:{regionId:string})=>region.regionId)).toEqual([f.reference.regionId])
  let navigated:any;await act(async()=>{navigated=await cli(['space','focus','--display-workspace',f.display.id,'--group',f.reference.groupId,'--tab',f.exact.id,'--region',f.reference.regionId,'--input','preserve'])})
  expect(navigated.navigation.selection.space).toEqual(after);expect(navigated.navigation.state).toMatch(/applied|unchanged/)
  const only=createWorkbenchTab('launcher:public-only',{kind:'launcher',workspaceId:f.resource.id,regionId:'public-only-region'})
  await act(async()=>{useAppStore.setState({tabs:{[only.id]:only},layouts:{[f.resource.id]:createWorkspaceLayout('public-only-group',[only.id])},workbenchSpaceSelection:null});useAppStore.getState().selectMainRegion({displayWorkspaceId:f.resource.id,groupId:'public-only-group',tabId:only.id,regionId:'public-only-region'},null);await useAppStore.getState().closeTab(f.resource.id,'public-only-group',only.id)})
  const parent=useAppStore.getState().workbenchSpaceSelection!;expect(parent).toMatchObject({tabId:null,regionId:null,groupId:null})
  expect((await cli(['app','inspect'])).observation.desktop.selection.space).toEqual(parent)
  const parentCatalog=await cli(['space','inspect','--zone',parent.zoneId!]);expect(parentCatalog.catalog.tabs).toHaveLength(0);expect(parentCatalog.catalog.zones).toHaveLength(1)
  expect(seen.filter(operation=>operation==='inspect.client')).toHaveLength(3);expect(seen.filter(operation=>operation==='space.inspect')).toHaveLength(3);expect(seen).toContain('focus')
 }finally{await rpc?.dispose();await server.stop();await rm(directory,{recursive:true,force:true});await f.close()}
})

it('two real independent private processes restore the post-close exact remaining Region and normal parent',async()=>{
 const recordPath=process.env.AGENTMUX_CLOSED_REGION_RESTORE_RECORD
 if(recordPath){
  const payload=JSON.parse(await readFile(recordPath,'utf8'));expect(process.pid).not.toBe(payload.parentPid)
  const proofs=[]
  for(const saved of payload.snapshots){
   vi.restoreAllMocks();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);localStorage.clear();useAppStore.setState(initial,true)
   localStorage.setItem('agentmux-workbench-v1',saved.record);await useAppStore.persist.rehydrate()
   const current=await api.spatial.read();await api.spatial.commit({expectedRevision:current?.revision??0,graph:saved.spatial.graph})
   vi.spyOn(api.config,'get').mockResolvedValue(saved.config);vi.spyOn(api.providers,'list').mockResolvedValue([]);vi.spyOn(api.demands,'list').mockResolvedValue([]);vi.spyOn(api.scratch,'listTopics').mockResolvedValue([])
   vi.spyOn(api.sessions,'snapshot').mockResolvedValue({sessions:saved.sessions,timelines:{},recoveryCandidates:[]});vi.spyOn(api.ui,'requestStorageFlush').mockResolvedValue(undefined)
   const lifecycle=['launchAgent','launchTerminal','recover','resume','stop','write','interrupt','submitPrompt','attach'].map(name=>vi.spyOn(api.sessions,name as keyof typeof api.sessions))
   const dispose=await useAppStore.getState().initialize();const restorePopover=installNativePopover();const container=document.createElement('div');document.body.append(container);const root=createRoot(container)
   try{
    const restored=useAppStore.getState();expect(restored.workbenchSpaceSelection).toEqual(saved.choice);expect(restored.tabs).toEqual(saved.tabs);expect(restored.layouts).toEqual(saved.layouts);expect(restored.agentComposerDrafts).toEqual(saved.drafts);expect(restored.agentFocus).toEqual(saved.agentFocus)
    expect(restored.sessions.map(session=>[session.id,session.control.run.runId])).toEqual(saved.sessions.map((session:{id:string;control:{run:{runId:string}}})=>[session.id,session.control.run.runId]))
    useAppStore.setState({initialize:async()=>()=>{}});await act(async()=>root.render(createElement(App)))
    expect(container.querySelector('.focus-location-recovery')).toBeNull()
    if(saved.kind==='remaining'){expect(container.querySelector('.focused-tab-workspace')?.getAttribute('data-focus-tab-id')).toBe(saved.choice.tabId);expect(container.querySelector(`[data-workbench-region-id="${saved.choice.regionId}"]`)).not.toBeNull();expect(container.querySelector(`[aria-label="Original draft ${saved.choice.tabId}/${saved.choice.regionId}"]`)).not.toBeNull()}
    else expect(container.querySelector('.focused-tab-workspace [data-workbench-empty-zone]')).not.toBeNull()
    for(const call of lifecycle)expect(call).not.toHaveBeenCalled()
    proofs.push({kind:saved.kind,choice:restored.workbenchSpaceSelection,tabs:restored.tabs,layouts:restored.layouts,drafts:restored.agentComposerDrafts,agentFocus:restored.agentFocus,recordSHA256:createHash('sha256').update(saved.record).digest('hex'),workfaceText:container.querySelector('.focused-tab-workspace')?.textContent})
   }finally{await act(async()=>root.unmount());container.remove();restorePopover();dispose()}
  }
  await writeFile(payload.proofPath,JSON.stringify({parentPid:payload.parentPid,restoredPid:process.pid,snapshots:proofs,scope:'Two actual private Node/Vitest processes, original persistence/Core graph restore and actual App/Workbench; whole SessionPane instance probe, no Reader/Native/Run-control claim.'},null,2));return
 }
 const f=await fixture(),directory=process.env.AGENTMUX_CLOSED_REGION_RESTORE_DIRECTORY!;await mkdir(directory,{recursive:true});const snapshots: Array<Pick<ReturnType<typeof useAppStore.getState>, 'config' | 'sessions' | 'tabs' | 'layouts' | 'agentFocus'> & {kind:string;record:string;spatial:NonNullable<Awaited<ReturnType<typeof api.spatial.read>>>;drafts:ReturnType<typeof useAppStore.getState>['agentComposerDrafts'];choice:ReturnType<typeof useAppStore.getState>['workbenchSpaceSelection']}> = []
 const persist=async(kind:string)=>{
  useAppStore.setState({initialize:initial.initialize});await initializeSpatialControlFixture();useAppStore.setState({initialize:async()=>()=>{}})
  await prepareRendererUpdate();const current=useAppStore.getState()
  const graph=desktopSpatialGraph(current,[],null),descriptors=desktopWorkbenchFromSpatial(graph)
  useAppStore.setState({tabs:Object.fromEntries(Object.entries(current.tabs).map(([id,tab])=>[id,{...tab,...(descriptors.tabs[id]?.space?{space:descriptors.tabs[id]!.space}:{})}]))})
  await prepareRendererUpdate();const state=useAppStore.getState(),record=localStorage.getItem('agentmux-workbench-v1')!;expect(record.length).toBeGreaterThan(0);const saved=await api.spatial.read(),committed=await api.spatial.commit({expectedRevision:saved?.revision??0,graph:desktopSpatialGraph(state,[],null)})
  snapshots.push({kind,record,spatial:committed,config:state.config,sessions:state.sessions,tabs:state.tabs,layouts:state.layouts,drafts:state.agentComposerDrafts,choice:state.workbenchSpaceSelection,agentFocus:state.agentFocus})
 }
 try{
  await f.chooseFile();await act(async()=>useAppStore.getState().closeRegion(f.resource.id,f.exact.id,f.file.regionId));await act(async()=>f.root.unmount());await persist('remaining')
  const only=createWorkbenchTab('launcher:restart-parent',{kind:'launcher',workspaceId:f.resource.id,regionId:'restart-parent-region'})
  await act(async()=>{useAppStore.setState({tabs:{[only.id]:only},layouts:{[f.resource.id]:createWorkspaceLayout('restart-parent-group',[only.id]),[f.display.id]:createWorkspaceLayout('restart-empty-display-group',[])},workbenchSpaceSelection:null});useAppStore.getState().selectMainRegion({displayWorkspaceId:f.resource.id,groupId:'restart-parent-group',tabId:only.id,regionId:'restart-parent-region'},null);await useAppStore.getState().closeTab(f.resource.id,'restart-parent-group',only.id)});await persist('parent')
  const path=join(directory,'record.json'),proofPath=join(directory,'child-proof.json');await writeFile(path,JSON.stringify({parentPid:process.pid,snapshots,proofPath},null,2))
  const repository=process.env.AGENTMUX_CLOSED_REGION_REPOSITORY!,config=process.env.AGENTMUX_CLOSED_REGION_VITEST_CONFIG!
  const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENTMUX_')&&!key.startsWith('CTXMUX_'))),AGENTMUX_CLOSED_REGION_RESTORE_RECORD:path,AGENTMUX_QUALIFICATION_KEY:(process.env.AGENTMUX_QUALIFICATION_KEY??'restore')+'-child',AGENTMUX_CLOSED_REGION_FACTS:join(directory,'child-facts.jsonl')}
  let result:{stdout:string;stderr:string};try{result=await promisify(execFile)(process.execPath,[join(repository,'node_modules/vitest/vitest.mjs'),'run','--config',config,'--testNamePattern','two real independent private','--reporter=json','--outputFile',join(directory,'vitest.json')],{cwd:repository,env,timeout:30000})}
  catch(error){const failure=error as {stdout:string;stderr:string};await writeFile(join(directory,'child.log'),(failure.stdout??'')+(failure.stderr??''));throw error}
  await writeFile(join(directory,'child.log'),result.stdout+result.stderr);const proof=JSON.parse(await readFile(proofPath,'utf8'));expect(proof.parentPid).toBe(process.pid);expect(proof.restoredPid).not.toBe(process.pid);expect(proof.snapshots).toHaveLength(2)
  await writeFile(join(directory,'process-receipt.json'),JSON.stringify({parentPid:process.pid,restoredPid:proof.restoredPid,snapshots:proof.snapshots.map((item:{kind:string;recordSHA256:string})=>({kind:item.kind,recordSHA256:item.recordSHA256})),matched:['exact remaining Region/display Group','normal parent choice and original empty Zone','tabs/layouts','Session/Run ids','Agent MRU','nonempty composer draft','actual App/Workbench'],scope:proof.scope},null,2))
 }finally{await f.close()}
},40000)
