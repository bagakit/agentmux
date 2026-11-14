import{afterEach,expect,it,vi}from'vitest'
import{mkdtemp,readFile,rm}from'node:fs/promises'
import{tmpdir}from'node:os'
import{join}from'node:path'
import{AgentMuxSpatialStateStore}from'../src/spatial-state.js'
import{AgentMuxRpcService}from'../src/public-rpc-service.js'
import{parseAmuxObjectLink,formatAmuxObjectLink}from'../src/sharing.js'
import{parseSpaceLinkParams,parseSpaceLinkResult,SPACE_LINK_RESOURCE}from'../src/space-link.js'
import{agentMuxCommandHelp}from'../src/agentmux-cli-help.js'
import{agentMuxModuleSkill}from'../src/agentmux-cli-module-skills.js'
import{parseAgentMuxCliInvocation}from'../src/agentmux-cli-commands.js'
import type{AgentMuxSpatialGraph}from'../src/spatial-graph.js'
import{searchAgentMuxMetadata}from'../src/search-metadata.js'
const parseAgentMuxCliCommand=async(args:string[])=>{const r=await parseAgentMuxCliInvocation(args);return{method:r.command.method,params:r.params}}
const closes:Array<()=>Promise<unknown>>=[];afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();vi.restoreAllMocks()})
const spaceId=JSON.stringify(['local','/private/original/mote']),other=JSON.stringify(['another','/private/other/mote']),runtimeId='OriginalRuntime'
const graph=():AgentMuxSpatialGraph=>({spaces:[spaceId,other].map((id,i)=>({spaceId:id,kind:'mote',name:'Same name',hostId:i?'another':'local',directoryPath:i?'/private/other/mote':'/private/original/mote',projectId:null,topicId:i?'view:other':'view:original'})),zones:[],tabs:[],regions:[],bindings:[],layouts:{},tabLayouts:{},resources:{'original-draft':{text:'Original nonempty draft'}}})
async function fixture(){const root=await mkdtemp(join(tmpdir(),'mote-links-'));closes.push(()=>rm(root,{recursive:true,force:true}));const path=join(root,'spatial.json'),store=new AgentMuxSpatialStateStore(path);await store.commit({expectedRevision:0,graph:graph()});const owner={runtimeId,ownerInstanceId:'OriginalOwner'};const service=new AgentMuxRpcService({spatialState:store,hostedRuntime:async()=>({call:async()=>({owner})}) as never});closes.push(()=>service.dispose());const call=(method:any,input:any)=>service.call(method,input,{principal:{kind:'user',id:'private-user'},transport:'unix'});return{root,path,store,service,call,owner}}
const ensure=(eventId?:string,operationId='publish-original')=>({target:{runtimeId,spaceId,...(eventId===undefined?{}:{eventId})},operationId})
it('same original target concurrent publication has one durable address without changing original identity or content',async()=>{
 const f=await fixture(),before=(await f.store.read())!.graph
 const [a,b]=await Promise.all([f.call('space.link.ensure',ensure()),f.call('space.link.ensure',ensure(undefined,'parallel-original'))]) as any[]
 expect(a.address).toEqual(b.address);expect(a.url).toMatch(/^amux:\/\/mote\/[1-9A-HJ-NP-Za-km-z]{12}\?runtime=OriginalRuntime$/u);expect(a.url).not.toContain('private');expect(a.target.spaceId).toBe(spaceId)
 expect((await f.store.read())!.graph.spaces).toEqual(before.spaces);expect((await f.store.read())!.graph.resources['original-draft']).toEqual(before.resources['original-draft'])
 const cold=new AgentMuxSpatialStateStore(f.path);expect(await cold.resolveSpaceLink(a.address)).toEqual(ensure().target)
 const next=await f.call('space.link.ensure',ensure()) as any;expect(next.address).toEqual(a.address)
})
it('full root and path-shaped original event tuple remain private and exact',async()=>{
 const f=await fixture(),event='/private/original/event:[]',root=await f.call('space.link.ensure',ensure()) as any,thread=await f.call('space.link.ensure',ensure(event,'thread-original')) as any
 expect(thread.address.linkId).not.toBe(root.address.linkId);expect(thread.url).not.toContain('private');expect(parseAmuxObjectLink(thread.url)).toEqual({kind:'mote',address:thread.address})
 expect(await f.call('space.link.resolve',{address:thread.address})).toMatchObject({target:{runtimeId,spaceId,eventId:event}})
})
it('wrong original Runtime rejects this publication before a spatial write',async()=>{
 const f=await fixture(),before=await readFile(f.path,'utf8');await expect(f.call('space.link.ensure',{...ensure(),target:{runtimeId:'WrongRuntime',spaceId}})).rejects.toMatchObject({code:'RUNTIME_OWNER_MISMATCH'});expect(await readFile(f.path,'utf8')).toBe(before)
})
it('the original publication operation cannot be rebound to another same-name Mote',async()=>{
 const f=await fixture(),a=await f.call('space.link.ensure',ensure()) as any
 await expect(f.call('space.link.ensure',{...ensure(),target:{runtimeId,spaceId:other}})).rejects.toMatchObject({code:'SPACE_LINK_OPERATION_CONFLICT'});expect(await f.store.resolveSpaceLink(a.address)).toEqual(ensure().target)
})
it('ordinary graph commit preserves owner link metadata and rejects a forged binding',async()=>{
 const f=await fixture(),a=await f.call('space.link.ensure',ensure()) as any,current=(await f.store.read())!,input=structuredClone(current.graph)
 delete input.resources[SPACE_LINK_RESOURCE];input.spaces[0]!.name='Renamed original';await f.store.commit({expectedRevision:current.revision,graph:input})
 expect(await f.store.resolveSpaceLink(a.address)).toEqual(ensure().target)
 const saved=(await f.store.read())!,forged=structuredClone(saved.graph);(forged.resources[SPACE_LINK_RESOURCE] as any).records[a.address.linkId].spaceId=other
 await expect(f.store.commit({expectedRevision:saved.revision,graph:forged})).rejects.toMatchObject({code:'SPATIAL_RESOURCE_AUTHORITY_CONFLICT'})
})
it('missing address resolve is read-only and never issues a token',async()=>{
 const f=await fixture(),before=await readFile(f.path,'utf8');expect(await f.call('space.link.resolve',{address:{runtimeId,linkId:'111111111111'}})).toMatchObject({target:null});expect(await readFile(f.path,'utf8')).toBe(before)
})
it('write acknowledgement failure cannot produce a confirmed address; original target can reconfirm',async()=>{
 const f=await fixture(),original=(f.store as any).writeLocked.bind(f.store);vi.spyOn(f.store as any,'writeLocked').mockImplementationOnce(async(...args:any[])=>{await original(...args);throw Error('Original directory ACK lost')})
 await expect(f.call('space.link.ensure',ensure())).rejects.toThrow('Original directory ACK lost')
 const retained=(await f.store.read())!.graph.resources[SPACE_LINK_RESOURCE] as any,id=Object.keys(retained.records)[0]
 const confirmed=await f.call('space.link.ensure',ensure()) as any;expect(confirmed.address.linkId).toBe(id);expect(confirmed.diskDurability).toBe('confirmed')
})
it('strict new and saved legacy URIs remain distinct and old identifiers roundtrip',()=>{
 const old=formatAmuxObjectLink({kind:'mote',spaceId,eventId:'/private/event'});expect(parseAmuxObjectLink(old)).toEqual({kind:'mote',spaceId,eventId:'/private/event'})
 expect(parseAmuxObjectLink('amux://mote/111111111111')).toEqual({kind:'mote',spaceId:'111111111111'})
 for(const bad of ['amux://mote/111111111111?runtime=R&extra=1','amux://mote/111111111111?runtime=R#fragment','amux://mote/111111111111/thread/E?runtime=R','amux://mote/111111111111?runtime=%52'])expect(()=>parseAmuxObjectLink(bad)).toThrow()
})
it('strict public result and query do not misinterpret a token as an original Space ID',async()=>{
 const f=await fixture(),a=await f.call('space.link.ensure',ensure()) as any
 expect(()=>parseSpaceLinkParams('space.link.ensure',{...ensure(),alias:'guessed'})).toThrow()
 expect(()=>parseSpaceLinkResult('space.link.ensure',{...a,target:{...a.target,spaceId:other}},ensure())).toThrow()
 const searched=searchAgentMuxMetadata(a.url,{sessions:[],sources:[],projects:[],catalog:{spaces:[],zones:[],tabs:[],regions:[],bindings:[],locations:[]}} as any);expect(searched.issue).toContain('space link resolve');expect(searched.locations).toEqual([])
})
it('actual command parsers expose original publication/resolve and typed app focus accepts the URI',async()=>{
 expect(agentMuxCommandHelp('space.link.resolve')).toContain('--url');expect(agentMuxModuleSkill('space')).toContain('space link resolve')
 const input=await parseAgentMuxCliCommand(['space','link','ensure','--runtime',runtimeId,'--space',spaceId,'--operation-id','cli-original'])
 expect(input).toMatchObject({method:'space.link.ensure',params:ensure(undefined,'cli-original')})
 const link='amux://mote/111111111111?runtime=OriginalRuntime'
 expect(await parseAgentMuxCliCommand(['space','link','resolve','--url',link])).toMatchObject({method:'space.link.resolve',params:{address:{runtimeId,linkId:'111111111111'}}})
 expect(await parseAgentMuxCliCommand(['app','focus','--mote',link])).toMatchObject({method:'app.focus',params:{target:{kind:'mote',address:{runtimeId,linkId:'111111111111'}}}})
})

it('original operation keys are JSON data without inherited-object aliases',async()=>{
 const f=await fixture();for(const operationId of ['constructor','__proto__']){const issued=await f.call('space.link.ensure',ensure(undefined,operationId)) as any;expect(await f.store.resolveSpaceLink(issued.address)).toEqual(ensure().target)}
})
