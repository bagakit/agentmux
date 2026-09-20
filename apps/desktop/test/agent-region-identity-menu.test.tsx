// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
// Use the same installed browser primary as the split-ratio owning suite.
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)(
    '../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'
  )
})
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ readOnly }: { readOnly: boolean }) => <div data-private-readonly={readOnly}>Original terminal</div> }))
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { formatRegionAddress } from '../src/renderer/src/lib/agent-address'
import { openAgentHistory } from './helpers/agent-history-menu'

const initial=useAppStore.getState(),workspaceId='identity-workspace',tabId='identity-tab',leftId='identity-left',rightId='identity-right'
const names=['Layout coordinator · recovery audit','Notes researcher']
let root: Root,container:HTMLDivElement,sessionIds:string[]
beforeEach(async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}})
  const sessions=(await api.sessions.snapshot()).sessions.filter(session=>session.kind==='agent').slice(0,2)
  expect(sessions).toHaveLength(2)
  sessions[1]={...sessions[1]!,providerId:sessions[0]!.providerId,executorId:sessions[0]!.executorId,label:sessions[0]!.label}
  sessionIds=sessions.map(session=>session.id)
  let tab=createWorkbenchTab(tabId,{regionId:leftId,kind:'agent',phase:'attached',workspaceId,sessionId:sessionIds[0]!})
  tab=addWorkbenchRegion(tab,leftId,'right',{regionId:rightId,kind:'agent',phase:'attached',workspaceId,sessionId:sessionIds[1]!})
  useAppStore.setState({...initial,config:await api.config.get(),sessions,tabs:{[tabId]:tab},layouts:{[workspaceId]:createWorkspaceLayout('identity-group',[tabId])},activeWorkspaceId:workspaceId,
    agentNames:Object.fromEntries(sessionIds.map((id,index)=>[id,names[index]!])),viewModes:Object.fromEntries(sessionIds.map(id=>[id,'terminal'])),agentComposerDrafts:{[sessionIds[1]!]: 'Keep this draft'}},true)
  container=document.createElement('div');document.body.append(container);root=createRoot(container)
})
afterEach(async()=>{await act(async()=>root.unmount());document.body.replaceChildren();useAppStore.setState(initial,true);vi.unstubAllGlobals();vi.restoreAllMocks()})
async function mount(){await act(async()=>root.render(<WorkspaceWorkbench workspaceId={workspaceId}/>))}
function left(){const region=container.querySelector<HTMLElement>(`[data-workbench-region-id="${leftId}"]`);expect(region).not.toBeNull();return region!}
async function menuWithRightActive(){
  const trigger=left().querySelector<HTMLButtonElement>('.agent-region-header__more');expect(trigger).not.toBeNull()
  await act(async()=>{
    trigger!.focus()
    trigger!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))
  })
  await act(async()=>await vi.waitFor(()=>expect(document.querySelector(`.agent-region-menu[data-owner-region-id="${leftId}"] [role="menuitem"]`)).not.toBeNull()))
  await act(async()=>useAppStore.getState().focusRegion(workspaceId,tabId,rightId,'pointer'))
  expect(useAppStore.getState().tabs[tabId]!.layout.activeRegionId).toBe(rightId)
  const menu=document.querySelector<HTMLElement>(`.agent-region-menu[data-owner-region-id="${leftId}"]`)
  expect(menu).not.toBeNull();expect(menu!.dataset.state).toBe('open')
  expect(menu!.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0)
  return menu!
}
function menuItem(menu:HTMLElement,text:string){const found=[...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent?.trim()===text);expect(found,`actual ${text} item`).toBeDefined();return found!}
async function select(item:HTMLElement,pointerType='mouse'){await act(async()=>{
  item.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0,pointerType}))
  expect(useAppStore.getState().tabs[tabId]!.layout.activeRegionId).toBe(rightId)
  item.click()
})}

it('keeps distinct fact-derived names for two Agents with the same Provider and label, with a single identity per Region',async()=>{
  await mount();const headers=[...container.querySelectorAll('.agent-region-header')];expect(headers).toHaveLength(2)
  expect(headers.map(header=>header.querySelector('strong')!.textContent)).toEqual(names)
  expect(headers.map(header=>header.querySelector('strong')!.title)).toEqual(names)
  headers.forEach((header,index)=>expect(header.getAttribute('aria-label')).toContain(sessionIds[index]!))
  expect(container.querySelectorAll('.agent-input-stack__rail')).toHaveLength(0)
  expect(container.querySelectorAll('.composer-tool--view-toggle')).toHaveLength(2)
})
it('keeps the full name accessible while moving executor and Session context into the original precise menu',async()=>{
  await mount()
  const header=left().querySelector<HTMLElement>('.agent-region-header')!
  expect(header).not.toBeNull()
  expect(header.querySelectorAll('.agent-region-header__meta')).toHaveLength(0)
  expect(header.querySelector<HTMLElement>('.agent-region-header__name')!.title).toBe(names[0])
  expect(header.getAttribute('aria-label')).toContain(names[0]!)
  const menu=await menuWithRightActive(),context=menu.querySelector<HTMLElement>('.agent-region-menu__context')
  expect(context,'original More exposes mouse-readable identity context').not.toBeNull()
  expect(context!.textContent).toContain(names[0]!)
  expect(context!.textContent).toContain(`Session: ${sessionIds[0]}`)
  expect(context!.textContent).toContain('Executor:')
  const copy=vi.spyOn(api.ui,'writeClipboardText').mockResolvedValue(undefined)
  await select(menuItem(menu,'Copy Region Address'))
  expect(copy).toHaveBeenCalledExactlyOnceWith(formatRegionAddress(leftId))
})
it('the actual identity follows user name, first prompt, Session label and then the current Provider label',async()=>{
  await mount();const id=sessionIds[0]!,name=()=>left().querySelector('.agent-region-header strong')!.textContent
  expect(name()).toBe(names[0])
  await act(async()=>useAppStore.setState({agentNames:{},timelines:{[id]:{agentSessionId:id,revision:1,items:[{
    id:'first-prompt',agentSessionId:id,kind:'user_message',status:'complete',source:'native-hook',createdAt:1,updatedAt:1,title:'Investigate delivery',content:'Investigate delivery'}]}}}))
  expect(name()).toBe('Investigate delivery')
  await act(async()=>useAppStore.setState({timelines:{}}));expect(name()).toBe(useAppStore.getState().sessions[0]!.label)
  await act(async()=>useAppStore.setState({sessions:useAppStore.getState().sessions.map(session=>session.id===id?{...session,label:'   '}:session)}))
  const provider=useAppStore.getState().sessions[0]!.providerId
  expect(provider).toBe('codex');expect(name()).toBe('Codex')
})
it('the actual name and receiver survive the existing view switch and explicit Reader without replacing Session identity',async()=>{
  await mount();const before=structuredClone(useAppStore.getState().sessions)
  const toggle=left().querySelector<HTMLButtonElement>('.composer-tool--view-toggle');expect(toggle).not.toBeNull()
  await act(async()=>toggle!.click());expect(left().querySelector('.agent-region-header strong')!.textContent).toBe(names[0]);expect(toggle!.getAttribute('aria-label')).toBe('Show Terminal')
  await act(async()=>toggle!.click());await openAgentHistory(left())
  expect(left().querySelector('[aria-label="Conversation history"]')).not.toBeNull()
  expect(left().querySelectorAll('.agent-region-header')).toHaveLength(1)
  expect(left().querySelector('.agent-region-header strong')!.textContent).toBe(names[0])
  expect(left().querySelector('.composer-agent-identity [aria-label]')!.getAttribute('aria-label')).toContain(names[0]!)
  expect(useAppStore.getState().sessions).toEqual(before)
})
it('read-only observation keeps the same Agent identity while the original policy removes all input and recovery',async()=>{
  const sessionId=sessionIds[0]!
  await act(async()=>root.render(<SessionPane sessionId={sessionId} surfaceKind="agent" interactiveResize={false} visible readOnly linkOrigin={{workspaceId,tabId,regionId:leftId}}/>))
  expect(container.querySelector('.agent-region-header strong')!.textContent).toBe(names[0]);expect(container.querySelector('.agent-region-header__mode')!.textContent).toBe('Read-only')
  expect(container.querySelectorAll('.composer')).toHaveLength(0);expect(container.querySelector('[data-private-readonly="true"]')).not.toBeNull()
})
it.each(['mouse','touch'])('the actual Copy Region item keeps its origin while its neighbor is active (%s)',async(pointerType)=>{
  const copy=vi.spyOn(api.ui,'writeClipboardText').mockResolvedValue(undefined);await mount();const menu=await menuWithRightActive()
  await select(menuItem(menu,'Copy Region Address'),pointerType);expect(copy).toHaveBeenCalledExactlyOnceWith(formatRegionAddress(leftId))
  expect(useAppStore.getState().tabs[tabId]!.layout.activeRegionId).toBe(rightId)
})
it('keyboard selection retains the exact original Region and the active neighbor',async()=>{
  const copy=vi.spyOn(api.ui,'writeClipboardText').mockResolvedValue(undefined);await mount();const menu=await menuWithRightActive()
  await act(async()=>{const item=menuItem(menu,'Copy Region Address');item.focus();item.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))})
  expect(copy).toHaveBeenCalledExactlyOnceWith(formatRegionAddress(leftId));expect(useAppStore.getState().tabs[tabId]!.layout.activeRegionId).toBe(rightId)
})
it('the actual Split item targets its original left Region, and keeps the neighbor Session and draft',async()=>{
  const split=vi.spyOn(useAppStore.getState(),'splitRegion');await mount();const before=structuredClone(useAppStore.getState().sessions),menu=await menuWithRightActive()
  const splitItems=[...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter(item=>item.textContent?.trim().startsWith('Split '));expect(splitItems.length).toBeGreaterThan(0)
  await select(splitItems[0]!);expect(split).toHaveBeenCalled();expect(split.mock.calls[0]!.slice(0,3)).toEqual([workspaceId,tabId,leftId])
  expect(useAppStore.getState().tabs[tabId]!.regions[rightId]!.sessionId).toBe(sessionIds[1]);expect(useAppStore.getState().sessions).toEqual(before);expect(useAppStore.getState().agentComposerDrafts[sessionIds[1]!]).toBe('Keep this draft')
})
it('the actual Move to New Tab item promotes the original left Region while the right Region is active',async()=>{
  const promote=vi.spyOn(useAppStore.getState(),'promoteRegionToTab');await mount();const before=structuredClone(useAppStore.getState().sessions),menu=await menuWithRightActive()
  await select(menuItem(menu,'Move to New Tab'));expect(promote).toHaveBeenCalledExactlyOnceWith(workspaceId,tabId,leftId)
  expect(Object.keys(useAppStore.getState().tabs[tabId]!.regions)).toEqual([rightId]);expect(useAppStore.getState().sessions).toEqual(before);expect(useAppStore.getState().agentComposerDrafts[sessionIds[1]!]).toBe('Keep this draft')
})
