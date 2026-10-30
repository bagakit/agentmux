// @vitest-environment happy-dom
import { act } from 'react'
import { appendFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(()=>vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__',true))
vi.mock('react-resizable-panels',async()=>{const {createRequire}=await import('node:module');return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')})
vi.mock('../src/renderer/src/components/TerminalView',()=>({TerminalView:()=> <div>Controlled terminal rendering</div>}))
vi.mock('../src/renderer/src/lib/reading-diagnostic-publication',()=>({publishReadingDiagnostic:()=>{}}))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { feishuPayload } from '../../../packages/connectors/test/fixtures/feishu'
import { parseConnectionParams,parseConnectionResult,connectionDiagnosisActorKey,groupTarget } from '../../../packages/core/src/connections'
import * as core from '../../../packages/core/src/index'
import { hostedTestOwner } from '../../../packages/core/test/helpers/hosted-runtime-port'
import { objectCliEnvironment,runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'

let effects=0,lose=false
beforeEach(()=>{effects=0;lose=false})
const f=connectorJourneyFixture({publication:true,ingress:true,conversationAuthority:{resolveConversationMessage:input=>f.services.ingress!.recordAuthority(input)},platform:async request=>{
 if(request.url?.endsWith('/messages')){if(lose)throw Error('Controlled original platform response loss');return {code:0,data:{message_id:'om_status_'+ ++effects,chat_id:'status-room',msg_type:'interactive'}}}
 if(request.url?.endsWith('/members'))return {code:0,data:{items:[{member_id_type:'open_id',member_id:'original-external-user',name:'Ada'},{member_id_type:'open_id',member_id:'status-lin',name:'Lin'}],has_more:true,page_token:'more-native-members'}}
 return {code:0,data:{name:'Actual status group',chat_status:'normal',chat_mode:'group'}}
}})
const wait=(check:()=>unknown|Promise<unknown>)=>vi.waitFor(async()=>{await act(async()=>{});await check()},{timeout:10000,interval:25})
const facts=(value:unknown)=>{if(process.env.CONNECTOR_STATUS_FACTS)appendFileSync(process.env.CONNECTOR_STATUS_FACTS,JSON.stringify({case:expect.getState().currentTestName,value})+'\n')}
async function bind(){
 const original=(await f.forward('connection.inspect',{connectionId:f.config.connectionId})).connection!
 await f.forward('connection.configure',{operationId:'status-config-label',expectedRevision:original.revision,connection:{...original.config,label:'Actual status bot'}})
 const configured=(await f.forward('connection.inspect',{connectionId:f.config.connectionId})).connection!
 const result=await f.forward('connection.bind',{...f.original.input,operationId:'status-bind',bindingId:'status-original',connectionId:f.config.connectionId,expectedConnectionRevision:configured.revision,externalConversationId:'status-room'},f.hostingTarget)
 expect(result.state).toBe('applied');if(result.state!=='applied')throw Error('Original status Binding required')
 const binding=result.binding,actor={application:binding.application,idType:'open_id',userId:'original-external-user'}
 await f.forward('connection.grant',{operationId:'status-ada',bindingId:binding.bindingId,expectedBindingRevision:binding.revision,grantId:'status-ada',expectedRevision:null,actor,capabilities:['input','answer'],state:'active'},f.hostingTarget)
 await wait(async()=>expect((await f.forward('connection.inspect',{connectionId:f.config.connectionId})).connection?.receiver?.state).toBe('ready'))
 return {binding,actor,configured}
}
const query=(binding:Awaited<ReturnType<typeof bind>>['binding'],activity=true)=>({executionHostId:binding.executionHostId,agentSessionId:binding.agentSessionId,bindingId:binding.bindingId,bindingRevision:binding.revision,...(activity?{activity:true as const}:{})})
async function incoming(binding:Awaited<ReturnType<typeof bind>>['binding'],id:string){const payload=feishuPayload({message_id:id,chat_id:binding.externalConversationId});payload.header.event_id=id+'-event';await f.ingressTransport!.receive(payload);return payload}
const native=(id:string)=>JSON.stringify({sessionId:'original-native',uuid:id,type:'assistant',message:{role:'assistant',content:[{type:'text',text:'Actual original reply '+id}]}})+'\n'

it('actual SDK custody and platform confirmation reach the opt-in diagnosis and mounted status popup with exact group members',async()=>{
 const {binding,actor,configured}=await bind();expect(configured.revision).not.toBe(binding.revision)
 const payload=await incoming(binding,'status-first-message')
 const saved=(await f.forward('connection.ingress.ls',{connectionId:binding.connectionId})).ingresses.find(row=>row.kind!=='action'&&row.externalMessageId==='status-first-message')!
 expect(saved.kind).not.toBe('action');if(saved.kind==='action')throw Error('Original message required');expect(saved.receivedAt).toBeGreaterThan(1)
 payload.header.event_id='status-duplicate-event';await f.ingressTransport!.receive(payload)
 expect((await f.forward('connection.ingress.inspect',{ingressId:saved.ingressId})).ingress).toMatchObject({receivedAt:saved.receivedAt})
 const ordinary=await f.forward('connection.diagnose',query(binding,false));expect(ordinary.groups.value!.items[0]).not.toHaveProperty('activity')
 await appendFile(f.original.transcript,native('status-reply'));f.services.publication!.refresh()
 await wait(()=>expect(f.services.publication!.store.list(binding).some(row=>row.reference.source.kind==='native'&&row.state==='confirmed')).toBe(true))
 const operation=f.services.publication!.store.list(binding).find(row=>row.reference.source.kind==='native'&&row.state==='confirmed')!
 expect(operation.receiptObservedAt).toBeGreaterThan(1)
 const repeated=f.services.publication!.store.settle(operation.operationId,operation.attempt!,operation.receipt!)
 expect(repeated.receiptObservedAt).toBe(operation.receiptObservedAt)
 const report=await f.forward('connection.diagnose',query(binding)),activity=report.groups.value!.items[0]!.activity!
 expect(activity.incoming.value).toMatchObject({included:1,latest:{ingressId:saved.ingressId,receivedAt:saved.receivedAt},actors:[{actorKey:connectionDiagnosisActorKey(groupTarget(binding),actor),messages:1}]})
 expect(activity.outgoing.value?.latest).toMatchObject({operationId:operation.operationId,receipt:'confirmed',receiptObservedAt:operation.receiptObservedAt})
 expect(JSON.stringify(report)).not.toContain('original-external-user')
 useAppStore.setState({agentComposerDrafts:{[binding.agentSessionId]:'Keep the original status draft'}})
 await f.mount();const trigger=()=>document.querySelector<HTMLButtonElement>('[data-channel-entry=feishu]')!
 await wait(()=>expect(trigger()).not.toBeNull());await act(async()=>{trigger().focus();trigger().dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))})
 const popup=()=>document.querySelector<HTMLElement>('[data-group-status="status-original"]')!
 await wait(()=>expect(popup(),'actual selected group status is mounted').not.toBeNull())
 await wait(()=>expect(popup().textContent).toContain('Ada'))
 expect(popup().textContent).toContain('Chat, Answer');expect(popup().textContent).toContain('more members');expect(popup().textContent).toContain('1 recent messages recorded here')
 expect([...popup().querySelectorAll('time')].map(node=>node.dateTime)).toContain(new Date(saved.receivedAt!).toISOString())
 expect(popup().querySelector('.connector-connection-overview')).toBeNull();expect(popup().textContent).not.toContain('Check status')
 expect(f.calls.some(call=>call.method==='connection.room.members'&&(call.input as any).expectedConnectionRevision===configured.revision)).toBe(true)
 await act(async()=>{trigger().dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))})
 await f.dom.render(null)
 const paused=await f.forward('connection.binding.pause',{operationId:'popup-group-pause',bindingId:binding.bindingId,expectedRevision:binding.revision});expect(paused.state).toBe('applied')
 await f.mount();await wait(()=>expect(trigger()).not.toBeNull());await act(async()=>{trigger().focus();trigger().dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))})
 await wait(()=>expect(popup()?.textContent).toContain('Review group sync'))
 expect(trigger().dataset.channelState).toBe('paused')
 await act(async()=>popup().querySelector<HTMLButtonElement>('.primary-button')!.click())
 await wait(()=>expect(document.querySelector('[role=tab][aria-controls$="-sharing-panel"]')?.getAttribute('aria-selected')).toBe('true'))
 expect(document.querySelector('.connector-header-menu')).toBeNull()
 await f.button('Close');await f.dom.render(null)
 const policy=await f.forward('connection.service.get',{})
 await f.forward('connection.service.configure',{operationId:'popup-sync-off',expectedRevision:policy.revision,service:{enabled:false}})
 // Controlled native observation for the valid ready+off combination; policy,
 // routing and the original settings UI remain actual public-owner consumers.
 const inspect=f.services.connections.inspect.bind(f.services.connections)
 vi.spyOn(f.services.connections,'inspect').mockImplementation(async input=>{const result=await inspect(input);return {...result,connection:result.connection?{...result.connection,receiver:{ref:result.connection.receiver?.ref??'original-ui-observation',state:'ready' as const},observation:{...result.connection.observation,transport:{state:'ready' as const}}}:null}})
 await f.mount();await wait(()=>expect(trigger()).not.toBeNull());await act(async()=>{trigger().focus();trigger().dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))})
 await wait(()=>expect(popup()?.textContent).toContain('Review automatic sync'))
 expect(trigger().dataset.channelState).toBe('off')
 await act(async()=>popup().querySelector<HTMLButtonElement>('.primary-button')!.click())
 await wait(()=>expect(document.querySelector('[role=tab][aria-controls$="-diagnostics-panel"]')?.getAttribute('aria-selected')).toBe('true'))
 await wait(()=>expect((document.activeElement as HTMLElement)?.dataset.connectionSection).toBe('sync'))
 expect(document.querySelector('.connector-header-menu')).toBeNull()
 expect(useAppStore.getState().agentComposerDrafts[binding.agentSessionId]).toBe('Keep the original status draft')
 facts({receivedAt:saved.receivedAt,receiptObservedAt:operation.receiptObservedAt,configRevision:configured.revision,bindingRevision:binding.revision,originalCount:1,actualPopup:true,pausedAndOffNavigateImmediately:true,calls:f.calls.map(call=>({method:call.method,input:call.input}))})
})

it('keeps legacy latest time unknown and excludes original messages before the current binding boundary',async()=>{
 const {binding}=await bind();await incoming(binding,'legacy-current')
 const saved=(await f.forward('connection.ingress.ls',{connectionId:binding.connectionId})).ingresses[0]!
 if(saved.kind==='action')throw Error('Original message required')
 const {receivedAt:_old,...legacy}=saved
 f.services.database!.prepare('UPDATE connection_ingress_message SET record_json=? WHERE ingress_id=?').run(JSON.stringify(legacy),saved.ingressId)
 const report=await f.forward('connection.diagnose',query(binding));expect(report.groups.value!.items[0]!.activity!.incoming.value?.latest?.receivedAt).toBeNull()
 const paused=await f.forward('connection.binding.pause',{operationId:'status-pause',bindingId:binding.bindingId,expectedRevision:binding.revision});expect(paused.state).toBe('applied');if(paused.state!=='applied')throw Error('Pause required')
 const resumed=await f.forward('connection.binding.resume',{operationId:'status-resume',bindingId:binding.bindingId,expectedRevision:paused.binding.revision});expect(resumed.state).toBe('applied');if(resumed.state!=='applied')throw Error('Resume required')
 await incoming(resumed.binding,'after-new-boundary')
 const after=await f.forward('connection.diagnose',query(resumed.binding)),window=after.groups.value!.items[0]!.activity!.incoming.value!
 expect(window.included).toBe(1);expect(window.examined).toBe(2)
 expect(window.latest?.ingressId).not.toBe(saved.ingressId)
 const bad=structuredClone(after);bad.groups.value!.items[0]!.activity!.incoming.value!.included=2
 expect(()=>parseConnectionResult('connection.diagnose',bad,query(resumed.binding))).toThrow()
 expect(()=>parseConnectionParams('connection.diagnose',{executionHostId:'local',agentSessionId:'original-agent',activity:true})).toThrow()
 facts({legacyTimeUnknown:true,currentBoundaryOnly:true,window})
})

it('keeps the latest original send result and scoped message window through SDK Hosted and compiled CLI without counting actions',async()=>{
 const {binding}=await bind();await incoming(binding,'actual-member-message')
 const action={schema:'2.0',header:{app_id:binding.application.appId,event_id:'status-action',event_type:'card.action.trigger'},event:{operator:{open_id:'original-external-user'},host:'im_message',context:{open_chat_id:binding.externalConversationId,open_message_id:'original-card'},action:{tag:'button',value:{actionRef:'unrelated-action'}}}}
 await f.ingressTransport!.receive(action)
 await incoming({...binding,externalConversationId:'different-room'},'foreign-room-message')
 const current=await f.forward('connection.diagnose',query(binding));expect(current.groups.value!.items[0]!.activity!.incoming.value).toMatchObject({examined:2,included:1})
 const operations=()=>f.services.publication!.store.list(binding).filter(row=>row.reference.source.kind==='native'&&row.effect==='upsert')
 await appendFile(f.original.transcript,native('old-timed-reply'));f.services.publication!.refresh();await wait(()=>expect(operations().some(row=>row.state==='confirmed')).toBe(true))
 await appendFile(f.original.transcript,native('latest-legacy-reply'));f.services.publication!.refresh();await wait(()=>expect(operations().filter(row=>row.state==='confirmed')).toHaveLength(2))
 const latest=operations().at(-1)!,{receiptObservedAt:_removed,...legacy}=latest
 f.services.database!.prepare('UPDATE connector_publication_operation SET operation_json=? WHERE operation_id=?').run(JSON.stringify(legacy),latest.operationId)
 const legacyReport=await f.forward('connection.diagnose',query(binding));expect(legacyReport.groups.value!.items[0]!.activity!.outgoing.value?.latest).toMatchObject({operationId:latest.operationId,receipt:'confirmed',receiptObservedAt:null})
 lose=true;await appendFile(f.original.transcript,native('latest-unknown-reply'));f.services.publication!.refresh();await wait(()=>expect(operations().some(row=>row.state==='unknown')).toBe(true))
 const unknown=operations().find(row=>row.state==='unknown')!
 const runtime=new core.AgentMuxHostedRuntimeService(f.original.client,null,()=>hostedTestOwner(f.original.client))
 const server=new core.AgentMuxControlServer({socketPath:join(f.original.root,'status-hosted.sock'),connections:f.services.connections,spatialState:f.original.spatial,coreClients:()=>[{hostId:'local',client:f.original.client}],hostedRuntime:()=>runtime})
 await server.start()
 const rpc=await core.connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}})
 const hosted=await core.connectHostedAgentMux({rpc,waitForReady:false,forwardRpc:(method,params)=>rpc.call(method,params)})
 try{
  const sdk=await rpc.call('connection.diagnose',query(binding)),forwarded=await hosted.forwardRpc!('connection.diagnose',query(binding))
  expect(forwarded).toEqual(sdk);expect(sdk.groups.value!.items[0]!.activity!.outgoing.value?.latest).toMatchObject({operationId:unknown.operationId,state:'unknown',receiptObservedAt:null})
  if(process.env.CONNECTOR_STATUS_CLI)vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI',process.env.CONNECTOR_STATUS_CLI)
  const cli=await runCompiledObjectCli(['--endpoint','unix:'+server.path,'connection','diagnose','--host',binding.executionHostId,'--session',binding.agentSessionId,'--binding',binding.bindingId,'--revision',String(binding.revision),'--activity'],objectCliEnvironment(f.original.root))
  expect(cli.code,cli.stderr).toBe(0);expect(JSON.parse(cli.stdout).result).toEqual(sdk)
  const help=await runCompiledObjectCli(['connection','diagnose','--help'],objectCliEnvironment(f.original.root));expect(help.stdout).toContain('--activity')
  const guide=await runCompiledObjectCli(['connection','--skill'],objectCliEnvironment(f.original.root));expect(guide.stdout).toContain('receiptObservedAt')
  facts({actualSdkHostedCli:true,latestUnknown:unknown.operationId,legacyLatestNoFallback:true,window:sdk.groups.value!.items[0]!.activity!.incoming.value,cliCode:cli.code})
 }finally{await hosted.dispose();rpc.dispose();await server.stop();await runtime.dispose()}
 const implementation=vi.mocked(api.connections.call).getMockImplementation()!
 vi.mocked(api.connections.call).mockImplementation((method,input,target)=>method==='connection.binding.inspect'?Promise.reject(Error('Controlled access read failure')):implementation(method,input,target))
 await f.mount();const trigger=()=>document.querySelector<HTMLButtonElement>('[data-channel-entry=feishu]')!
 await wait(()=>expect(trigger()).not.toBeNull());await act(async()=>{trigger().focus();trigger().dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))})
 await wait(()=>expect(document.querySelector('[data-group-status]')?.textContent).toContain('Ada'))
 expect(document.querySelector('[data-group-status]')?.textContent).toContain('Not checked')
 expect(document.querySelector('[data-group-status]')?.textContent).not.toContain('No access')
})
