import { fixturePath as upstreamFixturePath } from './helpers/fixture-values.js'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, symlink, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { AgentMuxSpatialStateStore, spatialCatalog, resolveSpatialRegion, parseAgentMuxSpatialGraph,
  type AgentMuxSpatialGraph } from '../src/spatial-state.js'
import { createWorkspaceLayout } from '../src/spatial-layout.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'

function graph(): AgentMuxSpatialGraph {
  return {
    spaces:['a','b'].map(spaceId => ({spaceId,kind:'topic',name:spaceId,hostId:'host',directoryPath:upstreamFixturePath("project/")+spaceId,projectId:'project'})),
    zones:[{zoneId:'zone',workspaceId:'resource',kind:'directory',hostId:'host',directoryPath:upstreamFixturePath("project"),branch:null}],
    tabs:[{tabId:'tab',zoneId:'zone',workspaceId:'resource',name:null,regionIds:['agent','browser']}],
    regions:[{regionId:'agent',tabId:'tab',kind:'agent',agentSessionId:'original-session',runId:'original-run',execution:{hostId:'host',cwd:upstreamFixturePath("execution")}},
      {regionId:'browser',tabId:'tab',kind:'browser',agentSessionId:null,runId:null,execution:null}],
    bindings:[{zoneId:'zone',spaceId:'a'},{zoneId:'zone',spaceId:'b'}],
    layouts:{resource:createWorkspaceLayout('g',['tab']),foreign:createWorkspaceLayout('other',['tab'])},
    tabLayouts:{tab:{root:{type:'split',direction:'horizontal',ratio:0.35,first:{type:'leaf',regionId:'agent'},second:{type:'leaf',regionId:'browser'}},activeRegionId:'agent'}},
    resources:{tab:{browserId:'original-browser',draft:'unsaved content'}}
  }
}
const directories: string[] = []
const servers: AgentMuxControlServer[] = []
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(),'amux-spatial-')); directories.push(dir)
  return {dir,store:new AgentMuxSpatialStateStore(join(dir,'spatial-state.json'))}
}
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(); for (const dir of directories.splice(0)) await rm(dir,{recursive:true,force:true}) })
let cli: string, worker: string
beforeAll(async () => {
  const output = resolve('.tmp/durable-spatial-index')
  await mkdir(output, { recursive: true })
  await symlink('../../packages/core/node_modules',join(output,'node_modules'),'dir').catch(error => { if(error.code !== 'EEXIST') throw error })
  cli = join(output,'cli.mjs'); worker = join(output,'worker.mjs')
  const compiled = await build({entryPoints:['packages/core/src/agentmux.ts'],outfile:cli,bundle:true,platform:'node',format:'esm',packages:'external',metafile:true,logLevel:'silent'})
  await writeFile(join(output,'cli-inputs.json'),JSON.stringify(compiled.metafile,null,2))
  await build({stdin:{contents:`import {AgentMuxSpatialStateStore} from './packages/core/src/spatial-state.ts'; const store=new AgentMuxSpatialStateStore(process.argv[2]); const action=process.argv[3]; if(action==='read') console.log(JSON.stringify(await store.read())); else { const input=JSON.parse(process.argv[4]); try{console.log(JSON.stringify(await store.commit(input)))}catch(e){console.log(JSON.stringify({code:e.code}));process.exitCode=2}}`,resolveDir:process.cwd()},outfile:worker,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'})
})
function run(file: string,args: string[],env: NodeJS.ProcessEnv = {},input = '') {
  return new Promise<{code:number;result:any;stderr:string}>((ok,fail) => {
    const child = spawn(process.execPath,[file,...args],{env:{...process.env,AGENTMUX_AGENT_SESSION_ID:undefined,AGENTMUX_AGENT_CAPABILITY:undefined,AGENTMUX_RPC_ENDPOINT:undefined,...env},stdio:['pipe','pipe','pipe']})
    let stdout='',stderr=''; child.stdout.on('data',s => {stdout+=s});child.stderr.on('data',s => {stderr+=s});child.stdin.end(input)
    child.once('error',fail);child.once('close',code => {try{ok({code:code??-1,result:JSON.parse(stdout),stderr})}catch(e){fail(new Error(stdout+'\n'+stderr,{cause:e}))}})
  })
}
describe('Core durable spatial owner without an App',() => {
  it('keeps the complete original graph through two actual process restarts',async () => {
    const {store} = await fixture();const saved = await store.commit({expectedRevision:0,graph:graph()})
    for(let restart=0;restart<2;restart++) expect((await run(worker,[store.path,'read'])).result).toEqual(saved)
    expect(spatialCatalog(saved.graph).locations).toHaveLength(8)
    expect(resolveSpatialRegion(saved.graph,{tabId:'tab',regionId:'agent',direction:'right'})).toMatchObject({region:{regionId:'browser'}})
  })
  it('admits only one of two concurrent writers at the exact original revision',async () => {
    const {store}=await fixture();await store.commit({expectedRevision:0,graph:graph()})
    const a=graph(),b=graph();a.resources.tab={draft:'A'};b.resources.tab={draft:'B'}
    const results=await Promise.all([run(worker,[store.path,'write',JSON.stringify({expectedRevision:1,graph:a})]),run(worker,[store.path,'write',JSON.stringify({expectedRevision:1,graph:b})])])
    expect(results.map(r=>r.code).sort()).toEqual([0,2]);expect(results.find(r=>r.code===2)!.result.code).toBe('SPATIAL_STATE_CONFLICT')
    expect((await store.read())!.revision).toBe(2)
  })
  it('keeps corrupted bytes, the previous valid document and all original entities',async () => {
    const {store}=await fixture();const first=await store.commit({expectedRevision:0,graph:graph()});await store.commit({expectedRevision:1,graph:graph()})
    expect(JSON.parse(await readFile(store.path+'.previous','utf8'))).toEqual(first)
    await writeFile(store.path,'{broken original bytes')
    await expect(store.read()).rejects.toMatchObject({code:'SPATIAL_STATE_READ_UNCONFIRMED'})
    await expect(store.commit({expectedRevision:0,graph:graph()})).rejects.toMatchObject({code:'SPATIAL_STATE_READ_UNCONFIRMED'})
    expect(await readFile(store.path,'utf8')).toBe('{broken original bytes')
  })
  it('refuses empty observation replacement and stale revision without deleting anything',async () => {
    const {store}=await fixture();const saved=await store.commit({expectedRevision:0,graph:graph()});const empty=graph();empty.tabs=[]
    await expect(store.commit({expectedRevision:1,graph:empty})).rejects.toMatchObject({code:'SPATIAL_ENTITY_REMOVAL_UNCONFIRMED'})
    await expect(store.commit({expectedRevision:0,graph:graph()})).rejects.toMatchObject({code:'SPATIAL_STATE_CONFLICT'})
    expect(await store.read()).toEqual(saved)
  })
  it('removes only an exact Group binding and keeps another occurrence and original execution',async () => {
    const {store}=await fixture();await store.commit({expectedRevision:0,graph:graph()})
    const state=await store.bind({kind:'tab-group',tabId:'tab',displayWorkspaceId:'foreign',groupId:'other'},true)
    expect(state.graph.layouts.resource!.groups[0]!.tabOrder).toEqual(['tab']);expect(state.graph.layouts.foreign!.groups[0]!.tabOrder).toEqual([])
    expect(state.graph.tabs).toEqual(graph().tabs);expect(state.graph.regions).toEqual(graph().regions);expect(state.graph.resources).toEqual(graph().resources)
  })
  it('finds original Zone members even when there is no display location',() => {
    const g=graph();g.layouts={}
    const catalog=spatialCatalog(g,{zoneId:'zone'})
    expect(catalog.tabs).toEqual(g.tabs.map(tab => ({ ...tab, nameRevision: 0 })));expect(catalog.regions).toEqual(g.regions);expect(catalog.locations).toEqual([])
  })
  it('preserves the same Tab in two Groups and returns every occurrence without arbitration',async () => {
    const {store}=await fixture();const g=graph();g.layouts.resource={root:{type:'split',direction:'horizontal',ratio:0.5,first:{type:'leaf',groupId:'g'},second:{type:'leaf',groupId:'second'}},groups:[...g.layouts.resource!.groups,{id:'second',tabOrder:['tab'],recentTabIds:[],activeTabId:'tab'}],activeGroupId:'g'}
    await store.commit({expectedRevision:0,graph:g})
    const state=await store.bind({kind:'tab-group',tabId:'tab',displayWorkspaceId:'resource',groupId:'g'},true)
    expect(state.graph.layouts.resource!.groups.find(g=>g.id==='second')!.tabOrder).toEqual(['tab'])
    expect(spatialCatalog(state.graph,{tabId:'tab'}).locations.map(l=>l.groupId)).toContain('second')
    expect(state.graph.regions).toEqual(g.regions)
  })
  it('keeps entity selectors narrow and catches mismatched Group records',() => {
    const g=graph();g.tabs.push({...g.tabs[0]!,tabId:'another',regionIds:[]})
    expect(spatialCatalog(g,{regionId:'agent'}).tabs.map(t=>t.tabId)).toEqual(['tab'])
    const root={type:'split',direction:'horizontal',ratio:0.5,first:{type:'leaf',groupId:'g'},second:{type:'leaf',groupId:'g'}}
    expect(()=>parseAgentMuxSpatialGraph({...g,layouts:{resource:{root,groups:[g.layouts.resource!.groups[0],{id:'second',tabOrder:[],recentTabIds:[],activeTabId:null}],activeGroupId:'g'}}})).toThrow()
  })
  it('rejects unrepresentable resource metadata without silently stripping it',() => {
    expect(()=>parseAgentMuxSpatialGraph({...graph(),resources:{tab:{draft:undefined}}})).toThrow()
    expect(()=>parseAgentMuxSpatialGraph({...graph(),resources:{tab:{ratio:NaN}}})).toThrow()
  })
  it('executes the production CLI and public RPC against the same durable graph without Desktop',async () => {
    const {dir,store}=await fixture();const server=new AgentMuxControlServer({socketPath:join(dir,'control.sock'),spatialState:store,coreClients:()=>[]});servers.push(server);await server.start()
    const env={AGENTMUX_RPC_ENDPOINT:'unix:'+server.path}
    const committed=await run(cli,['space','commit','--revision','0'],env,JSON.stringify(graph()))
    expect(committed.code,committed.stderr).toBe(0);expect(committed.result.result.state.graph).toEqual(graph())
    const read=await run(cli,['space','state'],env);expect(read.code,read.stderr).toBe(0);expect(read.result.result.state.revision).toBe(1)
    const resolved=await run(cli,['space','resolve','--tab','tab','--region','agent','--direction','right'],env)
    expect(resolved.code,resolved.stderr).toBe(0);expect(resolved.result.result.region.regionId).toBe('browser')
    const changed=graph();changed.tabLayouts.tab!.activeRegionId='browser'
    const managed=await run(cli,['space','commit','--revision','1'],env,JSON.stringify(changed))
    expect(managed.code,managed.stderr).toBe(0);expect((await store.read())!.graph.tabLayouts.tab!.activeRegionId).toBe('browser')
    const unbound=await run(cli,['space','unbind','--zone','zone','--space','a'],env)
    expect(unbound.code,unbound.stderr).toBe(0);expect((await store.read())!.graph.bindings).toEqual([{zoneId:'zone',spaceId:'b'}])
    const listed=await run(cli,['space','ls','--zone','zone'],env)
    expect(listed.code,listed.stderr).toBe(0);expect(listed.result.result.catalog.tabs).toEqual(graph().tabs.map(tab => ({ ...tab, nameRevision: 0 })))
    expect((await store.read())!.graph.regions[0]).toEqual(graph().regions[0])
  })
})
