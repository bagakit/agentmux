// @vitest-environment happy-dom
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, AgentMuxHostedRuntimeService, connectAgentMuxRpc, connectHostedAgentMux } from '@agentmux/core'
import { injectedContextCore } from './helpers/injected-context-core'
import { composerDOM } from './helpers/composer-dom-fixture'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
const dom = composerDOM()
const sessionId='system-reading-session', run={runId:'original-private-run'}
const source={hostId:'authority-host',deviceId:'paired-device',name:'My other computer'}
const disposers:Array<()=>Promise<unknown>>=[]
beforeEach(()=>{
 vi.stubGlobal('ResizeObserver',class { observe(){} unobserve(){} disconnect(){} })
 vi.stubGlobal('IntersectionObserver',class { observe(){} unobserve(){} disconnect(){} })
})
afterEach(async()=>{for(const dispose of disposers.splice(0).reverse())await dispose();vi.unstubAllGlobals();vi.unstubAllEnvs()})
async function fixture(){
 const workspacePath=await mkdtemp(join(tmpdir(),'amux-system-lines-'));disposers.push(()=>rm(workspacePath,{recursive:true}))
 const f=await injectedContextCore(workspacePath,{kind:'agent',agentSessionId:sessionId,providerId:'traex',executorId:'private',hostId:'local',workspacePath,run,retiredRuns:[],createdAt:1,updatedAt:1,hookBindingId:'private-binding',hookToken:'private-token'})
 disposers.push(()=>f.dispose())
 const inner=Reflect.get(f.core,'kernel'),resize=vi.fn(async(_run:string,cols:number,rows:number)=>({cols,rows})),interrupt=vi.fn(async()=>{})
 Object.assign(inner,{resize,interrupt})
 const owner={runtimeId:'private-original-runtime',ownerInstanceId:'private-owner-epoch',protocolVersion:1 as const,processId:123,availability:'connected' as const,ctxmux:f.core.runtimeIdentity()}
 const hosted=new AgentMuxHostedRuntimeService(f.core,f.store.path,()=>owner);disposers.push(()=>hosted.dispose())
 const activity=vi.fn(async(..._args:unknown[])=>{}),server=new AgentMuxControlServer({socketPath:join(workspacePath,'host.sock'),coreClients:()=>[{hostId:'local',client:f.core}],hostedRuntime:()=>hosted,operationSource:()=>source,recordDeviceOperation:activity})
 await server.start();disposers.push(()=>server.stop())
 const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:join(workspacePath,'host.sock')}});disposers.push(()=>rpc.dispose())
 const client=await connectHostedAgentMux({rpc});disposers.push(()=>client.dispose())
 return {...f,client,resize,interrupt,activity}
}
it('actual registered Hosted resize preserves Runtime receipt and Host activity without new conversational records',async()=>{
 const f=await fixture()
 await f.core.recordDeviceOperation(sessionId,'old-resize','resizeAgent',source,'confirmed')
 const before=await f.core.sessionTimeline(sessionId)
 for(let i=0;i<4;i++)expect(await f.client.resizeAgent(sessionId,run,80+i,24)).toEqual({runId:run.runId,cols:80+i,rows:24})
 expect(f.resize).toHaveBeenCalledTimes(4);expect(f.activity.mock.calls.map(c=>c[3])).toEqual(['unknown','confirmed','unknown','confirmed','unknown','confirmed','unknown','confirmed'])
 expect(await f.core.sessionTimeline(sessionId)).toEqual(before)
 f.resize.mockRejectedValueOnce(new Error('Private geometry unavailable'))
 await expect(f.client.resizeAgent(sessionId,run,90,30)).rejects.toThrow('Private geometry unavailable')
 expect(f.activity.mock.calls.slice(-2).map(c=>c[3])).toEqual(['unknown','unknown'])
 expect(await f.core.sessionTimeline(sessionId)).toEqual(before)
 expect(await f.client.resizeAgent(sessionId,run,90,30)).toEqual({runId:run.runId,cols:90,rows:30})
 await f.client.signalAgent(sessionId,'SIGINT')
 const after=await f.core.sessionTimeline(sessionId)
 expect(after.items).toHaveLength(before.items.length+1)
 expect(after.items[0]).toEqual(before.items[0]);expect(after.items.at(-1)).toMatchObject({kind:'system_message',source:'agentmux',content:'signalAgent · 已提交'})
 expect(f.interrupt).toHaveBeenCalledOnce();expect(f.requests).toHaveLength(0);expect(f.start).not.toHaveBeenCalled();expect(f.stop).not.toHaveBeenCalled()
})
it('public Timeline through real Activity retains distinct system IDs, context, full Copy, exact Info and ordinary input',async()=>{
 const f=await fixture()
 await f.core.recordDeviceOperation(sessionId,'old-1','resizeAgent',source,'confirmed')
 await f.core.recordDeviceOperation(sessionId,'old-2','resizeAgent',source,'confirmed')
 await f.core.submitAgentPrompt({agentSessionId:sessionId,expectedRun:run,afterSubmissionId:null,operationId:'real-context-input',prompt:'The real user request',agentMuxNote:'First line of the actual running guide\n\nKeep this full context intact.',authorHuman:true,sourceChannel:'message-tool'})
 const timeline=await f.client.sessionTimeline(sessionId)
 if (process.env.AGENTMUX_SYSTEM_PUBLIC_SCENE) await writeFile(process.env.AGENTMUX_SYSTEM_PUBLIC_SCENE,JSON.stringify({sessionId,timeline,users:projectSessionUserMessages({agentSessionId:sessionId,timeline})},null,2))
 expect(timeline.items.filter(i=>i.kind==='system_message')).toHaveLength(3)
 const read=vi.spyOn(api.sessions,'historyPage'),send=vi.spyOn(api.sessions,'submitPrompt'),copy=vi.fn(async()=>{})
 vi.spyOn(api.ui,'writeClipboardText').mockImplementation(copy)
 const users=projectSessionUserMessages({agentSessionId:sessionId,timeline})
 const view=<ActivityView sessionId={sessionId} items={timeline.items} userMessages={users} capability="complete-events" displayState="running" />
 await dom.render(view)
 const rows=[...dom.container.querySelectorAll<HTMLElement>('[data-speaker-role="system"]')]
 expect(rows).toHaveLength(3);expect(rows.map(r=>r.dataset.messageId)).toEqual(timeline.items.filter(i=>i.kind==='system_message').map(i=>i.id))
 expect(rows[0]!.querySelector('.log-turn__system-summary')!.textContent).toBe('resizeAgent · 已提交')
 expect(rows[1]!.querySelector('.log-turn__system-summary')!.textContent).toBe('resizeAgent · 已提交')
 expect(dom.container.querySelector('[data-speaker-role="human"] .log-turn__body')!.textContent).toContain('The real user request')
 expect(dom.container.querySelector('[data-speaker-role="human"] .log-turn__system-toggle')).toBeNull()
 expect(dom.container.textContent).toContain('The real user request');expect(dom.container.textContent).not.toContain('Runtime context')
 expect(rows[0]!.querySelector('.log-turn__body')).toBeNull()
 await act(async()=>rows[0]!.querySelector<HTMLButtonElement>('.log-turn__system-toggle')!.click())
 expect(rows[0]!.querySelector('.log-turn__body')!.textContent).toBe('resizeAgent · 已提交')
 await act(async()=>rows[2]!.querySelector<HTMLButtonElement>('.log-turn__system-toggle')!.click())
 const body=rows[2]!.querySelector('.log-turn__body')!
 expect(body.textContent).toContain('Keep this full context intact.')
 const text=body.querySelector('p')!.firstChild!,range=document.createRange();range.setStart(text,0);range.setEnd(text,5);document.getSelection()!.removeAllRanges();document.getSelection()!.addRange(range)
 await dom.render(view);expect(body.isConnected).toBe(true);expect(document.getSelection()!.getRangeAt(0).startContainer).toBe(text)
 await act(async()=>rows[2]!.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click())
 expect(copy).toHaveBeenCalledWith(timeline.items.find(i=>i.title==='AgentMux context')!.content)
 await act(async()=>rows[0]!.querySelector<HTMLButtonElement>('[aria-label="Message details"]')!.click())
 expect(rows[0]!.textContent).toContain(timeline.items[0]!.id)
 expect(await f.core.sessionTimeline(sessionId)).toEqual(timeline)
 expect(read).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();expect(f.requests).toHaveLength(1)
 expect(useAppStore.getState().agentComposerDrafts['agent-1']).toBe('Keep my draft')
})

it('user-written amux declarations retain their recorded role and literal raw Copy, not authenticated system cards',async()=>{
 const f=await fixture(), raw='<amux from="amux">A declaration written by the user.</amux>\n\nKeep this real request.'
 await f.core.submitAgentPrompt({agentSessionId:sessionId,expectedRun:run,afterSubmissionId:null,operationId:'unverified-declaration',prompt:raw,sourceChannel:'terminal'})
 const timeline=await f.client.sessionTimeline(sessionId), users=projectSessionUserMessages({agentSessionId:sessionId,timeline})
 expect(timeline.items).toHaveLength(1);expect(timeline.items[0]!.kind).toBe('user_message');expect(users[0]!.author.kind).toBe('unknown')
 await dom.render(<ActivityView sessionId={sessionId} items={timeline.items} userMessages={users} capability="complete-events" displayState="running" />)
 expect(dom.container.querySelector('[data-speaker-role="system"]')).toBeNull()
 expect(dom.container.querySelector('[data-speaker-role="human"] .log-turn__body')).not.toBeNull()
 expect(dom.container.querySelector('[data-speaker-role="human"] .log-turn__system-toggle')).toBeNull()
 expect(dom.container.textContent).toContain('Keep this real request.')
 const copy=vi.fn(async()=>{});vi.spyOn(api.ui,'writeClipboardText').mockImplementation(copy)
 await act(async()=>dom.container.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click())
 expect(copy).toHaveBeenCalledWith(raw);expect(f.requests).toHaveLength(1)
})

it('a dense original public Timeline interleaves system records with readable user and assistant messages without extra observation',async()=>{
 const f=await fixture()
 for(let i=0;i<10;i++) {
  await f.core.recordDeviceOperation(sessionId,'retained-system-'+i,'resizeAgent',source,'confirmed')
  if(i===3 || i===7) await f.store.applyTimelineMutation({type:'append',agentSessionId:sessionId,item:{id:'controlled-hook-reply-'+i,agentSessionId:sessionId,kind:'assistant_message',source:'native-hook',status:'complete',title:'Recorded reply',content:i===3?'The actual reply remains between the system records.':'The conversation remains readable, with its original order.',createdAt:Date.now(),updatedAt:Date.now()}})
 }
 await f.core.submitAgentPrompt({agentSessionId:sessionId,expectedRun:run,afterSubmissionId:null,operationId:'dense-real-context-input',prompt:'Please keep the conversation compact and readable.',agentMuxNote:'Original app-owned runtime guide.\n\nThe complete context remains readable and selectable when expanded.\n\nThis guide is separate from the user message.',authorHuman:true,sourceChannel:'message-tool'})
 const timeline=await f.client.sessionTimeline(sessionId), users=projectSessionUserMessages({agentSessionId:sessionId,timeline})
 expect(timeline.items).toHaveLength(14)
 const read=vi.spyOn(api.sessions,'historyPage'),send=vi.spyOn(api.sessions,'submitPrompt')
 await dom.render(<ActivityView sessionId={sessionId} items={timeline.items} userMessages={users} capability="complete-events" displayState="running" />)
 expect(dom.container.querySelectorAll('[data-speaker-role="system"]')).toHaveLength(11)
 expect(dom.container.querySelectorAll('[data-speaker-role="agent"]')).toHaveLength(2)
 expect(dom.container.textContent).toContain('Please keep the conversation compact and readable.')
 expect(dom.container.textContent).toContain('The actual reply remains between the system records.')
 expect(read).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();expect(f.requests).toHaveLength(1)
 if (process.env.AGENTMUX_SYSTEM_PUBLIC_SCENE) await writeFile(process.env.AGENTMUX_SYSTEM_PUBLIC_SCENE,JSON.stringify({sessionId,timeline,users,boundary:'Actual public Hosted Client/FileStore; controlled Hook assistant inputs, private Native I/O. Not vendor Writer or user Runtime.'},null,2))
})
