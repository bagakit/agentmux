// @vitest-environment happy-dom
import { createHash } from 'node:crypto'
import { act, type ReactNode, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage, AgentTimelineItem } from '@agentmux/core'
import { projectConversationReading } from '@agentmux/client-ui/conversation-records'
import { conversationSourcePresenter } from '@agentmux/client-ui/conversation-sources'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { ClientUiProvider, type ClientUiPlatform } from '@agentmux/client-ui/platform'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { FocusHistorySearch } from '../src/renderer/src/components/FocusHistorySearch'
import { focusHistoryHitKey, type FocusHistoryHit } from '../src/renderer/src/lib/use-focus-history-search'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

const sid='source-label-session', source={providerId:'codex',nativeSessionId:'source-label-native'}
const native=(id='native', contentParts:AgentSessionHistoryPage['items'][number]['contentParts']=[{kind:'text',text:'Original native body'}])=>({id,kind:'assistant-message' as const,contentParts,conversation:{nativeInvocationScope:{source,subject:'main' as const,scope:{kind:'turn' as const,nativeTurnId:'turn'}}}})
const captured=(id='hook',more:Partial<AgentTimelineItem>={}):AgentTimelineItem=>({id,agentSessionId:sid,kind:'assistant_message',source:'native-hook',status:'complete',createdAt:_historyFixtureEpoch(0, 0, 1),updatedAt:_historyFixtureEpoch(0, 0, 1),title:'Recorded source',content:'Original Hook body',...more})
const page=(items:AgentSessionHistoryPage['items']=[native()]):AgentSessionHistoryPage=>({agentSessionId:sid,sourceHostId:'local',source,items,nextCursor:null})
const timeline=(items:AgentTimelineItem[], sourceHostId='local')=>({agentSessionId:sid,sourceHostId,revision:1,items})
const ref=(id='native')=>({hostId:'local',agentSessionId:sid,source:{kind:'native' as const,...source,recordId:id}})
const platform:ClientUiPlatform={copyText:async()=>true,overlayContainer:()=>document.body,bindComposerFocus:()=>()=>{},renderMessageAvatar:()=>null,renderProjectIcon:()=>null,renderProjectLabel:()=>null,renderIcon:()=>null}
let host:HTMLDivElement,root:Root
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});host=document.createElement('div');document.body.append(host);root=createRoot(host)})
afterEach(async()=>{await act(async()=>root.unmount());host.remove();getSelection()?.removeAllRanges();vi.restoreAllMocks();vi.unstubAllGlobals()})
const render=async(body:ReactNode)=>act(async()=>root.render(<ClientUiProvider platform={platform}>{body}</ClientUiProvider>))
const labels=(node:ParentNode)=>[...node.querySelectorAll<HTMLElement>('[data-conversation-source]')].map(n=>n.dataset.conversationSource)

it('one confirmed multi-source card shows every contributing label and retains original details and complete Copy',async()=>{
 const item=captured('hook',{conversation:{sameEvent:ref()}}),copy=vi.spyOn(platform,'copyText').mockResolvedValue(true)
 await render(<ConversationView sessionId={sid} executionHostId="remote-route" page={page()} timeline={timeline([item])}/>)
 expect(host.querySelectorAll('[data-conversation-event-id]')).toHaveLength(1)
 const main=host.querySelector('.log-turn')!;expect(new Set(labels(main.querySelector('.log-turn__meta')!))).toEqual(new Set(['native','native-hook']))
 expect(main.textContent).toContain('原生对话');expect(main.textContent).not.toContain('Terminal')
 await act(async()=>main.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click());expect(copy.mock.calls.at(-1)?.[0]).toBe('Original native body')
 const detail=host.querySelector<HTMLDetailsElement>('[data-original-contribution]')!;await act(async()=>{detail.open=true;detail.dispatchEvent(new Event('toggle'))})
 expect(detail.textContent).toContain('Original Hook body')
 const observed=detail.querySelector<HTMLButtonElement>('[data-captured-reply-observation] button[aria-expanded]')!
 expect(observed).not.toBeNull();await act(async()=>observed.click())
 expect(labels(detail.querySelector('.log-turn__meta')!)).toEqual(['native-hook'])
 await act(async()=>detail.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click());expect(copy.mock.calls.at(-1)?.[0]).toBe('Original Hook body')
})

it('equal text and bare IDs stay independent with explicit unconfirmed source relationships and no claimed adoption',async()=>{
 const item=captured('native',{kind:'user_message',source:'user',authorHuman:true,content:'Equal original input'})
 const p=page([{...native('native',[{kind:'text',text:item.content!}]),kind:'user-message' as never}])
 await render(<ConversationView sessionId={sid} executionHostId="remote-route" page={p} timeline={timeline([item])}/>)
 expect(host.querySelectorAll('[data-conversation-event-id]')).toHaveLength(2)
 expect(labels(host)).toContain('native');expect(labels(host)).toContain('user');expect(host.textContent).toContain('跨来源关联未确认')
 expect([...host.querySelectorAll('.log-turn__body')].map(n=>n.textContent)).toEqual(['Equal original input','Equal original input'])
 expect(host.textContent).not.toContain('Terminal');expect(host.textContent).not.toContain('adopted')
})

it('the shared source mapping exhausts all captured evidence origins without authenticating an author or a channel',async()=>{
 const kinds=['native-hook','native-transcript','terminal-output','run-process','acp','user','agentmux'] as const
 await render(<ConversationView sessionId={sid} page={page([])} timeline={timeline(kinds.map((source,index)=>captured('source-'+index,{source})))}/>)
 expect(new Set(labels(host))).toEqual(new Set(kinds))
 for(const text of ['Hook','原生记录观察','终端输出观察','进程观察','ACP','AgentMux 提交记录','AgentMux'])expect(host.textContent).toContain(text)
})

const call={kind:'tool-call' as const,callId:'same-call',name:'Read',input:'{"path":"document.txt"}'}
const invocation={source,subject:'main' as const,scope:{kind:'turn' as const,nativeTurnId:'turn'},callId:call.callId}
const hookTool=(different:Partial<import('@agentmux/core/conversation').ConversationInvocation>={})=>captured('hook-tool',{kind:'tool_call',content:'Original process prose',toolInput:'Original input',toolOutput:'Original output',conversation:{invocations:[{selector:{kind:'captured-field',field:'toolInput'},invocation:{...invocation,...different}}]}})
it.each(['shared','desktop'])('exact cross-event invocation labels apply only to the corresponding parts in the actual %s trace consumers',async surface=>{
 const p=page([native('native',[call,{...call,callId:'unrelated-call',name:'Other',input:'Other original input'}])]),t=timeline([hookTool()])
 await render(surface==='shared'?<ConversationView sessionId={sid} executionHostId="remote-route" page={p} timeline={t}/>:<ActivityView sessionId={sid} executionHostId="remote-route" capability="complete-events" items={t.items} timelineSnapshot={t} nativeHistoryPage={p}/>)
 const traces=host.querySelectorAll('.conversation-tool-trace');expect(traces).toHaveLength(2)
 expect(new Set(labels(traces[0]!))).toEqual(new Set(['native','native-hook']));expect(labels(traces[1]!)).toEqual(['native'])
 for(const head of host.querySelectorAll<HTMLButtonElement>('.wf-head'))if(head.getAttribute('aria-expanded')==='false')await act(async()=>head.click())
 const recorded=host.querySelector<HTMLElement>('[data-captured-process-id="hook-tool"], [data-message-source-key*="hook-tool"]')!
 expect(recorded).not.toBeNull()
 const step=[...recorded.querySelectorAll<HTMLButtonElement>('button')].find(n=>n.hasAttribute('aria-expanded'))!;await act(async()=>step.click())
 expect(recorded.textContent).toContain('Original output');expect(recorded.textContent).toContain('Hook')
 const output=recorded.querySelector('[aria-label="Copy tool output"]')!.parentElement!.parentElement!
 expect(output.textContent).toContain('Original output');expect(labels(output)).not.toContain('native')
})

it.each(['turn','actor','source','host'])('equal bare call IDs do not spread labels across a different %s',async kind=>{
 const different=kind==='turn'?{scope:{kind:'turn' as const,nativeTurnId:'different-turn'}}:kind==='actor'?{subject:{kind:'child' as const,nativeActorId:'main'}}:kind==='source'?{source:{...source,nativeSessionId:'other-native'}}:{}
 await render(<ConversationView sessionId={sid} executionHostId="remote-route" page={page([native('native',[call])])} timeline={timeline([hookTool(different)],kind==='host'?'other-source-host':'local')}/>)
 const trace=host.querySelector('.conversation-tool-trace')!;expect(labels(trace)).toEqual(['native'])
})

it('a deferred resource trace keeps its original selector source after complete reconstruction without extra reads',async()=>{
 const tool={...call,input:'Complete deferred 原文'},bytes=Buffer.from(JSON.stringify(tool)),sha256=createHash('sha256').update(bytes).digest('hex')
 const part={kind:'resource' as const,resourceType:'text' as const,reference:'opaque:original-tool',content:{encoding:'json-utf8' as const,kind:'tool-call' as const,byteLength:bytes.length,sha256}}
 const read=vi.fn(async(input:import('@agentmux/core').AgentSessionHistoryResourceRequest)=>({agentSessionId:sid,source,recordId:'native',partIndex:1,reference:part.reference,result:{status:'fragment' as const,encoding:'json-utf8' as const,dataBase64:bytes.toString('base64'),byteLength:bytes.length,offsetBytes:0,totalBytes:bytes.length,sha256,nextOffsetBytes:null}}))
 await render(<ConversationView sessionId={sid} page={page([native('native',[{kind:'text',text:'Original intro'},part])])} readHistoryResource={read}/>)
 expect(read).not.toHaveBeenCalled();await act(async()=>[...host.querySelectorAll('button')].find(n=>n.textContent?.includes('Read complete content'))!.click())
 const trace=host.querySelector('.conversation-resource-text .conversation-tool-trace')!;expect(trace).not.toBeNull();expect(labels(trace)).toEqual(['native'])
 expect(read).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({source,recordId:'native',partIndex:1,expectedReference:part.reference}))
})


it.each(['unread','newer-version'])('an exact related target with %s inventory does not borrow its source or read another record',async condition=>{
 const reading=projectConversationReading({agentSessionId:sid,executionHostId:'remote-route',historyPage:page([native('native',[call])]),timeline:timeline([hookTool()])})
 const record=reading.records.find(record=>record.original.kind==='native')!
 const inventory=reading.timeline.records.flatMap(source=>source.original.kind==='native'?[source]:condition==='unread'?[]:[{...source,revision:'newer-retained-version'}])
 const present=conversationSourcePresenter({...reading.timeline,records:inventory})
 await render(<ConversationMessage content={record.contentParts} sources={present(record)} conversationEvent={record.event!} messageId={record.id}/>)
 const trace=host.querySelector('.conversation-tool-trace')!;expect(trace).not.toBeNull();expect(labels(trace)).toEqual(['native'])
 expect(trace.querySelector('[data-conversation-source-unread]')).not.toBeNull();expect(trace.textContent).toContain('关联来源未读')
})

it('actual expanded Focus search results use the same labels while preserving independently read original hits',async()=>{
 const hits:FocusHistoryHit[]=[
  {reference:{hostId:'remote-route',sourceHostId:'local',agentSessionId:sid,source:'native'},nativeSource:source,entry:{kind:'item',item:native()}},
  {reference:{hostId:'remote-route',sourceHostId:'local',agentSessionId:sid,source:'captured'},entry:{kind:'item',item:captured()}}
 ]
 const search={result:{confirmed:true,matched:2,trimmed:0,query:'Original',label:'Original',input:{mode:'history' as const,query:'Original'},nextCursor:null,remaining:0,total:2,completed:2,examined:2,hits,issues:[],loading:false},start:vi.fn(),more:vi.fn(),cancel:vi.fn(),expandedKey:focusHistoryHitKey(hits[0]!),expand:vi.fn(),retainForLocalQuery:vi.fn()} satisfies ComponentProps<typeof FocusHistorySearch>['search']
 await render(<FocusHistorySearch search={search}/>);expect(labels(host.querySelector('.log-turn')!)).toEqual(['native']);expect(host.textContent).toContain('Original native body')
 await render(<FocusHistorySearch search={{...search,expandedKey:focusHistoryHitKey(hits[1]!)}}/>);expect(labels(host.querySelector('.log-turn')!)).toEqual(['native-hook']);expect(host.textContent).toContain('Original Hook body')
 expect(search.more).not.toHaveBeenCalled();expect(search.start).not.toHaveBeenCalled()
})
