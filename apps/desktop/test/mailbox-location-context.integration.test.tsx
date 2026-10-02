import { win32 as _hygiene_win32 } from "node:path"
const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { composerDOM, composerSession, composerConfig } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab, addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
import type { OpenHttpLinkOrigin } from '../src/renderer/src/lib/open-destination'
import { workbenchSessionStageHostId, type WorkbenchViewTarget } from '../src/renderer/src/lib/workbench-presentation'
import { MailboxLocationContext } from '../src/renderer/src/components/MailboxLocationContext'
import { conversationMessageSourceKey } from '@agentmux/client-ui/conversation-message-location'
import * as projects from '../src/renderer/src/lib/workspace-projects'
vi.mock('../src/renderer/src/components/MailboxLocationContext', async importOriginal => {
  const module = await importOriginal<typeof import('../src/renderer/src/components/MailboxLocationContext')>()
  return { ...module, MailboxLocationContext: vi.fn(module.MailboxLocationContext) }
})
const terminals = vi.hoisted(() => ({ mounted: 0, disposed: 0 }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => {
  useEffect(() => { ++terminals.mounted; return () => { ++terminals.disposed } }, [])
  return <div data-terminal-witness />
} }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { StableWorkbenchView } from '../src/renderer/src/components/StableWorkbenchView'
const dom = composerDOM(), body = 'Original full recorded message'
const origin: OpenHttpLinkOrigin = { workspaceId: 'display', tabGroupId: 'group', tabId: 'target-tab', regionId: 'target-region', sessionId: 'agent-1' }
const cwd = _hygiene_fixturePath("execution/original/cwd"), repo = _hygiene_fixturePath("remote/project-root"), worktree = _hygiene_fixturePath("remote/project-root/.worktrees/current-work")
const panel = () => dom.container.querySelector<HTMLElement>('.composer-mailbox')!
async function flush() { await act(async () => { for (let i=0;i<20;i++) await Promise.resolve() }); await act(async () => new Promise(resolve => setTimeout(resolve,25))) }
async function open(folder = 'inbox') { const e = new Event('toggle'); Object.defineProperty(e,'newState',{value:'open'}); await act(async()=>panel().dispatchEvent(e)); await flush(); await dom.click(`[role="tab"][id$="-${folder}-tab"]`) }
async function detail() { await open(); await dom.click('.composer-mailbox__row') }
async function info() { await dom.click('[aria-label="Message details"]') }
function field(label: string, root: ParentNode = panel()) { const dt=[...root.querySelectorAll('dt')].find(n=>n.textContent===label); expect(dt).toBeDefined(); return dt!.nextElementSibling!.textContent }
const pane = (address=origin) => <SessionPane sessionId="agent-1" surfaceKind="agent" interactiveResize={false} visible linkOrigin={address} />
beforeEach(() => {
  vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue()
  terminals.mounted=0;terminals.disposed=0;localStorage.clear()
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>window.setTimeout(()=>callback(0),0));vi.stubGlobal('cancelAnimationFrame',(id:number)=>window.clearTimeout(id))
  vi.stubGlobal('IntersectionObserver',class {observe(){} disconnect(){} unobserve(){}})
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(){return {x:0,y:0,top:0,left:0,right:600,bottom:this.classList.contains('activity-feed')?300:20,width:600,height:this.classList.contains('activity-feed')?300:20,toJSON(){}}})
  Object.defineProperty(HTMLElement.prototype,'scrollIntoView',{configurable:true,value:vi.fn()})
  Object.defineProperty(HTMLElement.prototype,'hidePopover',{configurable:true,value(){const e=new Event('toggle');Object.defineProperty(e,'newState',{value:'closed'});this.dispatchEvent(e)}})
  vi.spyOn(api.sessions,'historyPage').mockResolvedValue({agentSessionId:'agent-1',source:{providerId:'codex',nativeSessionId:'native-a'},items:[{id:'native-record',kind:'user-message',contentParts:[{kind:'text',text:body}]}]})
  vi.spyOn(api.sessions,'observeHistory').mockResolvedValue({source:{providerId:'codex',nativeSessionId:'native-a'},dispose(){}})
  vi.spyOn(api.continuousProgress,'list').mockResolvedValue([])
  const target=addWorkbenchRegion(createWorkbenchTab('target-tab',{kind:'agent',phase:'attached',regionId:'first-region',workspaceId:'resource-work',sessionId:'other'}),'first-region','right',{kind:'agent',phase:'attached',regionId:'target-region',workspaceId:'resource-work',sessionId:'agent-1'})
  useAppStore.setState({activeWorkspaceId:'wrong-active',agentNames:{'declared-peer':'Sender identity'},
    config:{...composerConfig,hosts:[...composerConfig.hosts,{id:'remote',kind:'ssh',label:'Resource machine',host:'private.invalid',user:'preview'}],workspaces:[
      {id:'display',name:'Display space',kind:'folder',hostId:'local',path:_hygiene_fixturePath("display/space")},
      {id:'resource-root',name:'Resource project',kind:'folder',hostId:'remote',path:repo},
      {id:'resource-work',name:'Working copy',kind:'worktree',hostId:'remote',repoPath:repo,path:worktree,branch:'work-branch'},
      {id:'sender',name:'Sender project',kind:'folder',hostId:'local',path:_hygiene_fixturePath("sender/project")}]},
    tabs:{'target-tab':{...target,name:'Clicked target Tab'}},layouts:{display:createWorkspaceLayout('group',['target-tab'])},
    sessions:[{...composerSession(),workspacePath:cwd},composerSession('other'),{...composerSession('declared-peer'),workspacePath:_hygiene_fixturePath("sender/project")}],
    viewModes:{'agent-1':'terminal',other:'terminal'},timelines:{'agent-1':{agentSessionId:'agent-1',revision:1,items:[{id:'captured-record',agentSessionId:'agent-1',kind:'user_message',status:'complete',source:'user',content:body,authorAgentSessionId:'declared-peer',createdAt:1,updatedAt:1}]}},noticeReadReceipts:{},agentSteerQueues:{},agentSteerInFlight:{}})
})
it('real primary detail distinguishes target, sender, first Region, active Workspace, two Hosts and three directories; Copy/navigation retain original message',async()=>{
  await dom.render(pane());await detail();expect(panel().querySelector('[data-mailbox-location="summary"]')!.textContent).toContain('Resource project · Clicked target Tab');await info()
  for(const [key,value] of Object.entries({'显示 Workspace ID':'display','Group ID':'group','Tab ID':'target-tab','Region ID':'target-region','项目根目录':repo,'Workspace / worktree 目录':worktree,'当前执行 cwd':cwd,'资源 Host':'remote','执行 Host':'local','分支':'work-branch'}))expect(field(key)).toBe(value)
  expect(panel().textContent).toContain('Current sender');expect(panel().textContent).toContain('Sender identity');expect(panel().textContent).toContain('消息发生时的 Region、项目与 cwd 未记录')
  await dom.click('[aria-label="Copy message"]');expect(api.ui.writeClipboardText).toHaveBeenCalledWith(body)
  await dom.click('.log-turn__actions .composer-mailbox__reveal');await flush();const key=conversationMessageSourceKey('agent-1',{kind:'captured',submissionId:'captured-record'});const node=[...dom.container.querySelectorAll<HTMLElement>('[data-message-located]')].find(n=>n.dataset.messageSourceKey===key);expect(node).toBeDefined();expect(document.activeElement).toBe(node);expect(dom.draft()).toBe('Keep my draft');expect(terminals.mounted).toBe(1);expect(terminals.disposed).toBe(0)
})
it('native Outbox detail shares the same exact current location without changing unknown authorship',async()=>{
  await dom.render(pane());await open('outbox');await dom.click('.composer-mailbox__row');await info();expect(field('当前执行 cwd')).toBe(cwd);expect(panel().textContent).toContain('Native session');expect(panel().textContent).toContain('Not recorded')
})
it('the real primary StableWorkbenchView parent reference identifies a borrowed display independently of resource linkOrigin',async()=>{
  useAppStore.setState(s=>({config:{...s.config!,workspaces:[...s.config!.workspaces,{id:'borrowed-display',name:'Borrowed display space',kind:'folder',hostId:'local',path:_hygiene_fixturePath("display/borrowed")}]},layouts:{...s.layouts,'borrowed-display':createWorkspaceLayout('borrowed-group',['target-tab'])}}))
  await dom.render(<><div id="borrowed-primary-host"/><StableWorkbenchView homeId="primary-home" targetId="borrowed-primary-host" active retainedRegionId={null} reference={{displayWorkspaceId:'borrowed-display',groupId:'borrowed-group',tabId:'target-tab',regionId:'first-region'}}>{pane({...origin,workspaceId:'resource-work',tabGroupId:'borrowed-group'})}</StableWorkbenchView></>)
  await detail();await info();expect(field('显示 Workspace ID')).toBe('borrowed-display');expect(field('Group ID')).toBe('borrowed-group');expect(field('Region ID')).toBe('target-region');expect(field('资源 Workspace ID')).toBe('resource-work');expect(field('项目根目录')).toBe(repo);expect(field('当前执行 cwd')).toBe(cwd)
})
it('exact rename and metadata changes update an open detail without mode, Run, focus or draft writes',async()=>{
  await dom.render(pane());await detail();await info();const run=useAppStore.getState().sessions[0]!.control.run,active=document.activeElement
  await act(async()=>useAppStore.setState(s=>({tabs:{...s.tabs,'target-tab':{...s.tabs['target-tab']!,name:'Renamed target Tab'}},config:{...s.config!,workspaces:s.config!.workspaces.map(w=>w.id==='resource-work'?{...w,path:_hygiene_win32.join("C:", _hygiene_win32.sep, "remote\\worktree\\long readable directory")}:w)},sessions:s.sessions.map(s=>s.id==='agent-1'?{...s,workspacePath:_hygiene_fixturePath("execution/new-current-cwd")}:s)})))
  expect(field('Tab')).toBe('Renamed target Tab');expect(field('Workspace / worktree 目录')).toBe(_hygiene_win32.join("C:", _hygiene_win32.sep, "remote\\worktree\\long readable directory"));expect(field('当前执行 cwd')).toBe(_hygiene_fixturePath("execution/new-current-cwd"));expect(useAppStore.getState().sessions[0]!.control.run).toEqual(run);expect(document.activeElement).toBe(active);expect(dom.draft()).toBe('Keep my draft');expect(useAppStore.getState().viewModes['agent-1']).toBe('terminal')
})
it.each(['missing-group','first-region'])('unconfirmed reference %s never borrows a confirmed project, but retains execution facts, Copy and navigation',async broken=>{
  await dom.render(pane({...origin,...(broken==='missing-group'?{tabGroupId:'missing'}:{regionId:'first-region'})}));await detail();await info();expect(panel().textContent).toContain('未确认的显示引用');expect(field('项目根目录')).toBe('未确认');expect(field('分支')).toBe('未确认');expect(field('当前执行 cwd')).toBe(cwd);expect(panel().querySelector<HTMLButtonElement>('.composer-mailbox__reveal')!.disabled).toBe(false);await dom.click('[aria-label="Copy message"]');expect(api.ui.writeClipboardText).toHaveBeenCalledWith(body)
})
it('Pending only discloses its owning Session execution facts and does not dispatch or claim a message target',async()=>{
  useAppStore.setState({agentSteerQueues:{'agent-1':[{operationId:'pending',text:'Original queued instruction',status:'queued',runId:'run-agent-1'}]}});const prompt=vi.spyOn(api.sessions,'submitPrompt'),message=vi.spyOn(api.sessions,'submitMessage')
  await dom.render(pane());await open('outbox');await dom.click('[data-record-key="queue:pending"].composer-mailbox__row');await info();expect(panel().querySelector('[data-mailbox-location="summary"]')).toBeNull();expect(panel().querySelector('[data-mailbox-location="target"]')).toBeNull();expect(field('当前执行 cwd')).toBe(cwd);expect(panel().textContent).toContain('尚未发送，暂无对话位置');expect(panel().querySelector<HTMLButtonElement>('.composer-mailbox__reveal')!.disabled).toBe(true);expect(prompt).not.toHaveBeenCalled();expect(message).not.toHaveBeenCalled()
})
it('closed and unselected Mailbox reads zero location metadata; unrelated Session changes do not redo target lookup',async()=>{
  await dom.render(pane());const owner=vi.mocked(MailboxLocationContext);owner.mockClear()
  const original=projects.projectWorkspaces;let locationReads=0
  vi.spyOn(projects,'projectWorkspaces').mockImplementation((...args)=>{
    const frames=(new Error().stack??'').split('\n'), index=frames.findIndex(line=>line.includes('at projectWorkspaces '))
    expect(index).toBeGreaterThanOrEqual(0)
    if(frames[index+1]?.includes('MailboxLocationContext.tsx'))++locationReads
    return original(...args)
  })
  await act(async()=>useAppStore.setState({agentNames:{unrelated:'Updated'}}));expect(owner).not.toHaveBeenCalled();expect(locationReads).toBe(0)
  await open();expect(owner).not.toHaveBeenCalled();await dom.click('.composer-mailbox__row');expect(owner).toHaveBeenCalled();expect(locationReads).toBeGreaterThan(0);locationReads=0
  await act(async()=>useAppStore.setState(s=>({sessions:s.sessions.map(a=>a.id==='declared-peer'?{...a,status:{state:'idle',source:'native-hook',observedAt:2}}:a),timelines:{...s.timelines,unrelated:{agentSessionId:'unrelated',revision:2,items:[]}}})));expect(locationReads).toBe(0)
  await act(async()=>useAppStore.setState(s=>({config:{...s.config!,workspaces:s.config!.workspaces.map(w=>w.id==='resource-root'?{...w,name:'Related Project rename'}:w)}})));expect(locationReads).toBeGreaterThan(0);expect(panel().textContent).toContain('Related Project rename')
  await act(async()=>panel().dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));expect(panel().dataset.state).toBe('closed');owner.mockClear();locationReads=0;await act(async()=>useAppStore.setState({agentNames:{unrelated:'Again'}}));expect(owner).not.toHaveBeenCalled();expect(locationReads).toBe(0)
})
it('two actual presentation composers each show their independent address and only the clicked host receives exact focus',async()=>{
  const targets:WorkbenchViewTarget[]=['a','b'].map(id=>({hostId:'presentation-'+id,active:true,visible:true,reference:{displayWorkspaceId:'display-'+id,groupId:'group-'+id,tabId:'tab-'+id,regionId:'target-region'}}))
  useAppStore.setState(s=>({viewModes:{'agent-1':'activity'},config:{...s.config!,workspaces:[...s.config!.workspaces,...targets.map(t=>({id:t.reference!.displayWorkspaceId,name:'Display '+t.hostId,hostId:'local',path:_hygiene_fixturePath("display/")+t.hostId,kind:'folder' as const}))]},tabs:{...s.tabs,...Object.fromEntries(targets.map(t=>[t.reference!.tabId,{...s.tabs['target-tab']!,id:t.reference!.tabId,name:'Tab '+t.hostId}]))},layouts:{...s.layouts,...Object.fromEntries(targets.map(t=>[t.reference!.displayWorkspaceId,createWorkspaceLayout(t.reference!.groupId,[t.reference!.tabId])]))}}))
  const hosts=targets.map(t=>{const h=document.createElement('div');h.id=workbenchSessionStageHostId(t,'target-region');document.body.append(h);return h})
  try{await dom.render(<SessionPane sessionId="agent-1" surfaceKind="agent" interactiveResize={false} visible={false} linkOrigin={origin} presentations={targets} renderPresentationFrame={c=>c}/>);await flush()
    for(const [i,h]of hosts.entries()){const p=h.querySelector<HTMLElement>('.composer-mailbox')!;const e=new Event('toggle');Object.defineProperty(e,'newState',{value:'open'});await act(async()=>p.dispatchEvent(e));for(const selector of ['[id$="-inbox-tab"]','.composer-mailbox__row','[aria-label="Message details"]'])await act(async()=>p.querySelector<HTMLButtonElement>(selector)!.click());expect(field('Tab ID',p)).toBe('tab-'+(i===0?'a':'b'));expect(field('Group ID',p)).toBe('group-'+(i===0?'a':'b'));expect(p.textContent).toContain('Tab presentation-'+(i===0?'a':'b'))}
    await act(async()=>hosts[1]!.querySelector<HTMLButtonElement>('.log-turn__actions .composer-mailbox__reveal')!.click());await flush();expect(hosts[1]!.querySelector('[data-message-located]')).not.toBeNull();expect(hosts[0]!.querySelector('[data-message-located]')).toBeNull();expect(document.activeElement).toBe(hosts[1]!.querySelector('[data-message-located]'))
  }finally{hosts.forEach(h=>h.remove())}
})
