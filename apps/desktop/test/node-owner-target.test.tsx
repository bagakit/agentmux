// @vitest-environment happy-dom
import {act} from 'react'
import {beforeAll,afterAll,expect,it,vi} from 'vitest'
import {EventEmitter} from 'node:events'
import {mkdtemp,mkdir,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {AgentMuxControlServer} from '../../../packages/core/src/public-rpc-server'
import {connectAgentMuxRpc} from '../../../packages/core/src/public-rpc-client'
import {NodePublishingOwner} from '../../../packages/core/src/node-publishing-owner'
import {AgentMuxHostedRuntimeService} from '../../../packages/core/src/hosted-runtime-service'
import {rpcOwnerFixture} from '../../../packages/core/test/helpers/public-rpc-owner'
import {AGENTMUX_RUNTIME_OWNER_PROTOCOL_VERSION} from '../../../packages/core/src/runtime-owner-protocol'
import {RuntimeController} from '../src/main/runtime-controller'
import {registerNodePublishingIpc} from '../src/main/node-publishing-ipc'
import {createRendererNodePublishing} from '../src/renderer/src/lib/node-publishing-client'
import {HostRuntimePanel} from '../src/renderer/src/components/settings/HostRuntimePanel'
import {NetworkNodeSettingsPane} from '../src/renderer/src/components/settings/NetworkNodeSettingsPane'
import {SettingsPanel} from '../src/renderer/src/components/SettingsPanel'
import {assertAppDocumentSender} from '../src/main/ipc-sender-trust'
import {api} from '../src/renderer/src/lib/api'
import {useAppStore} from '../src/renderer/src/store'
import {nodePublicationDraftForRuntime} from '../src/renderer/src/lib/node-publication-draft'
import {composerDOM,composerConfig} from './helpers/composer-dom-fixture'
import type {AgentMuxPreloadApi} from '../src/shared/contracts'
const preloadBridge=vi.hoisted(()=>({api:null as AgentMuxPreloadApi|null,invoke:vi.fn()}))
vi.mock('electron',()=>({contextBridge:{exposeInMainWorld:(_key:string,api:AgentMuxPreloadApi)=>{preloadBridge.api=api}},ipcRenderer:{invoke:preloadBridge.invoke,on:vi.fn(),removeListener:vi.fn()},webFrame:{getZoomFactor:()=>1}}))
import '../src/preload/index'
const dom=composerDOM()
let dispose:(()=>void)|undefined
beforeAll(async()=>{dispose=await useAppStore.getState().initialize()})
afterAll(()=>dispose?.())
async function input(value:string){await act(async()=>{const n=dom.container.querySelector<HTMLInputElement>('[aria-label="Node alias"]')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(n,value);n.dispatchEvent(new Event('input',{bubbles:true}))})}
async function choose(hostId:string){await act(async()=>{const n=dom.container.querySelector<HTMLSelectElement>('[aria-label="Node to manage"]')!;n.value=hostId;n.dispatchEvent(new Event('change',{bubbles:true}))})}
async function alias(value:string){await vi.waitFor(()=>expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Node alias"]')?.value,dom.container.textContent??'').toBe(value))}
const props=()=>({config:useAppStore.getState().config!,active:true,onClose:vi.fn(),onNavigate:vi.fn()})
async function fixture(actor?: 'managed'){
 const root=await mkdtemp('/tmp/node-target-'),cores=[]
 for(const id of ['local','farm']){
  const directory=join(root,id);await mkdir(directory)
  const identity={runtimeId:id+'-runtime',ownerInstanceId:id+'-instance',protocolVersion:AGENTMUX_RUNTIME_OWNER_PROTOCOL_VERSION,processId:process.pid,ctxmux:null,availability:'connected' as const}
  const issuer=await rpcOwnerFixture(['managed-'+id]),client=issuer.client
  const hosted=new AgentMuxHostedRuntimeService(client,null,()=>identity)
  const owner=new NodePublishingOwner({stateDirectory:directory,runtimeId:identity.runtimeId,ownerInstanceId:identity.ownerInstanceId})
  const server=new AgentMuxControlServer({socketPath:join(directory,'rpc.sock'),coreClients:issuer.coreClients,hostedRuntime:()=>hosted,nodePublishing:owner});await server.start()
  const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}})
  const calls:Array<{method:string;params:unknown;context:unknown;fence:unknown}>=[]
  const carrier={runtimeOwnerIdentity:()=>identity,forwardRpc:async(method:any,params:any,context:any,fence:any)=>{calls.push({method,params,context,fence});return rpc.call(method,params,{...context,...(actor ? {credentials:issuer.credentials} : {}),...(fence?{runtimeFence:fence}:{})})}}
  cores.push({id,owner,identity,client,issuer,hosted,server,rpc,carrier,calls})
 }
 const routes=new Map(cores.map(core=>[core.id,{client:core.carrier}]))
 const runtime=Object.assign(Object.create(RuntimeController.prototype),{hosts:routes,hostReconfigurationReservations:new Map()}) as RuntimeController
 class Sender extends EventEmitter{id=51;mainFrame={url:'file:///private/review/index.html',detached:false,isDestroyed:()=>false};isDestroyed(){return false}}
 const sender=new Sender(),event={sender,senderFrame:sender.mainFrame},handlers=new Map<string,(...args:any[])=>any>()
 const owner=registerNodePublishingIpc({handle:(name,listener)=>handlers.set(name,(e,...args)=>{assertAppDocumentSender(e,sender,{current:{mode:'prod',filePath:'/private/review/index.html'},loading:null});return listener(e,...args)}),call:(method,params,context)=>{const route=cores.find(core=>core.id===(params as {hostId:string}).hostId)!;return route.rpc.call(method,{...params,hostId:'local'},{...context,...(actor ? {credentials:route.issuer.credentials} : {})})},owner:runtime.callNodeOwner.bind(runtime)})
 const invoke=async(channel:string,...args:any[])=>handlers.get(channel)!(event,...args)
 preloadBridge.invoke.mockImplementation(invoke)
 const bridge=createRendererNodePublishing(preloadBridge.api!.nodePublishing)
 vi.spyOn(api.nodePublishing,'call').mockImplementation(bridge.call);vi.spyOn(api.nodePublishing,'owner').mockImplementation(bridge.owner)
 vi.spyOn(api.hosts,'inspect').mockImplementation(async host=>({routeHostId:host.id,owner:{state:'available',value:cores.find(core=>core.id===host.id)!.identity}} as never))
 useAppStore.setState({config:{...composerConfig,hosts:[composerConfig.hosts[0]!,{id:'farm',kind:'ssh',label:'Saved Farm',hostname:'private.invalid',runtimeId:'farm-runtime'}]}})
 return{cores,runtime,routes,handlers,event,sender,bridge,async dispose(){await dom.render(<div/>);owner.dispose();for(const core of cores){await core.rpc.dispose();await core.server.stop();await core.hosted.dispose();await core.issuer.close()}await rm(root,{recursive:true,force:true})}}
}
it('two original Core owners through registered Main and Renderer edit only the selected saved Node, retain per-Runtime drafts and exclude the local listener',async()=>{
 const f=await fixture()
 try{
  await dom.render(<NetworkNodeSettingsPane {...props()}/>);await alias('');expect(dom.container.querySelector('[data-settings-field="incoming"]')).not.toBeNull()
  await act(async()=>dom.container.querySelector<HTMLInputElement>('[aria-label="Allow Tailcat connections"]')!.click())
  await input('local-draft');await choose('farm');await alias('')
  expect(dom.container.querySelector('[data-settings-field="incoming"]')).toBeNull();expect(dom.container.querySelector('[data-settings-host]')?.getAttribute('data-settings-host')).toBe('farm')
  await input('farm-published');await dom.click('.network-node-save button');await vi.waitFor(async()=>expect((await f.cores[1]!.owner.call('settings.node.inspect',{})).policy.alias).toBe('farm-published'))
  expect((await f.cores[0]!.owner.call('settings.node.inspect',{})).policy.alias).toBe('')
  await choose('local');await alias('local-draft');expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Allow Tailcat connections"]')?.checked).toBe(true);expect(nodePublicationDraftForRuntime(useAppStore.getState().nodePublicationDrafts,'local-runtime')?.draft.alias).toBe('local-draft')
  await choose('farm');await alias('farm-published')
  const configured=f.cores[1]!.calls.find(call=>call.method==='settings.node.configure')!;expect(configured.fence).toEqual({runtimeId:'farm-runtime',ownerInstanceId:'farm-instance'})
  await expect(f.bridge.owner({hostId:'farm',expectedRuntimeId:'local-runtime'},'settings.node.configure',{expectedRevision:'wrong',operationId:'wrong-target',policy:(await f.cores[0]!.owner.call('settings.node.inspect',{})).policy})).rejects.toMatchObject({code:'RUNTIME_OWNER_MISMATCH'})
  expect(f.cores[0]!.calls.filter(call=>call.method==='settings.node.configure')).toHaveLength(0)
  expect(()=>f.handlers.get('nodePublishing:owner')!({...f.event,senderFrame:{...f.sender.mainFrame}},'untrusted',{hostId:'farm',expectedRuntimeId:'farm-runtime'},'settings.node.inspect',{})).toThrow('Untrusted application')
  await expect(f.bridge.owner({hostId:'farm',expectedRuntimeId:'farm-runtime'},'settings.node.inspect',{caller:'self-grant'} as never)).rejects.toThrow()
  const farm=f.cores[1]!,current=await farm.owner.call('settings.node.inspect',{})
  await expect(farm.rpc.call('settings.node.configure',{expectedRevision:current.policyRevision,operationId:'managed-self-grant',policy:{...current.policy,shareResources:true}},{credentials:farm.issuer.credentials})).rejects.toMatchObject({code:'CONTROL_PERMISSION_DENIED'})
  expect((await farm.owner.call('settings.node.inspect',{})).policy.shareResources).toBe(false);expect(farm.issuer.inner.kernel.stop).not.toHaveBeenCalled()
 }finally{await f.dispose()}
})
it('actual Settings observation reports the Node selected by its original editor rather than the requested Host',async()=>{
 const f=await fixture(),observation={current:null as {hostId?:string|null}|null}
 try{await dom.render(<SettingsPanel initialSection="network-node" navigationRequest={{section:'network-node',hostId:'farm'}} observationRef={observation} onClose={vi.fn()}/>);await alias('');expect(observation.current?.hostId).toBe('farm');await choose('local');await alias('');expect(observation.current?.hostId).toBe('local')}
 finally{await f.dispose()}
})

it.each(['confirmed','unknown','route-changed'] as const)('switching Nodes preserves the original in-flight %s request and later Runtime draft without editing the new target',async outcome=>{
 const f=await fixture(),farm=f.cores[1]!,forward=farm.carrier.forwardRpc
 let finish!:()=>void,reject!:(cause:unknown)=>void
 const hold=new Promise<void>((yes,no)=>{finish=yes;reject=no})
 farm.carrier.forwardRpc=async(...args:Parameters<typeof forward>)=>{const reply=await forward(...args);if(args[0]==='settings.node.configure')await hold;return reply}
 try{
  await dom.render(<NetworkNodeSettingsPane {...props()} navigationRequest={{section:'network-node',hostId:'farm'}}/>);await alias('')
  await input('submitted-farm');await dom.click('.network-node-save button');await vi.waitFor(async()=>expect((await farm.owner.call('settings.node.inspect',{})).policy.alias).toBe('submitted-farm'))
  const op=nodePublicationDraftForRuntime(useAppStore.getState().nodePublicationDrafts,'farm-runtime')!.pending!.operationId
  await input('later-farm');await choose('local');await alias('');await input('local-later')
  if(outcome==='route-changed')f.routes.set('farm',{client:{...farm.carrier,forwardRpc:forward}})
  await act(async()=>{if(outcome==='unknown')reject(Error('Original reply lost after Core applied it'));else finish()})
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Node alias"]')?.value).toBe('local-later')
  const retained=nodePublicationDraftForRuntime(useAppStore.getState().nodePublicationDrafts,'farm-runtime')!
  expect(retained.draft.alias).toBe('later-farm');expect(retained.pending?.operationId).toBe(outcome==='confirmed'?undefined:op)
  expect((await f.cores[0]!.owner.call('settings.node.inspect',{})).policy.alias).toBe('')
  await choose('farm');await alias('later-farm')
  await vi.waitFor(()=>expect(nodePublicationDraftForRuntime(useAppStore.getState().nodePublicationDrafts,'farm-runtime')?.pending).toBeUndefined())
  expect(farm.calls.filter(call=>call.method==='settings.node.configure')).toHaveLength(1)
  expect(farm.calls.some(call=>call.method==='settings.node.inspect'&&(call.params as {operationId?:string}).operationId===op)).toBe(outcome!=='confirmed')
 }finally{finish();await f.dispose()}
})
it('an unavailable saved Node stays selected and never substitutes a local policy or listener',async()=>{
 const f=await fixture(),farm=f.cores[1]!
 farm.carrier.forwardRpc=async()=>{throw Object.assign(Error('Original Core has no Node owner interface. Upgrade this saved Host and refresh.'),{code:'RPC_METHOD_NOT_FOUND'})}
 try{await dom.render(<NetworkNodeSettingsPane {...props()} navigationRequest={{section:'network-node',hostId:'farm'}}/>);await vi.waitFor(()=>expect(dom.container.textContent).toContain('Original Core has no Node owner interface'));expect(dom.container.querySelector('[aria-label="Node alias"]')).toBeNull();expect(dom.container.querySelector('[data-settings-field="incoming"]')).toBeNull();expect(dom.container.querySelector<HTMLSelectElement>('[aria-label="Node to manage"]')?.value).toBe('farm');expect(f.cores[0]!.calls).toHaveLength(0)}finally{await f.dispose()}
})

it.each(['Node editor','Host panel'] as const)('independent Host diagnostics failure cannot close an available %s or owner resource reader',async surface=>{
 const f=await fixture()
 vi.spyOn(api.hosts,'inspect').mockRejectedValue(Error('Independent diagnostics unavailable'))
 try{if(surface==='Node editor'){await dom.render(<NetworkNodeSettingsPane {...props()}/>);await alias('');await act(async()=>{const n=dom.container.querySelector<HTMLDetailsElement>('[data-settings-field="monitoring"]')!;n.open=true;n.dispatchEvent(new Event('toggle'))})}else{const host=useAppStore.getState().config!.hosts[0]!;await dom.render(<HostRuntimePanel host={host} committed={host} active/>)};await vi.waitFor(()=>expect(dom.container.textContent).toContain('Private owner view'));await vi.waitFor(()=>expect(f.cores[0]!.calls.some(call=>call.method==='settings.node.resources')).toBe(true));await vi.waitFor(()=>expect(dom.container.textContent).toContain('Independent diagnostics unavailable'))}
 finally{await f.dispose()}
})

it('the real trusted service consumer reads original private Core metrics while its public Share remains false', async () => {
 const f=await fixture()
 try {
  const host=useAppStore.getState().config!.hosts.find(host=>host.id==='farm')!
  const before=await f.bridge.owner({hostId:'farm',expectedRuntimeId:'farm-runtime'},'settings.node.inspect',{})
  expect(before.policy.shareResources).toBe(false)
  const published=await f.bridge.call('node.resources',{hostId:'farm',expectedRuntimeId:'farm-runtime'})
  expect(published.status).toBe('withheld')
  await dom.render(<HostRuntimePanel host={host} committed={host} active/>)
  await vi.waitFor(()=>expect(dom.container.textContent).toContain('Private owner view'))
  await vi.waitFor(()=>expect(dom.container.textContent).toContain(' MiB'))
  expect(f.cores[1]!.calls.some(call=>call.method==='settings.node.resources')).toBe(true)
  expect(f.cores[0]!.calls.some(call=>call.method==='settings.node.resources')).toBe(false)
  const after=await f.bridge.owner({hostId:'farm',expectedRuntimeId:'farm-runtime'},'settings.node.inspect',{})
  expect(after.policy).toEqual(before.policy);expect(after.policyRevision).toBe(before.policyRevision)
  expect(f.cores.flatMap(core=>core.calls).some(call=>call.method==='settings.node.configure')).toBe(false)
 } finally {await f.dispose()}
})

it('a real managed-owner rejection keeps the original public shared service measurements available', async () => {
 const f=await fixture('managed')
 try {
  const farm=f.cores[1]!,state=await farm.rpc.call('settings.node.inspect',{})
  await farm.rpc.call('settings.node.configure',{expectedRevision:state.policyRevision,operationId:'private-fixture-publish',policy:{...state.policy,shareResources:true}})
  await expect(f.bridge.owner({hostId:'farm',expectedRuntimeId:'farm-runtime'},'settings.node.resources',{})).rejects.toMatchObject({code:'CONTROL_PERMISSION_DENIED'})
  const host=useAppStore.getState().config!.hosts.find(host=>host.id==='farm')!
  await dom.render(<HostRuntimePanel host={host} committed={host} active/>)
  await vi.waitFor(()=>expect(dom.container.textContent).toContain('Private service read unavailable'))
  await vi.waitFor(()=>expect(dom.container.textContent).toContain('Published by this node'))
  expect(dom.container.textContent).toContain(' MiB')
  expect((await farm.rpc.call('settings.node.inspect',{})).policy.shareResources).toBe(true)
 } finally {await f.dispose()}
})

it('the original Main configured-client bridge consumes managed operator policy reads with its exact Runtime fence',async()=>{
 const f=await fixture(),local=f.cores[0]!,farm=f.cores[1]!
 const server=new AgentMuxControlServer({socketPath:join(local.issuer.root,'node-policy-main.sock'),coreClients:()=>[{hostId:'local',client:local.client},{hostId:'farm',client:farm.carrier as never}],hostedRuntime:()=>local.hosted,
  hostConfiguration:id=>useAppStore.getState().config!.hosts.find(host=>host.id===id)??null,
  callOriginalCore:f.runtime.callOriginalCore.bind(f.runtime)})
 await server.start()
 const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path},credentials:local.issuer.credentials})
 try{
  const forward=farm.carrier.forwardRpc
  farm.carrier.forwardRpc=async(...args:Parameters<typeof forward>)=>{const reply=await forward(...args);if(args[0]==='runtime.owner.identity'){const config=useAppStore.getState().config!;useAppStore.setState({config:{...config,hosts:config.hosts.map(host=>host.id==='farm'?{...host,label:'Renamed display only'}:host)}})}return reply}
  const result=await rpc.call('settings.node.inspect',{target:{hostId:'farm',expectedRuntimeId:'farm-runtime'}})
  expect(result.node.runtimeId).toBe('farm-runtime');expect(result.policy.shareResources).toBe(false)
  const call=farm.calls.filter(row=>row.method==='settings.node.inspect').at(-1)!
  expect(call.fence).toEqual({runtimeId:'farm-runtime',ownerInstanceId:'farm-instance'})
  const count=farm.calls.length
  await expect(f.bridge.owner({hostId:'farm',expectedRuntimeId:'farm-runtime'},'settings.node.inspect',{target:{hostId:'local',expectedRuntimeId:'local-runtime'}})).rejects.toMatchObject({code:'INVALID_CONTROL_REQUEST'})
  expect(farm.calls).toHaveLength(count)
  await expect(f.runtime.callOriginalCore('farm','settings.node.inspect',{}, {runtimeFence:{runtimeId:'another-runtime',ownerInstanceId:'another-instance'}})).rejects.toMatchObject({code:'RUNTIME_OWNER_MISMATCH'})
  expect(farm.calls.some(row=>row.method==='settings.node.configure')).toBe(false)
 }finally{await rpc.dispose();await server.stop();await f.dispose()}
})
