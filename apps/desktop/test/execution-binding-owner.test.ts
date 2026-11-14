// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
const coreRequire=createRequire(resolve('packages/core/package.json'))
const {build}=coreRequire('esbuild') as typeof import('../../../packages/core/node_modules/esbuild/lib/main')
let output:string,worker:string,cli:string
let sourceHashes:Record<string,string>={}
const processes=new Set<ChildProcess>()
beforeAll(async()=>{
 output=await mkdtemp(resolve('.tmp/execution-binding-owner-'));worker=join(output,'worker.mjs');cli=join(output,'cli.mjs')
 await mkdir(join(output,'node_modules/@agentmux'),{recursive:true})
 for(const name of await readdir(resolve('packages/core/node_modules')))if(!name.startsWith('@'))await symlink(resolve('packages/core/node_modules',name),join(output,'node_modules',name),'dir')
 for(const scope of (await readdir(resolve('packages/core/node_modules'))).filter(n=>n.startsWith('@')&&n!=='@agentmux'))await symlink(resolve('packages/core/node_modules',scope),join(output,'node_modules',scope),'dir')
 for(const name of await readdir(resolve('packages/core/node_modules/@agentmux')))await symlink(resolve('packages/core/node_modules/@agentmux',name),join(output,'node_modules/@agentmux',name),'dir')
 await symlink(resolve('packages/core'),join(output,'node_modules/@agentmux/core'),'dir')
 const built=await build({entryPoints:[resolve('apps/desktop/test/fixtures/execution-binding-owner/worker.ts')],outfile:worker,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent',metafile:true,
 plugins:[{name:'exact-core-source-and-loaded-old-owner',setup(b){
  b.onResolve({filter:/^@agentmux\/core$/},()=>({path:resolve('packages/core/src/errors.ts')}))
  if(process.env.EX_BINDING_OWNER_MUTANT==='old-main-writer')b.onLoad({filter:/\/desktop-execution-bindings\.ts$/},async args=>{
   const original=await readFile(args.path,'utf8'),seam='const bindings = createCoreExecutionBindingClient(runtime)'
   if(original.split(seam).length!==2)throw Error('Mutation seam must load exactly once')
   return {loader:'ts',contents:`import { AgentExecutionBindingService as OldMainOwner } from ${JSON.stringify(resolve('packages/core/src/agent-execution-coordinator.ts'))};\nprocess.send?.({mutantLoaded:'old-main-writer'});\nconsole.error('LOADED_OLD_MAIN_WRITER');\n`+original.replace(seam,"const bindings = new OldMainOwner(process.env.OWNER_TEST_DIRECTORY + '/execution-bindings', { resolveHost: async () => { throw Error('Old Main cannot resolve helpers') } })")}
  })
 }}]})
 const cliBuilt=await build({entryPoints:[resolve('packages/core/src/agentmux.ts')],outfile:cli,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent',metafile:true})
 sourceHashes=Object.fromEntries(await Promise.all(Object.keys({...built.metafile!.inputs,...cliBuilt.metafile!.inputs}).map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')])) )
},30000)
afterAll(async()=>{for(const child of processes)child.kill('SIGKILL');if(output)await rm(output,{recursive:true,force:true})})
async function launch(mode:'core'|'main',directory:string){
 const child=spawn(process.execPath,[worker,mode,directory],{stdio:['ignore','pipe','pipe','ipc'],env:Object.fromEntries(Object.entries({...process.env,OWNER_TEST_DIRECTORY:directory}).filter(([key])=>!key.startsWith('AGENTMUX_')&&!key.startsWith('CTXMUX_')))})
 processes.add(child);let stderr='',sequence=0,loadedMutant=false
 child.stderr!.on('data',value=>{stderr+=value;if(String(value).includes('LOADED_OLD_MAIN_WRITER'))console.error('LOADED_OLD_MAIN_WRITER')})
 const pending=new Map<number,{resolve(value:any):void;reject(error:unknown):void}>()
 let ready!:(v:any)=>void,rejectReady!:(e:unknown)=>void
 const opening=new Promise<any>((yes,no)=>{ready=yes;rejectReady=no})
 child.on('message',(raw:any)=>{if(raw.mutantLoaded==='old-main-writer'){loadedMutant=true;return}if(raw.ready){ready(raw);return}const call=pending.get(raw.id);if(!call)return;pending.delete(raw.id);raw.error?call.reject(Object.assign(Error(raw.error.message),raw.error)):call.resolve(raw.result)})
 child.once('exit',code=>{processes.delete(child);const error=Error(`${mode} exited ${code}: ${stderr}`);rejectReady(error);for(const p of pending.values())p.reject(error);pending.clear()})
 await opening
 const call=(name:string,value?:unknown)=>new Promise<any>((yes,no)=>{const id=++sequence;pending.set(id,{resolve:yes,reject:no});child.send({id,name,value},error=>{if(error){pending.delete(id);no(error)}})})
 const close=async()=>{if(!processes.has(child))return;await call('close');if(child.exitCode===null)await new Promise<void>(yes=>child.once('exit',()=>yes()))}
 return {call,close,pid:child.pid!,loadedMutant}
}
async function observeCli(directory:string) {
 const file=join(directory,'watch.json');await writeFile(file,JSON.stringify({bindingId:'original-binding'}))
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENTMUX_')&&!key.startsWith('CTXMUX_')))
 const child=spawn(process.execPath,[cli,'agent','execution','watch','--input',file],{stdio:['ignore','pipe','pipe'],env:{...env,AGENTMUX_RPC_ENDPOINT:'unix:'+join(directory,'core.sock')}})
 processes.add(child);let buffer='',stderr='',resolveOpening!:(v:any)=>void,rejectOpening!:(e:unknown)=>void
 const opening=new Promise<any>((yes,no)=>{resolveOpening=yes;rejectOpening=no})
 child.stderr!.on('data',chunk=>{stderr+=chunk})
 child.stdout!.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const frame=JSON.parse(line);if(frame.result?.initial)resolveOpening(frame)}catch{rejectOpening(Error('Invalid CLI frame: '+line))}}})
 const ended=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(yes=>child.once('exit',(code,signal)=>{processes.delete(child);rejectOpening(Error('CLI ended before opening: '+stderr));yes({code,signal})}))
 child.once('error',rejectOpening)
 const timeout=setTimeout(()=>{child.kill('SIGKILL');rejectOpening(Error('CLI opening timed out: '+stderr))},10000)
 try {const frame=await opening;child.kill('SIGTERM');const exit=await ended;expect(exit).toEqual({code:0,signal:null});return {pid:child.pid,opening:frame,exit}}
 finally{clearTimeout(timeout);if(processes.has(child))child.kill('SIGKILL')}
}
it('keeps one Core writer and exact nonempty work across actual Main and Core process restarts',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'amux-owner-proof-'))
 const pids:{mode:string;pid:number;loadedMutant:boolean}[]=[]
 let firstMainError:unknown,mainBeforeCoreError:unknown,cliObservation:unknown
 const start=async(mode:'core'|'main')=>{const child=await launch(mode,directory);pids.push({mode,pid:child.pid,loadedMutant:child.loadedMutant});return child}
 let core:Awaited<ReturnType<typeof launch>>|undefined,main:Awaited<ReturnType<typeof launch>>|undefined
 try {
  core=await start('core');const originalSpatial=await core.call('seed')
  await expect(core.call('freeze')).rejects.toMatchObject({code:'EXECUTION_HELPER_UNAVAILABLE'})
  main=await start('main');expect(main.pid).not.toBe(core.pid)
  // First Main write must reach the Core's controlled preparation leaf, thereby
  // proving delegation while preserving the already frozen full authored intent.
  await expect(main.call('create').catch(error=>{firstMainError={code:error.code,message:error.message};throw error})).rejects.toMatchObject({code:'EXECUTION_HELPER_UNAVAILABLE',executionFailure:{reference:{bindingId:'original-binding',agentSessionId:'original-sid',createOperationId:'original-cid'}}})
  const frozen=await main.call('inspect');expect(frozen).toMatchObject({bindingId:'original-binding',agentSessionId:'original-sid',continuation:{createOperationId:'original-cid'},helperStarts:{executor:{outcome:'not-submitted',runId:null},frontend:{outcome:'not-submitted',runId:null}},association:{}})
  expect(await core.call('facts')).toMatchObject({prepares:2,starts:0,agents:0,spatial:originalSpatial})
  cliObservation=await observeCli(directory);expect(cliObservation).toMatchObject({opening:{result:{method:'agent.execution.watch',initial:{bindingId:'original-binding',inspection:{agentSessionId:'original-sid',continuation:{bindingId:'original-binding',createOperationId:'original-cid'}}}}}})
  expect(await main.call('inspect')).toEqual(frozen);expect(await core.call('facts')).toMatchObject({prepares:2,starts:0,agents:0})
  await main.call('watch');await expect.poll(async()=>(await main!.call('facts')).observations.length).toBe(1)
  expect((await main.call('facts')).observations[0]).toMatchObject({bindingId:'original-binding',agentSessionId:'original-sid'})
  // A later explicit original creation attempt emits a live update. Watching
  // itself did no resolve/preparation/Start work.
  await expect(main.call('create')).rejects.toMatchObject({code:'EXECUTION_HELPER_UNAVAILABLE'})
  await expect.poll(async()=>(await main!.call('facts')).observations.length).toBeGreaterThan(1)
  await main.call('release');const corePid=core.pid;await main.close();main=undefined
  expect((await core.call('facts')).pid).toBe(corePid)
  main=await start('main');expect(await main.call('inspect')).toEqual(frozen)
  expect(await core.call('facts')).toMatchObject({prepares:3,starts:0,agents:0,spatial:originalSpatial})
  await main.call('watch');await expect.poll(async()=>(await main!.call('facts')).observations.length).toBe(1)
  await core.close();core=undefined
  await expect.poll(async()=>(await main!.call('facts')).errors.length).toBeGreaterThan(0)
  await main.close();main=undefined
  // Main-first restart reuses the same nonempty spatial/intent directory.
  main=await start('main');await expect(main.call('inspect').catch(error=>{mainBeforeCoreError={code:error.code,message:error.message};throw error})).rejects.toMatchObject({code:'CONTROL_UNAVAILABLE'})
  core=await start('core');expect(core.pid).not.toBe(corePid)
  expect(await core.call('facts')).toMatchObject({prepares:0,starts:0,agents:0,spatial:originalSpatial})
  const restored=await main.call('inspect');expect(restored).toMatchObject({bindingId:frozen.bindingId,agentSessionId:frozen.agentSessionId,continuation:frozen.continuation,helperStarts:frozen.helperStarts,association:frozen.association})
  // A conflicting complete packet proves the original frozen prompt/revision
  // was retained, rather than reconstructing a matching SID from current config.
  const conflict={bindingId:'original-binding',agentHostId:'agent-host',agentRuntimeId:'agent-core',resourceHostId:'resource-host',resourceRuntimeId:'resource-core',resourceWorkspacePath:'/original/project',resourceGrant:{scope:'host-user',bindingId:'original-binding'},agent:{agentSessionId:'original-sid',createOperationId:'original-cid',executorId:'selected',executorRevision:'frozen-revision',workspacePath:'/original/agent',prompt:'replacement input'}}
  await expect(main.call('create',conflict)).rejects.toThrow('another original creation')
  expect(await main.call('inspect')).toEqual(restored)
  const finalFacts=await core.call('facts');expect(finalFacts).toMatchObject({prepares:0,starts:0,agents:0,spatial:originalSpatial})
  if(process.env.OWNER_TEST_EVIDENCE)await writeFile(process.env.OWNER_TEST_EVIDENCE,JSON.stringify({passed:true,pids,firstMainError,mainBeforeCoreError,cliObservation,sourceHashes,originalSpatial,restored,finalFacts,boundary:'Real private Core/Main processes, production BindingService/Unix server/SDK/Main factory/IPC/Preload; controlled Runtime routing, preparation/Native leaves. Spatial resource draft retained. Renderer draft and Native continuity require unchanged existing evidence; not certified here.'},null,2)+'\n')
 }finally{
  if(process.env.OWNER_TEST_MUTANT_EVIDENCE)await writeFile(process.env.OWNER_TEST_MUTANT_EVIDENCE,JSON.stringify({pids,firstMainError,sourceHashes},null,2)+'\n')
  try{await main?.close()}finally{try{await core?.close()}finally{await rm(directory,{recursive:true,force:true})}}
 }
},30000)
