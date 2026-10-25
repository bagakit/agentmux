import { afterEach, expect, it, vi } from 'vitest'
import { executeRendererCache } from '../src/preload/renderer-cache.js'
import { RendererCacheController } from '../src/main/renderer-cache.js'
import { DesktopControlIpcBridge } from '../src/main/control-ipc-bridge.js'
import { createResourceMetricsPort } from '../src/main/resource-usage-control.js'
import { registerPerformanceCaptureIpc } from '../src/main/performance-capture-ipc.js'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service.js'
import { parseAgentMuxCliInvocation } from '../../../packages/core/src/agentmux-cli-commands.js'
import { parseRendererCacheInput, parseRendererCacheResult, type RendererCacheResult } from '../../../packages/core/src/renderer-cache.js'
import { parseRpcControlResult } from '../../../packages/core/src/rpc-business-codec.js'
import type { DesktopControlRequest, DesktopControlResult } from '../src/shared/contracts.js'

const native = vi.hoisted(() => ({ getResourceUsage: vi.fn(), clearCache: vi.fn() }))
vi.mock('electron', () => ({ webFrame: native }))
const target = { windowId: 1, webContentsId: 2, generation: 3, pid: process.pid, creationTime: 1000 }
const original = { images: { count: 1, size: 900, liveSize: 300 }, scripts: { count: 0, size: 0, liveSize: 0 } }
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
function fixture() {
  native.getResourceUsage.mockReset().mockReturnValue(original); native.clearCache.mockReset()
  vi.stubGlobal('process', Object.assign(Object.create(process), { getCreationTime: () => target.creationTime }))
  let current: typeof target | null = { ...target }, deliver: ((r: DesktopControlRequest) => void) | undefined
  const requests: DesktopControlRequest[] = [], cancellations: unknown[] = []
  const bridge = new DesktopControlIpcBridge({ isAvailable: () => true,
    sendRequest: request => { requests.push(request); if (deliver) return deliver(request)
      if (request.operation !== 'metrics.cache.inspect' && request.operation !== 'metrics.cache.reclaim') throw Error('unexpected operation')
      const observation = executeRendererCache({ target: request.target }, request.operation === 'metrics.cache.inspect' ? 'inspect' : 'reclaim')
      bridge.accept({ requestId: request.requestId, ok: true, result: { operation: request.operation, observation } })
    }, sendCancellation: cancellation => { cancellations.push(cancellation) } })
  const cache = new RendererCacheController(bridge, () => current)
  const subscribe = vi.fn(() => { throw Error('No metrics observation may start') })
  const metrics = createResourceMetricsPort({ sampler: { subscribe } as never, currentWindow: () => current, cache })
  return { cache, metrics, bridge, requests, cancellations, subscribe, setCurrent(value: typeof current) { current = value }, setDeliver(value: typeof deliver) { deliver = value } }
}
afterEach(() => { vi.unstubAllGlobals() })
it('reads once without cleanup and maps native decoded bytes without inventing missing counters', async () => {
  const f = fixture(), result = await f.cache.inspect({ target })
  expect(result).toMatchObject({ status: 'completed', action: 'inspect', sourceVerified: { before: true, after: true },
    clear: { requested: false, completed: false }, after: null, before: { usage: { images: {count:1,sizeBytes:900,decodedBytes:300}, scripts:{count:0,sizeBytes:0,decodedBytes:0}, fonts:null } } })
  expect(native.clearCache).not.toHaveBeenCalled(); expect(native.getResourceUsage).toHaveBeenCalledOnce(); expect(f.requests).toHaveLength(1)
})
it('clears exactly once and keeps counter failure independent of native completion', async () => {
  const f = fixture(); native.getResourceUsage.mockImplementation(() => { throw Error('counter unavailable') })
  const result = await f.cache.reclaim({ target })
  expect(result).toMatchObject({ status:'completed', clear:{requested:true,completed:true}, before:null,after:null,issues:[{stage:'before-counters'},{stage:'after-counters'}] })
  expect(native.clearCache).toHaveBeenCalledOnce(); expect(f.requests).toHaveLength(1)
})
it.each(['windowId','webContentsId','generation','pid','creationTime'] as const)('refuses changed initial %s without dispatch or cleanup', async field => {
  const f = fixture()
  await expect(f.cache.reclaim({ target:{...target,[field]:target[field]+1} })).rejects.toMatchObject({code:'CONTROL_OWNER_LOST'})
  expect(f.requests).toHaveLength(0);expect(native.clearCache).not.toHaveBeenCalled()
})
it.each(['windowId','webContentsId','generation','pid','creationTime'] as const)('retains original ack as unknown when %s changes after native execution', async field => {
  const f = fixture(); native.clearCache.mockImplementation(() => { f.setCurrent({...target,[field]:target[field]+1}) })
  expect(await f.cache.reclaim({target})).toMatchObject({status:'unknown',target,clear:{requested:true,completed:true},sourceVerified:{before:true,after:false}})
  expect(native.clearCache).toHaveBeenCalledOnce()
})
it('preload rejects the wrong process identity before reading or clearing', () => {
  fixture()
  for (const field of ['pid','creationTime'] as const) expect(() => executeRendererCache({target:{...target,[field]:target[field]+1}},'reclaim')).toThrow()
  expect(native.clearCache).not.toHaveBeenCalled();expect(native.getResourceUsage).not.toHaveBeenCalled()
})
it.each(['cancel','timeout'] as const)('retains %s uncertainty without replaying a late native reply', async mode => {
  vi.useFakeTimers(); const f = fixture(), abort = new AbortController(); let request!: DesktopControlRequest
  f.setDeliver(r => { request = r })
  const pending = f.cache.reclaim({target},abort.signal)
  if(mode==='cancel')abort.abort(); else await vi.advanceTimersByTimeAsync(2000)
  const result = await pending, saved=JSON.stringify(result)
  expect(result).toMatchObject({status:'unknown',clear:{requested:true,completed:false}})
  const observation=executeRendererCache({target},'reclaim')
  expect(f.bridge.accept({requestId:request.requestId,ok:true,result:{operation:'metrics.cache.reclaim',observation}})).toBe(false)
  expect(JSON.stringify(result)).toBe(saved);expect(f.requests).toHaveLength(1);expect(native.clearCache).toHaveBeenCalledOnce()
})
it('pre-dispatch cancellation touches no native resource; native throw stays unknown', async () => {
  const f=fixture(),abort=new AbortController();abort.abort()
  await expect(f.cache.reclaim({target},abort.signal)).rejects.toThrow();expect(f.requests).toHaveLength(0)
  native.clearCache.mockImplementation(()=>{throw Error('native completion unavailable')})
  expect(await f.cache.reclaim({target})).toMatchObject({status:'unknown',clear:{requested:true,completed:false}})
  expect(native.clearCache).toHaveBeenCalledOnce()
})
it('strict codecs reject foreign action/identity, missing evidence, aliases and getters', async () => {
  const f=fixture(), value=await f.cache.reclaim({target})
  for(const change of [(v:RendererCacheResult)=>{v.target.generation++},(v:RendererCacheResult)=>{v.action='inspect'},(v:RendererCacheResult)=>{v.sourceVerified.after=false},(v:RendererCacheResult)=>{v.clear.completed=false}]){
    const modified=structuredClone(value);change(modified);expect(()=>parseRendererCacheResult(modified,{target},'reclaim')).toThrow()
  }
  expect(()=>parseRendererCacheInput({target,force:true})).toThrow()
  let reads=0; const modified=structuredClone(value);Object.defineProperty(modified.before!.usage.images!,'sizeBytes',{enumerable:true,get(){reads++;return 1}})
  expect(()=>parseRendererCacheResult(modified)).toThrow();expect(reads).toBe(0)
  expect(()=>parseRpcControlResult('system.metrics.cache.inspect',{observation:value},{target})).toThrow()
})
it('joins actual CLI parsing, public service, original metrics port, bridge and preload plus GUI IPC', async () => {
  const f=fixture(), service=new AgentMuxRpcService({metrics:f.metrics, execute:()=>{throw Error('wrong owner')}})
  const invocation=await parseAgentMuxCliInvocation(['system','metrics','cache','reclaim',...Object.entries(target).flatMap(([k,v])=>['--'+k.replace(/[A-Z]/g,c=>'-'+c.toLowerCase()),String(v)])])
  expect(invocation.command.method).toBe('system.metrics.cache.reclaim')
  const reply=await service.call('system.metrics.cache.reclaim',invocation.params as {target:typeof target})
  expect(reply.observation).toMatchObject({status:'completed',clear:{completed:true}});expect(native.clearCache).toHaveBeenCalledOnce()
  const handlers=new Map<string,(_event:never,raw:unknown)=>unknown>()
  registerPerformanceCaptureIpc(f.metrics,(channel,listener)=>handlers.set(channel,listener))
  expect(await handlers.get('metrics:inspectCache')!({} as never,{target})).toMatchObject({status:'completed',action:'inspect'})
  expect(f.requests).toHaveLength(2);expect(f.subscribe).not.toHaveBeenCalled()
  f.metrics.dispose();await expect(f.metrics.reclaimCache!({target})).rejects.toMatchObject({code:'CONTROL_OWNER_LOST'})
  expect(native.clearCache).toHaveBeenCalledOnce()
})

it('runs the actual compiled public CLI for success, unknown, failed, stale target and help without replay', async () => {
  const { mkdtemp,rm,readFile,appendFile }=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join,resolve}=await import('node:path'),{spawn}=await import('node:child_process')
  const { AgentMuxControlServer }=await import('../../../packages/core/src/public-rpc-server.js')
  const { compileRendererProfileCli }=await import('../../../packages/core/test/helpers/renderer-profile-cli.js')
  const directory=await mkdtemp(join(tmpdir(),'cache-cli-')),f=fixture(),server=new AgentMuxControlServer({metrics:f.metrics,coreClients:()=>[]},join(directory,'c.sock'))
  const frozen=process.env.AGENTMUX_PERFORMANCE_SOURCES?JSON.parse(await readFile(process.env.AGENTMUX_PERFORMANCE_SOURCES,'utf8')):{}
  const entry=await compileRendererProfileCli(resolve(import.meta.dirname,'../../..'),directory,frozen,process.env.AGENTMUX_PERFORMANCE_LOADED)
  await server.start()
  const args=Object.entries(target).flatMap(([k,v])=>['--'+k.replace(/[A-Z]/g,c=>'-'+c.toLowerCase()),String(v)])
  const run=async(command:string[])=>{
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(AGENTMUX_|CTXMUX_|CODEX_|ELECTRON_|NODE_OPTIONS$)/u.test(key)))
    const child=spawn(process.execPath,[entry,'--endpoint','unix://'+server.path,...command],{env});let out='',err=''
    child.stdout.on('data',data=>out+=data);child.stderr.on('data',data=>err+=data)
    const code=await new Promise<number|null>((resolve,reject)=>{child.once('close',resolve);child.once('error',reject)})
    if(process.env.RENDERER_CACHE_EVIDENCE)await appendFile(join(process.env.RENDERER_CACHE_EVIDENCE,'cli.ndjson'),JSON.stringify({command,code,out,err})+'\n')
    return{code,out,err}
  }
  try{
    for(const command of [['--help'],['system','metrics','cache','--help'],['system','metrics','cache','reclaim','--help'],['system','--skill']]){
      const help=await run(command);expect(help.code,help.err).toBe(0);expect(help.out).toContain(command.length===1?'amux system':'cache')
      if(command.includes('reclaim')){expect(help.out).toContain('side effect');expect(help.out).toContain('--creation-time')}
    }
    expect(f.requests).toHaveLength(0)
    const invoke=(action:string)=>run(['system','metrics','cache',action,...args])
    const done=await invoke('reclaim');expect(done.code,done.out+done.err).toBe(0);expect(JSON.parse(done.out).result.observation.clear.completed).toBe(true)
    native.clearCache.mockImplementation(()=>{throw Error('completion unknown')})
    const unknown=await invoke('reclaim');expect(unknown.code).toBe(1);expect(JSON.parse(unknown.out).result.observation.status).toBe('unknown')
    native.getResourceUsage.mockImplementation(()=>{throw Error('counter unavailable')})
    const failed=await invoke('inspect');expect(failed.code).toBe(1);expect(JSON.parse(failed.out).result.observation.status).toBe('failed')
    f.setCurrent({...target,generation:target.generation+1})
    const stale=await invoke('reclaim');expect(stale.code).toBe(1);expect(stale.out+stale.err).toContain('CONTROL_OWNER_LOST')
    expect(f.requests).toHaveLength(3);expect(native.clearCache).toHaveBeenCalledTimes(2);expect(f.subscribe).not.toHaveBeenCalled()
  }finally{await server.stop();f.metrics.dispose();f.bridge.dispose();await rm(directory,{recursive:true,force:true})}
},30000)

it('executes the current Main registration and Store control call sites through the original bridge and renderer adapter', async () => {
  const ts=await import('typescript'),{readFile,appendFile}=await import('node:fs/promises'),{createHash}=await import('node:crypto')
  const {createRendererControlApi}=await import('../src/renderer/src/lib/control-api.js')
  const frozen=process.env.AGENTMUX_PERFORMANCE_SOURCES?JSON.parse(await readFile(process.env.AGENTMUX_PERFORMANCE_SOURCES,'utf8')):{}
  const source=async(path:string)=>{const text=frozen[path]??await readFile(path,'utf8');if(process.env.AGENTMUX_PERFORMANCE_LOADED)await appendFile(process.env.AGENTMUX_PERFORMANCE_LOADED,JSON.stringify({path,sha256:createHash('sha256').update(text).digest('hex'),kind:'actual-call-site'})+'\n');return ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true)}
  const find=(file:import('typescript').SourceFile,names:string[])=>{const found=new Map<string,string>();const visit=(node:import('typescript').Node)=>{if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&names.includes(node.name.text)){expect(found.has(node.name.text)).toBe(false);found.set(node.name.text,node.initializer!.getText(file))}ts.forEachChild(node,visit)};visit(file);expect([...found.keys()].sort()).toEqual([...names].sort());return found}
  const store=find(await source('apps/desktop/src/renderer/src/store.ts'),['disposeControl'])
  const main=find(await source('apps/desktop/src/main/ipc.ts'),['cache','metrics'])
  const f=fixture();let requestListener!: (request:DesktopControlRequest)=>void
  const control=createRendererControlApi({onRequest(listener){requestListener=listener;return()=>{}},onCancellation:()=>()=>{},respond:response=>{f.bridge.accept(response)}})
  const dependencies={api:{control,executeRendererCache},get:()=>{throw Error('The original Store cache branch must handle this operation')}}
  const compiled=ts.transpileModule('return '+store.get('disposeControl'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText
  const dispose=new Function(...Object.keys(dependencies),compiled)(...Object.values(dependencies)) as ()=>void
  f.setDeliver(request=>requestListener(request))
  const mainDependencies={RendererCacheController,createResourceMetricsPort,controlBridge:f.bridge,currentRendererCaptureTarget:()=>target,currentMetricsWindow:()=>target,
    args:{runtime:{resourceSampler:{subscribe(){throw Error('No observation may start')}}}},profiler:undefined,tracer:undefined,memory:undefined,animations:undefined,allocations:undefined}
  const mainCode=ts.transpileModule(`const cache=${main.get('cache')};return ${main.get('metrics')}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText
  const metrics=new Function(...Object.keys(mainDependencies),mainCode)(...Object.values(mainDependencies)) as ReturnType<typeof createResourceMetricsPort>
  try{expect(metrics.reclaimCache).toBeTypeOf('function');expect(await metrics.reclaimCache!({target})).toMatchObject({status:'completed',clear:{completed:true}});expect(native.clearCache).toHaveBeenCalledOnce();expect(f.requests).toHaveLength(1)}
  finally{dispose();metrics.dispose();f.metrics.dispose();f.bridge.dispose()}
})
