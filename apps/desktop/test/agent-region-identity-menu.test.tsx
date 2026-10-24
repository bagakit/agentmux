// @vitest-environment happy-dom
import { act } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
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
import { RegionContextMenu } from '../src/renderer/src/components/RegionContextMenu'
import { workbenchSessionStageHostId, type WorkbenchViewTarget } from '../src/renderer/src/lib/workbench-presentation'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { useAppStore } from '../src/renderer/src/store'
import * as storeModule from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { formatRegionAddress } from '../src/renderer/src/lib/agent-address'
import { openAgentHistory } from './helpers/agent-history-menu'
import { absoluteFocusFixtureInputs } from './fixtures/focus-workbench'

const initial=useAppStore.getState(),workspaceId='identity-workspace',tabId='identity-tab',leftId='identity-left',rightId='identity-right'
const names=['Layout coordinator · recovery audit','Notes researcher']
let root: Root,container:HTMLDivElement,sessionIds:string[]
beforeEach(async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}})
  const input=absoluteFocusFixtureInputs(await api.config.get(),(await api.sessions.snapshot()).sessions.filter(session=>session.kind==='agent').slice(0,2))
  input.config.workspaces[0]={...input.config.workspaces[0]!,id:workspaceId}
  const sessions=input.sessions
  expect(sessions).toHaveLength(2)
  sessions[1]={...sessions[1]!,providerId:sessions[0]!.providerId,executorId:sessions[0]!.executorId,label:sessions[0]!.label}
  sessionIds=sessions.map(session=>session.id)
  let tab=createWorkbenchTab(tabId,{regionId:leftId,kind:'agent',phase:'attached',workspaceId,sessionId:sessionIds[0]!})
  tab=addWorkbenchRegion(tab,leftId,'right',{regionId:rightId,kind:'agent',phase:'attached',workspaceId,sessionId:sessionIds[1]!})
  useAppStore.setState({...initial,config:input.config,sessions,tabs:{[tabId]:tab},layouts:{[workspaceId]:createWorkspaceLayout('identity-group',[tabId])},activeWorkspaceId:workspaceId,mainSurface:'workbench',
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
async function submenu(menu:HTMLElement,label:string){
  const trigger=menuItem(menu,label)
  await act(async()=>{trigger.focus();trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}))})
  let result:HTMLElement|null=null
  await act(async()=>await vi.waitFor(()=>{result=document.getElementById(trigger.getAttribute('aria-controls')!);expect(result).not.toBeNull()}))
  return result!
}
function menuItem(menu:HTMLElement,text:string){const found=[...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>(item.getAttribute('aria-label')??item.textContent)?.trim()===text);expect(found,`actual ${text} item`).toBeDefined();return found!}
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
  const menu=await menuWithRightActive(),details=await submenu(menu,'Session details'),context=details.querySelector<HTMLElement>('.agent-region-menu__context')
  expect(context,'original More exposes mouse-readable identity context').not.toBeNull()
  expect(context!.textContent).toContain(names[0]!)
  expect(context!.textContent).toContain(`Session: ${sessionIds[0]}`)
  expect(context!.textContent).toContain('Executor:')
  await act(async()=>details.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true})))
  const row=menu.querySelector<HTMLElement>('.workbench-menu-row[aria-label="Copy link"]')
  expect(row,'compact copy shortcuts stay in the original root').not.toBeNull()
  expect([...row!.querySelectorAll('[role="menuitem"]')].map(item=>item.getAttribute('aria-label'))).toEqual(['Copy Region Link'])
  expect([...row!.querySelectorAll('[role="menuitem"]')].every(item=>item.closest('[role="menu"]')===menu)).toBe(true)
  const copy=vi.spyOn(api.ui,'writeClipboardText').mockResolvedValue(undefined)
  await select(menuItem(menu,'Copy Region Link'))
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
  const terminalToggle=left().querySelector<HTMLButtonElement>('.composer-tool--view-toggle');expect(terminalToggle).not.toBeNull()
  await act(async()=>terminalToggle!.click());await openAgentHistory(left())
  expect(left().querySelector('[aria-label="Return to Terminal"]')).not.toBeNull()
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
  await select(menuItem(menu,'Copy Region Link'),pointerType);expect(copy).toHaveBeenCalledExactlyOnceWith(formatRegionAddress(leftId))
  expect(useAppStore.getState().tabs[tabId]!.layout.activeRegionId).toBe(rightId)
})
it('keyboard selection retains the exact original Region and the active neighbor',async()=>{
  const copy=vi.spyOn(api.ui,'writeClipboardText').mockResolvedValue(undefined);await mount();const menu=await menuWithRightActive()
  const links=menu
  await act(async()=>{const item=menuItem(links,'Copy Region Link');item.focus();item.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))})
  expect(copy).toHaveBeenCalledExactlyOnceWith(formatRegionAddress(leftId));expect(useAppStore.getState().tabs[tabId]!.layout.activeRegionId).toBe(rightId)
})
it('the actual Split item targets its original left Region, and keeps the neighbor Session and draft',async()=>{
  const split=vi.spyOn(useAppStore.getState(),'splitRegion');await mount();const before=structuredClone(useAppStore.getState().sessions),menu=await menuWithRightActive()
  const layout=menu
  const splitItems=[...layout.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter(item=>item.getAttribute('aria-label')?.startsWith('Split '));expect(splitItems.length).toBeGreaterThan(0)
  await select(splitItems[0]!);expect(split).toHaveBeenCalled();expect(split.mock.calls[0]!.slice(0,3)).toEqual([workspaceId,tabId,leftId])
  expect(useAppStore.getState().tabs[tabId]!.regions[rightId]!.sessionId).toBe(sessionIds[1]);expect(useAppStore.getState().sessions).toEqual(before);expect(useAppStore.getState().agentComposerDrafts[sessionIds[1]!]).toBe('Keep this draft')
})
it('the actual Move to New Tab item promotes the original left Region while the right Region is active',async()=>{
  const promote=vi.spyOn(useAppStore.getState(),'promoteRegionToTab');await mount();const before=structuredClone(useAppStore.getState().sessions),menu=await menuWithRightActive()
  await select(menuItem(menu,'Move to New Tab'));expect(promote).toHaveBeenCalledExactlyOnceWith(workspaceId,tabId,leftId)
  expect(Object.keys(useAppStore.getState().tabs[tabId]!.regions)).toEqual([rightId]);expect(useAppStore.getState().sessions).toEqual(before);expect(useAppStore.getState().agentComposerDrafts[sessionIds[1]!]).toBe('Keep this draft')
})

async function contextMenuWithRightActive(){
  await act(async()=>left().dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:12,clientY:12})))
  await act(async()=>useAppStore.getState().focusRegion(workspaceId,tabId,rightId,'pointer'))
  const menu=document.querySelector<HTMLElement>(`.agent-region-menu[data-menu-entry="context"][data-owner-region-id="${leftId}"]`)
  expect(menu).not.toBeNull();expect(menu!.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0)
  return menu!
}
it('the same split Agent exposes identical live actions through More and right-click, with Take over independent of the active neighbor',async()=>{
  await mount()
  const more=await menuWithRightActive(),labels=(root:HTMLElement)=>[...root.querySelectorAll('[role="menuitem"]')].map(item=>(item.getAttribute('aria-label')??item.textContent)?.trim())
  const expected=labels(more);expect(expected).toContain('Take over')
  await act(async()=>more.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})))
  const context=await contextMenuWithRightActive()
  expect(labels(context)).toEqual(expected)
  expect(document.querySelectorAll('.agent-region-menu')).toHaveLength(1)
  await select(menuItem(context,'Take over'))
  expect(left().querySelector('.session-takeover__origin')?.textContent).toContain(names[0])
  expect(container.querySelector(`[data-workbench-region-id="${rightId}"] .session-takeover`)).toBeNull()
  expect(useAppStore.getState().tabs[tabId]!.regions[leftId]!.sessionId).toBe(sessionIds[0])
  expect(useAppStore.getState().agentComposerDrafts[sessionIds[1]!]).toBe('Keep this draft')
})
it('right-click link selection retains the invoking Region and does not borrow the active neighbor',async()=>{
  const copy=vi.spyOn(api.ui,'writeClipboardText').mockResolvedValue(undefined)
  await mount();const context=await contextMenuWithRightActive(),links=context
  await select(menuItem(links,'Copy Region Link'))
  expect(copy).toHaveBeenCalledExactlyOnceWith(formatRegionAddress(leftId))
})
it('switching between the two entry points retains the original native source review and never confirms automatically',async()=>{
  const session=useAppStore.getState().sessions[0]!
  expect(session.kind).toBe('agent')
  const native={kind:'provider' as const,providerId:session.providerId,sessionId:'retained-native'}
  await act(async()=>useAppStore.setState({sessions:useAppStore.getState().sessions.map(item=>item.id===session.id?{...item,nativeHandle:native,observedNativeHandle:{...native,sessionId:'candidate-native'},nativeSourceObservation:{state:'changed',reason:'Authoritative candidate differs',run:item.control.run,observedAt:1}}:item)}))
  const confirm=vi.spyOn(api.sessions,'confirmNativeSession')
  await mount();expect(left().querySelector('[data-native-source-marker]')?.textContent).toBe('Source changed')
  const more=await menuWithRightActive(),details=await submenu(more,'Session details')
  await act(async()=>menuItem(details,'Review source change…').click())
  expect(document.querySelector('[data-native-source-review]')?.textContent).toContain('candidate-native')
  await act(async()=>details.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true})))
  await act(async()=>more.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})))
  const context=await contextMenuWithRightActive(),retained=await submenu(context,'Session details')
  expect(retained.querySelector('[data-native-source-review]')?.textContent).toContain('retained-native')
  expect(retained.querySelector('[data-native-source-review]')?.textContent).toContain('candidate-native')
  expect(confirm).not.toHaveBeenCalled()
})
it.each(['more','context'] as const)('the %s Stop action confirms the named original Agent and stops only its exact Run',async entry=>{
  const stop=vi.spyOn(api.sessions,'stop').mockResolvedValue(undefined)
  await mount();const before=structuredClone(useAppStore.getState().sessions)
  const menu=entry==='more'?await menuWithRightActive():await contextMenuWithRightActive()
  await select(menuItem(menu,'Stop Agent'))
  const dialog=document.querySelector<HTMLElement>('[role="dialog"]')
  expect(dialog,JSON.stringify(useAppStore.getState().error)).not.toBeNull();expect(dialog!.textContent).toContain(names[0])
  expect(stop).not.toHaveBeenCalled()
  const confirm=[...dialog!.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Stop Agent')
  expect(confirm).toBeDefined();await act(async()=>confirm!.click())
  expect(stop).toHaveBeenCalledExactlyOnceWith(before[0]!.control)
  expect(useAppStore.getState().sessions).toEqual(before)
  expect(useAppStore.getState().agentComposerDrafts[sessionIds[1]!]).toBe('Keep this draft')
})

it('an unconfirmed Region position keeps the explicit Stop of an exactly identified Agent available',async()=>{
  const stop=vi.spyOn(api.sessions,'stop').mockResolvedValue(undefined)
  vi.spyOn(storeModule,'agentRegionExecution').mockReturnValue(null)
  await mount();const before=structuredClone(useAppStore.getState().sessions),menu=await menuWithRightActive()
  await select(menuItem(menu,'Stop Agent'))
  const dialog=document.querySelector<HTMLElement>('[role="dialog"]')
  expect(dialog).not.toBeNull();expect(stop).not.toHaveBeenCalled()
  const confirm=[...dialog!.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Stop Agent')
  expect(confirm).toBeDefined();await act(async()=>confirm!.click())
  expect(stop).toHaveBeenCalledExactlyOnceWith(before[0]!.control)
  expect(useAppStore.getState().sessions).toEqual(before)
})

it.each(['running', 'exited'] as const)('secondary Focus Activity presentations keep the %s Agent actions and open history/takeover in the invoking column', async processState => {
  const reference = { displayWorkspaceId: workspaceId, groupId: 'identity-group', tabId, regionId: leftId }
  const targets: WorkbenchViewTarget[] = ['focus-one', 'focus-two'].map(hostId => ({ hostId, active: true, visible: true, surface: 'focus', reference }))
  await act(async () => useAppStore.setState({ sessions: useAppStore.getState().sessions.map(session => session.id === sessionIds[0] ? { ...session, processState } : session), viewModes: { [sessionIds[0]!]: 'activity' } }))
  const before = useAppStore.getState().sessions
  await act(async () => root.render(<>{targets.map(target => <div key={target.hostId} id={workbenchSessionStageHostId(target, leftId)} />)}<SessionPane sessionId={sessionIds[0]!} surfaceKind="agent" interactiveResize={false}
    visible={false} linkOrigin={{ workspaceId, tabGroupId: reference.groupId, tabId, regionId: leftId, sessionId: sessionIds[0]! }}
    presentations={targets} renderPresentationFrame={(content, target) => <RegionContextMenu regionId={leftId} tabId={tabId}
      agentSessionId={sessionIds[0]!} splitMenu={[]} swapMenu={[]} writeClipboardText={api.ui.writeClipboardText}>
      <div data-secondary-focus={target.hostId}>{content}</div>
    </RegionContextMenu>} /></>))
  const columns = [...container.querySelectorAll<HTMLElement>('[data-secondary-focus]')]
  expect(columns).toHaveLength(2)
  columns.forEach((column, index) => {
    expect(column.closest('[hidden], [inert], [aria-hidden="true"]')).toBeNull()
    expect(column.closest('.retained-workbench-region')?.parentElement?.id).toBe(workbenchSessionStageHostId(targets[index]!, leftId))
  })
  const trigger = columns[1]!.querySelector<HTMLButtonElement>('.agent-region-header__more')!
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  const menu = document.querySelector<HTMLElement>('.agent-region-menu')!
  expect(menuItem(menu, 'Take over')).toBeDefined()
  expect(menuItem(menu, 'Stop Agent')).toBeDefined()
  expect(menuItem(menu, 'Conversation history')).toBeDefined()
  const details = await submenu(menu, 'Session details')
  expect(details.textContent).toContain(sessionIds[0])
  await act(async () => details.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })))
  await act(async () => menuItem(menu, 'Conversation history').click())
  expect(columns[1]!.querySelector('button[aria-label="Return to Activity"]')).not.toBeNull()
  await act(async () => new Promise(resolve => setTimeout(resolve, 40)))
  expect(columns[1]!.querySelector('button[aria-label="Return to Activity"]')).toBe(document.activeElement)
  expect(columns[0]!.querySelector('button[aria-label="Return to Activity"]')).toBeNull()
  await act(async () => columns[1]!.querySelector<HTMLButtonElement>('button[aria-label="Return to Activity"]')!.click())
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
  await act(async () => menuItem(document.querySelector<HTMLElement>('.agent-region-menu')!, 'Take over').click())
  expect(columns[1]!.querySelector('.session-takeover')).not.toBeNull()
  expect(columns[0]!.querySelector('.session-takeover')).toBeNull()
  expect(container.querySelectorAll('.session-takeover')).toHaveLength(1)
  expect(useAppStore.getState().sessions).toBe(before)
})


it.each(['more', 'context'] as const)('the actual %s menu groups controls separately from conversation information', async entry => {
  await mount()
  const menu = entry === 'more' ? await menuWithRightActive() : await contextMenuWithRightActive()
  const controls = menu.querySelector('[role="group"][aria-label="Agent controls"]')!
  const conversation = menu.querySelector('[role="group"][aria-label="Conversation"]')!
  expect(controls).not.toBeNull(); expect(conversation).not.toBeNull()
  const labels = (root: ParentNode) => [...root.querySelectorAll('[role="menuitem"]')].map(node => node.textContent?.trim())
  expect(labels(controls)).toEqual(['Take over', 'Pass on experience', 'Fork current conversation…', 'Restart Session…', 'Stop Agent'])
  expect(labels(conversation)).toEqual(['Conversation history', 'Session details'])
  expect(conversation.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  expect(menu.querySelector('[data-terminal-menu-tools]')).toBeNull()
})


it('a plain terminal More menu has no empty Agent control group', async () => {
  const session = useAppStore.getState().sessions[0]!
  useAppStore.setState({ sessions: [{ ...session, kind: 'terminal', providerId: null,
    control: { kind: 'terminal', hostId: session.hostId, runId: session.control.run.runId, run: session.control.run } }] })
  await act(async () => root.render(<SessionPane sessionId={session.id} surfaceKind="terminal" interactiveResize={false} visible linkOrigin={{workspaceId,tabId,regionId:leftId}} />))
  const trigger = container.querySelector<HTMLElement>('.agent-region-header__more')!
  expect(trigger).not.toBeNull()
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  const menu = document.querySelector<HTMLElement>('.agent-region-menu')!
  expect(menu).not.toBeNull()
  expect(menu.querySelector('[role="group"][aria-label="Agent controls"]')).toBeNull()
  expect(menu.querySelector('.agent-region-menu__summary')?.nextElementSibling?.getAttribute('aria-label')).toBe('Conversation')
  expect(menuItem(menu, 'Terminal details')).toBeDefined()
})
