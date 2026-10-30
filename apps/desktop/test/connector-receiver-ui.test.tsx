// @vitest-environment happy-dom
import {act} from 'react'
import {afterEach,expect,it,vi} from 'vitest'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {appendFileSync} from 'node:fs'
vi.mock('electron',()=>({app:{getPath:()=>tmpdir()}}))
import * as core from '../../../packages/core/src/index.js'
import {ingressFixture} from '../../../packages/connectors/test/fixtures/ingress.js'
import {feishuConfig} from '../../../packages/connectors/test/fixtures/feishu.js'
import {feishuSocketTransport} from '../../../packages/connectors/test/fixtures/feishu-socket.js'
import {FeishuAdapter} from '../../../packages/connectors/src/adapters/feishu/index.js'
import {createConnectionServices} from '../../../packages/connectors/src/connection-services.js'
import {hostedTestOwner} from '../../../packages/core/test/helpers/hosted-runtime-port.js'
import {RuntimeController} from '../src/main/runtime-controller'
import {registerConnectorIpc} from '../src/main/connector-ipc'
import {unwrapSessionInputOperationResult} from '../src/shared/session-input-result'
import {api} from '../src/renderer/src/lib/api'
import {useAppStore} from '../src/renderer/src/store'
import {ConnectorDeliveryDetails} from '../src/renderer/src/components/ConnectorDeliveryDetails'
import {ConnectorReceiverControl} from '../src/renderer/src/components/ConnectorReceiverControl'
import {connectorGroupSummary} from '../src/renderer/src/lib/connector-group-status'
import {groupTarget,readGroupDiagnosis} from '../src/renderer/src/lib/group-diagnosis'
import {composerDOM,composerConfig} from './helpers/composer-dom-fixture'
const dom=composerDOM(),cleanup:Array<()=>unknown|Promise<unknown>>=[]
afterEach(async()=>{await dom.render(null);for(const close of cleanup.splice(0).reverse())await close();vi.unstubAllEnvs()})
const wait=async(read:()=>unknown|Promise<unknown>)=>vi.waitFor(async()=>{await act(async()=>{await new Promise(r=>setTimeout(r,10))});await read()},{timeout:9000,interval:25})
async function fixture(rejected=false){
 const wire=await feishuSocketTransport({endpointCode:rejected?514:0});cleanup.push(wire.close)
 const f=await ingressFixture(true,feishuConfig);cleanup.push(f.close)
 const starts=vi.spyOn(f.inner.kernel,'start')
 let endpointWait:Promise<void>|undefined,releaseEndpoint=()=>{}
 const originalHttp=wire.http.request.bind(wire.http)
 const services=await createConnectionServices({directory:join(f.root,'ui-owner'),adapters:[new FeishuAdapter({http:{...wire.http,request:async input=>{if(input.url?.endsWith('/callback/ws/endpoint'))await endpointWait;return originalHttp(input)}}})],bindings:{spatial:f.spatial,checkpoint:ref=>f.client.conversationCheckpoint(ref)},ingress:{core:host=>host==='local'?f.client:undefined}});cleanup.push(()=>services.close())
 cleanup.push(()=>releaseEndpoint())
 const secret=await services.secrets.store({operationId:'ui-secret',secret:'fixture'})
 await services.connections.configure({operationId:'ui-config',expectedRevision:null,connection:{...feishuConfig,credentialRef:secret.credentialRef}})
 await services.connections.bindings!.bind(f.input,{actor:{kind:'user',id:'original-user'}});await services.connections.bindings!.grant(f.grant,{actor:{kind:'user',id:'original-user'}})
 const identity=hostedTestOwner(f.client),runtime=new core.AgentMuxHostedRuntimeService(f.client,f.store.path,()=>identity);cleanup.push(()=>runtime.dispose())
 const server=new core.AgentMuxControlServer({socketPath:join(f.root,'ui.sock'),connections:services.connections,coreClients:f.coreClients,hostedRuntime:()=>runtime});await server.start();cleanup.push(()=>server.stop())
 const rpc=await core.connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}});cleanup.push(()=>rpc.dispose())
 const hosted=await core.connectHostedAgentMux({rpc,waitForReady:false,forwardRpc:(method,params,context={},expected)=>rpc.call(method,params,{...(context.signal?{signal:context.signal}:{}),...(expected??context.runtimeFence?{runtimeFence:expected??context.runtimeFence}:{} )})});cleanup.push(()=>hosted.dispose())
 vi.spyOn(hosted,'connect').mockRejectedValue(Error('Only startup observation is controlled'))
 const controller=new RuntimeController(f.store,async()=>hosted);cleanup.push(()=>controller.dispose());controller.commit(await controller.prepare(composerConfig))
 const target={hostId:'local',runtimeId:identity.runtimeId},handlers=new Map<string,(...args:any[])=>Promise<unknown>>(),trusted=vi.fn()
 registerConnectorIpc({handleWithEvent:(method,handler)=>handlers.set(method,handler),assertTrusted:trusted,runtime:controller,metadata:{publish(){},observation(){}}})
 const calls:Array<{method:string;params:any;target:any}>=[];let drop=false,hold:Promise<void>|undefined,release=()=>{}
 const source=vi.spyOn(api.connections,'call').mockImplementation(async(method,params,owner)=>{calls.push({method,params:structuredClone(params),target:structuredClone(owner)});const reply=await handlers.get('connections:call')!({},method,params,owner);if(method==='connection.receiver.recover'&&drop){drop=false;throw Error('Lost actual Host reply')}if(method==='connection.receiver.recover')await hold;return unwrapSessionInputOperationResult(structuredClone(reply)) as any})
 await wait(async()=>expect((await services.connections.inspect({connectionId:feishuConfig.connectionId})).connection?.receiver?.state).toBe(rejected?'ended':'ready'))
 const binding=(await services.connections.bindings!.inspect({bindingId:f.input.bindingId})).binding!,record=() => services.connections.inspect({connectionId:feishuConfig.connectionId}).then(r=>r.connection!)
 useAppStore.setState({connectorRoomIntents:{},agentComposerDrafts:{'original-agent':'Keep original draft'}})
 // Controlled config persistence only: actual submitted correlation/AppStore remains original.
 vi.spyOn(api.config,'get').mockResolvedValue(composerConfig)
 cleanup.push(()=>{if(process.env.RECEIVER_UI_FACTS)appendFileSync(process.env.RECEIVER_UI_FACTS,JSON.stringify({case:expect.getState().currentTestName,target,calls,physicalSockets:wire.sockets.length,starts:starts.mock.calls.length,stops:f.inner.kernel.stop.mock.calls.length,draft:useAppStore.getState().agentComposerDrafts['original-agent']})+'\n')})
 const mount=async()=>dom.render(<ConnectorDeliveryDetails binding={binding} connection={await record()} hostingTarget={target}/>)
 cleanup.push(()=>release())
 return{...f,wire,services,identity,controller,hosted,rpc,target,calls,trusted,source,binding,record,mount,blockEndpoint(){endpointWait=new Promise<void>(resolve=>{releaseEndpoint=resolve})},releaseEndpoint(){endpointWait=undefined;releaseEndpoint()},drop:()=>{drop=true},hold(){hold=new Promise<void>(resolve=>{release=resolve})},release:()=>{hold=undefined;release()},unchanged(){expect(starts).not.toHaveBeenCalled();expect(f.inner.kernel.stop).not.toHaveBeenCalled();expect(f.inner.kernel.attach).not.toHaveBeenCalled();expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep original draft')}}
}
it('current stopped receiver outranks earlier accepted input through the original shared summary',async()=>{
 const f=await fixture();f.wire.message('earlier-success');await wait(()=>expect(f.inner.kernel.input).toHaveBeenCalledOnce())
 f.wire.state.nextEndpointCode=403;f.wire.sockets[0]!.terminate();await wait(async()=>expect((await f.record()).receiver?.state).toBe('ended'))
 await f.mount();await wait(()=>expect(dom.container.querySelector('[data-direction="incoming"]')?.textContent).toContain('Receiver stopped'))
 expect(dom.container.querySelector('[data-direction="incoming"] strong')?.textContent).toBe('Receiver stopped')
 expect(dom.container.textContent).toContain('Earlier message:');expect(dom.container.querySelector('[data-receiver-action="recover"]')).not.toBeNull()
 const report=await readGroupDiagnosis((method,params)=>api.connections.call(method,params,f.target),groupTarget(f.binding))
 // Prior native adoption is a controlled typed observation only; the real Core
 // input above proves dispatch, not native Agent acceptance.
 expect(connectorGroupSummary({...report,incoming:{...report.incoming,value:{...report.incoming.value!,rows:report.incoming.value!.rows.map(row=>({...row,coreStatus:'admitted'}))}}}).incoming.value).toBe('Receiver stopped')
 expect(f.trusted).toHaveBeenCalled();f.unchanged()
})
it('lost recovery reply is inspected and explicitly continued with the same frozen operation through actual Main and Host',async()=>{
 const f=await fixture(true);await f.mount();await wait(()=>expect(dom.container.querySelector('[data-receiver-action="recover"]')).not.toBeNull())
 f.wire.state.endpointCode=0;f.wire.state.handshakeDelay=2000;f.drop();await dom.click('[data-receiver-action="recover"]');await wait(()=>expect(dom.container.textContent).toContain('Recovery reply unconfirmed'))
 const original=f.calls.find(c=>c.method==='connection.receiver.recover')!;expect(original.target).toEqual(f.target)
 expect(Object.values(useAppStore.getState().connectorRoomIntents)[0]?.input).toEqual(original.params)
 await dom.render(null);await f.mount();await wait(()=>expect(dom.container.textContent).toContain('Reconnect requested'))
 expect(f.calls.filter(c=>c.method==='connection.receiver.recover')).toHaveLength(1)
 await dom.click('[data-receiver-action="continue"]');await wait(()=>expect(f.calls.filter(c=>c.method==='connection.receiver.recover')).toHaveLength(2))
 expect(f.calls.filter(c=>c.method==='connection.receiver.recover').map(c=>({params:c.params,target:c.target}))).toEqual([{params:original.params,target:f.target},{params:original.params,target:f.target}])
 await wait(async()=>expect((await f.record()).receiver?.state).toBe('ready'));expect(f.wire.sockets).toHaveLength(1);f.unchanged()
})
it('active SDK recovery is observed without closing it and a changed Runtime refuses only this action',async()=>{
 const f=await fixture();const record=await f.record()
 f.blockEndpoint();f.wire.sockets[0]!.terminate()
 await wait(async()=>expect((await f.record()).receiver?.state).toBe('recovering'))
 await f.mount();await wait(()=>expect(dom.container.querySelector('[data-direction="incoming"] strong')?.textContent).toBe('Reconnecting'))
 expect(dom.container.querySelector('[data-receiver-action="recover"]')).toBeNull()
 const joined=await api.connections.call('connection.receiver.recover',{operationId:'join-original-sdk',connectionId:record.config.connectionId,expectedRevision:record.revision,receiverRef:record.receiver!.ref},f.target)
 expect(joined.operation.disposition).toBe('joined');f.releaseEndpoint()
 await wait(async()=>expect((await f.record()).receiver).toMatchObject({state:'ready',ref:record.receiver!.ref}));expect(f.wire.sockets).toHaveLength(2)
 const input={operationId:'wrong-runtime',connectionId:record.config.connectionId,expectedRevision:record.revision,receiverRef:record.receiver!.ref}
 await expect(api.connections.call('connection.receiver.recover',input,{...f.target,runtimeId:'replacement'})).rejects.toMatchObject({code:'RUNTIME_OWNER_MISMATCH'});expect(f.wire.sockets).toHaveLength(2);f.unchanged()
})
it('local correlation persistence failure keeps the original in-memory ID and does not gate explicit management',async()=>{
 const f=await fixture(true);await f.mount();await wait(()=>expect(dom.container.querySelector('[data-receiver-action="recover"]')).not.toBeNull())
 const write=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('Controlled local persistence failure')})
 f.wire.state.endpointCode=0;await dom.click('[data-receiver-action="recover"]')
 await wait(()=>expect(f.calls.filter(c=>c.method==='connection.receiver.recover')).toHaveLength(1))
 await wait(()=>expect(dom.container.textContent).toContain('local copy is not durable'))
 const request=f.calls.find(c=>c.method==='connection.receiver.recover')!
 expect(Object.values(useAppStore.getState().connectorRoomIntents)[0]?.input.operationId).toBe(request.params.operationId)
 write.mockRestore();f.unchanged()
})
it('healthy transport and one refusal stay separate and retained source failure never certifies current readiness',async()=>{
 const f=await fixture();const report=await readGroupDiagnosis((method,params)=>api.connections.call(method,params,f.target),groupTarget(f.binding));const summary=connectorGroupSummary(report)
 expect(summary.incoming.receiver).toBe('Receiver connected');expect(summary.incoming.value).toBe('No events in this window')
 // This typed single-message refusal is a presentation leaf, not a fake SDK effect.
 const refusal=connectorGroupSummary({...report,incoming:{...report.incoming,value:{...report.incoming.value!,rows:[{ingressId:'refused-message',sourceConnectionId:f.binding.connectionId,kind:'message',state:'refused',code:'INGRESS_CONTENT_UNSUPPORTED',codeRecorded:true,bindingId:f.binding.bindingId,bindingRevision:f.binding.revision,targetConnectionId:f.binding.connectionId,scope:'current-binding',inputOperationId:null,recording:{state:'refused',code:'INGRESS_CONTENT_UNSUPPORTED'},coreStatus:null,coreObservation:'not-started',nativeAdoption:null,waiting:null}]}}})
 expect(refusal.incoming.value).toBe('Message type not supported');expect(refusal.incoming.receiver).toBe('Receiver connected');expect(refusal.problems.some(p=>p.kind==='receiver-stopped')).toBe(false)
 const unknown=connectorGroupSummary({...report,connection:{...report.connection,issue:'read-unavailable',retained:true}})
 expect(unknown.incoming.value).toBe('Connection unconfirmed');expect(unknown.incoming.tone).toBe('muted');f.unchanged()
})
it('a ready receiver with an unconfirmed transport observation never claims automatic recovery or offers reconnect',async()=>{
 const f=await fixture(),record=await f.record(),report=await readGroupDiagnosis((method,params)=>api.connections.call(method,params,f.target),groupTarget(f.binding))
 // A diagnosis can observe the two original owners on either side of a state transition.
 for(const state of ['unknown','unavailable'] as const){
  const observed={...report.connection,value:{...report.connection.value!,transport:{state}}}
  const summary=connectorGroupSummary({...report,connection:observed})
  expect(summary.incoming.value).toBe('Connection unconfirmed');expect(summary.incoming.problem).toBe('receiver-unconfirmed')
  expect(summary.incoming.detail).toContain('Receiver reports connected');expect(summary.incoming.detail).not.toContain('reconnecting automatically')
  await dom.render(<ConnectorReceiverControl binding={f.binding} connection={record} observed={observed} hostingTarget={f.target} onRefresh={()=>{}}/>)
  expect(dom.container.querySelector('[data-receiver-action="recover"]')).toBeNull()
 }
 expect(f.wire.sockets).toHaveLength(1);f.unchanged()
})
it('a healthy receiver preserves the current original Core wait and its existing input action',async()=>{
 const f=await fixture()
 const provider=(f.client as unknown as {providers:{get(id:string):{planPromptInput(text:string):unknown}}}).providers.get('claude')
 vi.spyOn(provider,'planPromptInput').mockImplementation(()=>{throw new core.AgentMuxError('Controlled original native input wait','AGENT_NATIVE_INPUT_UNAVAILABLE')})
 f.wire.message('current-wait');await f.mount()
 await wait(()=>expect(dom.container.querySelector('[data-direction="incoming"] strong')?.textContent).toBe('Input recovery needed'))
 expect(dom.container.textContent).toContain('Receiver connected');expect(dom.container.textContent).toContain('Review original input')
 expect(dom.container.querySelector('[data-receiver-action="recover"]')).toBeNull();f.unchanged()
})
it('late original recovery replies never replace a different Bot and group view',async()=>{
 const f=await fixture(true);await f.mount();await wait(()=>expect(dom.container.querySelector('[data-receiver-action="recover"]')).not.toBeNull())
 f.wire.state.endpointCode=0;f.hold();await dom.click('[data-receiver-action="recover"]')
 await wait(()=>expect(f.calls.some(c=>c.method==='connection.receiver.recover')).toBe(true))
 await dom.render(<ConnectorDeliveryDetails binding={{...f.binding,bindingId:'another-group',externalConversationId:'another-room',connectionId:'another-connection'}} hostingTarget={f.target}/>)
 f.release();await wait(()=>expect(dom.container.querySelector('[data-direction="incoming"] strong')?.textContent).toBe('Connection unconfirmed'))
 expect(dom.container.textContent).not.toContain('Reconnect requested');f.unchanged()
})
