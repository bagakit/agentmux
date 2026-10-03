import { fixtureIso as _hygiene_fixtureIso, fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, agentPromptCondition, type AgentMessageChannel, type AgentOperationDevice, type AgentSessionHistoryPage, type AgentSessionUserMessage } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { describeConversationInputSource } from '@agentmux/client-ui/conversation-input-source'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { SessionHistoryView } from '../src/renderer/src/components/SessionHistoryView'
import { FocusMessagePreview } from '../src/renderer/src/components/FocusMessagePreview'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'
import { reactionPublicClientFixture } from './helpers/reaction-public-client-fixture'
import type { FocusContext } from '../src/renderer/src/lib/focus-context'

vi.mock('../src/renderer/src/components/WindowOverlayHost',async importOriginal=>({...await importOriginal<typeof import('../src/renderer/src/components/WindowOverlayHost')>(),WindowOverlayPortal:({children}:{children:import('react').ReactNode})=>children}))
vi.mock('@floating-ui/dom',()=>({autoUpdate:()=>()=>{},computePosition:async()=>({x:0,y:0}),offset:()=>({}),shift:()=>({}),size:()=>({})}))
const dom=composerDOM()
const channelLabels:Record<AgentMessageChannel,string>={terminal:'Terminal','message-tool':'Message Tool',cli:'CLI',api:'API','agent-message':'Agent message',reaction:'快捷回复'}
const sender:AgentOperationDevice={hostId:'source-host',deviceId:'device-local',name:'This Mac'}
const receivingHost='execution-host'
const describeSpeaker=()=>({name:'Builder',providerId:'claude' as const})
let flow:Awaited<ReturnType<typeof reactionPublicClientFixture>>
let native:{client:AgentMuxClient;root:string;page:AgentSessionHistoryPage;zero:()=>void}
const channels=Object.keys(channelLabels) as AgentMessageChannel[]
async function submit(channel:AgentMessageChannel,device=sender){
 const before=agentPromptCondition(flow.client.agentSession('agent-1'))
 await flow.client.submitAgentPrompt({agentSessionId:'agent-1',operationId:`origin-${channel}-${device.deviceId}`,prompt:`Original ${channel} text`,...before,...(before.afterSubmissionId===null?{}:{allowUncertainTurn:true}),authorHuman:true,sourceChannel:channel,sourceDevice:device})
 const reloaded=new AgentMuxFileAgentSessionStore(flow.store.path)
 const timeline=await reloaded.loadTimeline('agent-1')
 const messages=projectSessionUserMessages({agentSessionId:'agent-1',timeline})
 const message=messages.find(item=>item.source.kind==='captured'&&item.source.channel===channel&&item.source.device?.deviceId===device.deviceId)!
 expect(message,'Nonempty actual durable projected input').toBeDefined()
 return{message,timeline}
}
async function createNative(){
 const root=await mkdtemp(join(tmpdir(),'input-origin-native-')),path=join(root,'native.jsonl')
 await writeFile(path,[{sessionId:'native-source',uuid:'original-user',type:'user',message:{role:'user',content:'Terminal text is not device evidence'},timestamp:_hygiene_fixtureIso(24138000000, "second")},{sessionId:'native-source',uuid:'original-reply',type:'assistant',message:{role:'assistant',content:'Original answer'},timestamp:_hygiene_fixtureIso(24138001000, "second")}].map(item=>JSON.stringify(item)).join('\n')+'\n')
 const store=new AgentMuxFileAgentSessionStore(join(root,'sessions.json'))
 await store.compareAndSwap(null,{kind:'agent',agentSessionId:'native-agent',providerId:'claude',executorId:'claude',hostId:receivingHost,workspacePath:root,run:{runId:'native-run'},retiredRuns:[],hookBindingId:'binding',hookToken:'token',createdAt:1,updatedAt:1,nativeHandle:{kind:'provider',providerId:'claude',sessionId:'native-source',transcriptPath:path}})
 const client=new AgentMuxClient({store})
 const inner=client as unknown as{registry:{load(host:string):Promise<void>};kernel:Record<string,()=>unknown>}
 await inner.registry.load(receivingHost)
 const controls=['connect','start','input','resize','stop','attach','status'].map(name=>vi.spyOn(inner.kernel,name).mockImplementation(()=>{throw new Error('Unexpected Runtime control in origin reader')}))
 const page=await client.sessionHistoryPage('native-agent')
 expect(page.items).toHaveLength(2)
 return{client,root,page,zero:()=>expect(controls.map(spy=>spy.mock.calls.length)).toEqual([0,0,0,0,0,0,0])}
}
beforeEach(async()=>{flow=await reactionPublicClientFixture('agent-1','run-agent-1');native=await createNative();vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}})})
afterEach(async()=>{native.zero();await native.client.dispose();await rm(native.root,{recursive:true});await flow.close()})
function fact(root:Element,label:string){const dt=[...root.querySelectorAll('dt')].find(node=>node.textContent===label);expect(dt,`Nonempty origin field ${label}`).toBeDefined();return dt!.nextElementSibling!.textContent}
async function openInfo(){await dom.click('[aria-label="Message details"]')}
function card(message:AgentSessionUserMessage,executionHostId:string|undefined=receivingHost){return <ConversationMessage messageId={message.id} conversationSessionId="agent-1" content={message.contentParts} speaker={{role:'human',id:'human'}} inputSource={message.source} {...(executionHostId===undefined?{}:{executionHostId})}/>}

describe('One recorded input origin across common reading surfaces',()=>{
 for(const channel of channels)it(`renders durable public ${channel} origin without attributing the receiving Host as sender`,async()=>{
  const{message}=await submit(channel)
  await dom.render(card(message));expect(dom.container.querySelector('.log-turn__input-source')!.textContent).toContain(`${channelLabels[channel]} · This Mac`)
  await openInfo()
  expect(fact(dom.container,'输入渠道')).toBe(channelLabels[channel]);expect(fact(dom.container,'发送设备')).toBe('This Mac');expect(fact(dom.container,'设备 ID')).toBe('device-local');expect(fact(dom.container,'来源 Host')).toBe('source-host');expect(fact(dom.container,'当前执行 Host')).toBe(receivingHost)
 })
 it('keeps same-name local and remote device IDs and origin Hosts distinct',async()=>{
  const a=await submit('cli'),b=await submit('api',{hostId:'remote-source-host',deviceId:'device-remote',name:sender.name})
  await dom.render(<>{card(a.message)}{card(b.message)}</>)
  const cards=dom.container.querySelectorAll('.log-turn');expect(cards).toHaveLength(2)
  for(const root of cards)await act(async()=>root.querySelector<HTMLButtonElement>('[aria-label="Message details"]')!.click())
  expect([...cards].map(root=>fact(root,'设备 ID'))).toEqual(['device-local','device-remote'])
  expect([...cards].map(root=>fact(root,'来源 Host'))).toEqual(['source-host','remote-source-host'])
  expect([...cards].map(root=>fact(root,'当前执行 Host'))).toEqual([receivingHost,receivingHost])
 })
 it('does not manufacture Terminal or device facts from a production native user record',async()=>{
  const message=projectSessionUserMessages({agentSessionId:'native-agent',historyPage:native.page})[0]!
  expect(message.author).toEqual({kind:'unknown'});expect(message.source.kind).toBe('native')
  await dom.render(<ConversationView page={native.page} sessionId="native-agent" executionHostId={receivingHost}/>)
  expect(dom.container.querySelector('.log-turn__input-source')!.textContent).toBe('原生记录 · 来源未记录')
  await openInfo();expect(fact(dom.container,'输入渠道')).toBe('渠道未记录');expect(fact(dom.container,'发送设备')).toBe('未记录');expect(fact(dom.container,'来源 Host')).toBe('未记录');expect(fact(dom.container,'当前执行 Host')).toBe(receivingHost)
 })
 it('keeps legacy missing channel and device unknown with no receiver fallback or extra IO',async()=>{
  await dom.render(<ConversationMessage messageId="legacy" speaker={{role:'unknown',id:'legacy-author'}} content="Original legacy text" inputSource={{kind:'captured',submissionId:'legacy'}} />)
  expect(dom.container.querySelector('.log-turn__input-source')!.textContent).toBe('渠道未记录 · 设备未记录')
  await openInfo();expect(fact(dom.container,'当前执行 Host')).toBe('未知');expect(fact(dom.container,'设备 ID')).toBe('未记录')
 })
 it('forwards exact Core channel metadata through both actual Activity paths',async()=>{
  const{message,timeline}=await submit('message-tool')
  const props={sessionId:'agent-1',executionHostId:receivingHost,capability:'complete-events' as const}
  await dom.render(<ActivityView {...props} items={[]} userMessages={[message]}/>);await openInfo();expect(fact(dom.container,'输入渠道')).toBe('Message Tool')
  await dom.render(<ActivityView {...props} items={timeline.items}/>);await openInfo();expect(fact(dom.container,'输入渠道')).toBe('Message Tool');expect(fact(dom.container,'来源 Host')).toBe('source-host');expect(fact(dom.container,'当前执行 Host')).toBe(receivingHost)
 })
 it('keeps native origin honest through actual History, retaining the existing hidden read gate',async()=>{
  const read=vi.spyOn(api.sessions,'historyPage').mockImplementation(async()=>native.page)
  const props={control:{hostId:receivingHost,agentSessionId:'native-agent'},label:'Original history',workspaceRoot:'',openWorkspaceFile:vi.fn(),openHttpLink:vi.fn()}
  await dom.render(<SessionHistoryView {...props} visible={false}/>);expect(read).not.toHaveBeenCalled()
  await dom.render(<SessionHistoryView {...props} visible/>);await vi.waitFor(()=>expect(dom.container.querySelectorAll('[data-native-record-id]')).toHaveLength(2))
  await openInfo();expect(fact(dom.container,'当前执行 Host')).toBe(receivingHost);expect(fact(dom.container,'输入渠道')).toBe('渠道未记录')
  const body=dom.container.querySelector('.log-turn__text')!
  await dom.render(<SessionHistoryView {...props} visible={false}/>);expect(dom.container.querySelector('.log-turn__text')).toBe(body);expect(read).toHaveBeenCalledTimes(1)
 })
 it('passes public input origin and the receiving Context through actual Focus without a reader',async()=>{
  const{message}=await submit('api')
  const read=vi.spyOn(api.sessions,'historyPage')
  const recipient:FocusContext={id:'agent-1',hostId:receivingHost,name:'Builder',detail:'Original',state:'running',stateLabel:'Running',processState:'running',bucket:'working',kind:'agent',providerId:'claude',topicId:null,workspaceId:'project',workspaceName:'Project',workspacePath:_hygiene_fixturePath("repo"),liveAgent:true,actionable:true,lastActivityAt:null,runId:'run-agent-1',workingEnteredAt:null,workspace:undefined,recap:null,detailIsRecap:false}
  const anchor=document.createElement('button'),frame=document.createElement('div');frame.className='recent-focus';const header=document.createElement('div');header.className='recent-focus__header';frame.append(header,anchor);document.body.append(frame)
  try{await dom.render(<FocusMessagePreview message={message} sender={undefined} recipient={recipient} lane={undefined} hierarchy={undefined} interactive anchor={anchor} describeSpeaker={describeSpeaker} onSelect={()=>{}} onClose={()=>{}}/>);await openInfo();expect(fact(dom.container,'输入渠道')).toBe('API');expect(fact(dom.container,'来源 Host')).toBe('source-host');expect(fact(dom.container,'当前执行 Host')).toBe(receivingHost);expect(read).not.toHaveBeenCalled()}finally{frame.remove()}
 })
 it('preserves the original body, Range and draft through details and unrelated output',async()=>{
  const{message}=await submit('terminal');await dom.render(card(message))
  const body=dom.container.querySelector('.log-turn__text')!,text=body.firstChild!.firstChild!,range=document.createRange();range.setStart(text,0);range.setEnd(text,8);const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range)
  const before=selection.toString();expect(before).toBe('Original')
  await openInfo();expect(dom.container.querySelector('.log-turn__text')).toBe(body);expect(selection.toString()).toBe(before)
  await dom.render(<>{card(message)}<ConversationMessage messageId="unrelated" content="Unrelated output"/></>);expect(dom.container.querySelector('.log-turn__text')).toBe(body);expect(selection.toString()).toBe(before);expect(dom.draft()).toBe('Keep my draft')
 })
 it('keeps incoming Agent provenance visible and system origin only inside Info',async()=>{
  const{message}=await submit('agent-message')
  await dom.render(<ConversationMessage messageId={message.id} conversationSessionId="recipient" content="Other Agent original" speaker={{role:'agent',id:'sender-agent'}} inputSource={message.source}/>);expect(dom.container.querySelector('.log-turn__input-source'),'Incoming Agent origin remains visible').not.toBeNull();expect(dom.container.querySelector('.log-turn__input-source')!.textContent).toContain('Agent message')
  await dom.render(<ConversationMessage messageId="system" content="Original app-owned context" speaker={{role:'system',id:'agentmux'}} inputSource={message.source}/>);expect(dom.container.querySelector('.log-turn__input-source')).toBeNull()
 })
 it('emits nonempty public accepted input and production native records for the compiled scene',async()=>{
  const local=await submit('terminal')
  const remote=await submit('message-tool',{hostId:'remote-authority',deviceId:'remote-workstation-7',name:'Remote development workstation with an intentionally long label'})
  const reaction=await submit('reaction')
  const original=await native.client.sessionHistoryPage('native-agent')
  expect(original.items).toHaveLength(2);expect(local.message.source.kind).toBe('captured');expect(remote.message.source.kind).toBe('captured')
  if(process.env.AGENTMUX_INPUT_ORIGIN_SCENE)await writeFile(process.env.AGENTMUX_INPUT_ORIGIN_SCENE,JSON.stringify({kind:'actual-public-input-origin-scene',messages:[local.message,remote.message,reaction.message],page:original,receiverHost:receivingHost,conditions:'Public Client admission/private durable FileStore/projector and production Claude reader; controlled PTY and declared source-device input, not actual OS writer or installed App.'},null,2)+'\n')
 })
 it('uses one pure formatter without changing the public source facts',async()=>{
  const{message}=await submit('cli'),before=JSON.stringify(message.source)
  expect(describeConversationInputSource(message.source).title).toContain('device-local');expect(JSON.stringify(message.source)).toBe(before)
 })
})
