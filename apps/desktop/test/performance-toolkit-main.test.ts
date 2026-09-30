import { EventEmitter } from 'node:events'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, readFile, appendFile, rm, readdir, stat, symlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { promisify } from 'node:util'
import { createConnection } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ directory: process.env.AGENTMUX_TOOLKIT_EVIDENCE ?? process.cwd(), handlers: new Map<string, (...args: any[]) => unknown>(),
  ipc: new (class { listeners = new Map<string, Set<Function>>() })(),
  packaged:false,appPath:undefined as string|undefined,
  rendererRequest: undefined as undefined | ((request: any) => void), rendererCancel: undefined as undefined | ((request: any) => void) }))
vi.mock('electron', () => ({ app: { get isPackaged(){return fixture.packaged},getAppPath: () => fixture.appPath??process.cwd() + '/apps/desktop', getPath: () => fixture.directory, getAppMetrics: () => [] },
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => unknown) => fixture.handlers.set(channel, handler),
    removeHandler: (channel: string) => fixture.handlers.delete(channel),
    on: (channel: string, handler: Function) => { const values = fixture.ipc.listeners.get(channel) ?? new Set(); values.add(handler); fixture.ipc.listeners.set(channel, values) },
    removeListener: (channel: string, handler: Function) => fixture.ipc.listeners.get(channel)?.delete(handler) },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {} }))
vi.mock('@agentmux/demand', async original => ({ ...await original(), openDemandStore: () => ({}) }))
vi.mock('../src/main/browser-profile-manager.js', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal.js', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private-journal.json',
  BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store.js', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager.js', () => ({ BrowserViewManager: class {
  resourceProcessIds() { return [] } resourceOwnerCounts() { return { browserViews: 0, releasedBrowserViews: 0 } } dispose() {}
} }))
vi.mock('../src/main/agent-notifier.js', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))

import { AgentMuxMemoryAgentSessionStore, AgentMuxClient, requestAgentMuxControl, subscribeAgentMuxToolkit, subscribeAgentMuxMetrics } from '@agentmux/core'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type ToolkitSnapshot } from '@agentmux/core/control'
import { registerIpc } from '../src/main/ipc.js'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store.js'
import { ProcessResourceSampler } from '../src/main/process-resource-sampler.js'
import * as assets from '../src/main/toolkit-asset.js'
import { SESSION_EVENT_CHANNEL } from '../src/shared/contracts.js'
import * as terminalQueries from '../src/shared/terminal-osc-color-query.js'
import { CtxmuxClient, PROTOCOL_VERSION } from '../../../packages/core/node_modules/@ctxmux/sdk/dist/index.js'

const children: ChildProcess[] = [], cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGTERM')
  for (const close of cleanups.splice(0).reverse()) await close()
  fixture.packaged=false;fixture.appPath=undefined
  vi.restoreAllMocks()
})
async function until(check: () => void | Promise<void>, ms = 10000) {
  const end = Date.now() + ms
  for (;;) { try { await check(); return } catch (error) { if (Date.now() > end) throw error; await new Promise(resolve => setTimeout(resolve,20)) } }
}
function cli(...args: string[]) {
  expect(process.env.AGENTMUX_TOOLKIT_CLI).toBeTruthy()
  const child = spawn(process.execPath, [process.env.AGENTMUX_TOOLKIT_CLI!,...args], { env:process.env, stdio:['ignore','pipe','pipe'] })
  children.push(child)
  let stdout = '', stderr = '', code: number | null | undefined
  child.stdout!.on('data', b => { stdout += b }); child.stderr!.on('data', b => { stderr += b }); child.once('close', value => { code = value })
  return { child, get code() {return code}, get stdout() {return stdout}, get stderr() {return stderr},
    frames: () => stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)) }
}
async function oneCli(...args: string[]) {
  const c=cli(...args);await until(()=>expect(c.code).not.toBeUndefined())
  expect(c.code, c.stderr).toBe(0);const frames=c.frames();expect(frames).toHaveLength(1);return frames[0]
}
async function nativeMain() {
  const directory = await mkdtemp('/tmp/amx-tk-')
  fixture.directory = process.env.AGENTMUX_TOOLKIT_EVIDENCE ?? directory
  fixture.handlers.clear();fixture.ipc.listeners.clear()
  const names=['AGENTMUX_RUNTIME_DIRECTORY','AGENTMUX_STATE_DIRECTORY','AGENTMUX_MESSAGE_QUEUE_PATH','AGENTMUX_AGENT_SESSION_STORE'] as const
  const old=Object.fromEntries(names.map(n=>[n,process.env[n]]))
  process.env.AGENTMUX_RUNTIME_DIRECTORY=directory;process.env.AGENTMUX_STATE_DIRECTORY=join(directory,'state')
  process.env.AGENTMUX_MESSAGE_QUEUE_PATH=join(directory,'queue.ndjson');process.env.AGENTMUX_AGENT_SESSION_STORE=join(directory,'agent-sessions.json')
  cleanups.push(async()=>{for(const n of names) if(old[n]===undefined)delete process.env[n];else process.env[n]=old[n]})
  await mkdir(join(directory,'work'))
  vi.spyOn(assets,'performanceLaunch').mockReturnValue({ runner:process.execPath, cli:process.env.AGENTMUX_TOOLKIT_CLI!,
    script:process.env.AGENTMUX_TOOLKIT_ASSET ?? resolve('apps/desktop/resources/toolkit/performance.mjs'),cwd:join(directory,'work'),env:{ELECTRON_RUN_AS_NODE:'1'} })
  const sampler=new ProcessResourceSampler()
  const runtime=new RuntimeController(new AgentMuxMemoryAgentSessionStore(),undefined,sampler)
  const store=new ConfigStore(join(directory,'config.json'));await store.save(structuredClone(DEFAULT_CONFIG));const config=await store.get()
  const sender=new class extends EventEmitter {
    readonly id=71;readonly mainFrame={framesInSubtree:[]};readonly events: {channel:string;value:any}[]=[]
    isDestroyed(){return false} isLoadingMainFrame(){return false}
    send(channel:string,value:any){this.events.push({channel,value})}
  }()
  const detachRenderer=runtime.attach(sender as any)
  const dispose=await registerIpc({window:{id:7,isDestroyed:()=>false,webContents:sender} as any,runtime,configStore:store,
    progressLoops:{subscribe:()=>()=>{}} as any,scratchTopics:{} as any,workspaceFiles:{dispose:async()=>{}} as any})
  const sdk=new CtxmuxClient({socketPath:join(directory,'ctxmux.sock')})
  cleanups.push(async()=>{
    await dispose()
    // Exact private fixture cleanup uses the public SDK, independently of any Source mutant.
    // Its corrective actions are recorded, never counted as the product oracle.
    for(const run of await sdk.list().catch(()=>[])) {
      if(run.state.type==='running') {
        // A completed Stop receipt may precede its terminal metadata. Reuse the
        // observed dead process instead of submitting a conflicting new Stop.
        if(run.pid!==null && !alive(run.pid)) await until(async()=>expect((await sdk.status(run.id)).state.type).not.toBe('running'))
        else await sdk.stop(await sdk.prepareStop(run.id))
      }
      await sdk.remove(run.id)
      await record('fixture-cleanup',{runId:run.id,corrective:true})
    }
    detachRenderer();await runtime.dispose();sampler.dispose()
    const ownDaemons=(await processes()).filter(p=>p.command.includes('ctxmuxd --socket '+join(directory,'ctxmux.sock')))
    for(const daemon of ownDaemons) {process.kill(daemon.pid,'SIGTERM');await until(()=>expect(alive(daemon.pid)).toBe(false))}
    await rm(directory,{recursive:true,force:true})
  })
  const core=(runtime as any).hosts.get('local').client as AgentMuxClient
  const controlPath=join(directory,'control.sock')
  const request=(operation:any)=>({schemaVersion:AGENTMUX_CONTROL_SCHEMA_VERSION,requestId:crypto.randomUUID(),operation,toolId:'performance'})
  const call=(operation:any)=>requestAgentMuxControl(request(operation) as any,controlPath)
  const invoke=(channel:string,...args:any[])=>fixture.handlers.get(channel)!({sender},...args)
  return {directory,runtime,sampler,store,config,sender,dispose,core,sdk,controlPath,request,call,invoke}
}
async function record(name:string,value:unknown) {
  if(process.env.AGENTMUX_TOOLKIT_EVIDENCE)await appendFile(join(process.env.AGENTMUX_TOOLKIT_EVIDENCE!,name+'.jsonl'),JSON.stringify(value)+'\n')
}
const exec=promisify(execFile)
async function processes() {
  const {stdout}=await exec('/bin/ps',['-eo','pid=,ppid=,command='])
  return stdout.trim().split('\n').map(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u)!;return {pid:Number(m[1]),ppid:Number(m[2]),command:m[3]!}})
}
async function executionGroup(pid:number) {
  const rows=await processes(),ids=new Set([pid]);let count=-1
  while(count!==ids.size){count=ids.size;for(const p of rows)if(ids.has(p.ppid))ids.add(p.pid)}
  return rows.filter(p=>ids.has(p.pid))
}
function alive(pid:number){try{process.kill(pid,0);return true}catch{return false}}
function terminalMetadata(core:AgentMuxClient) {
  const inner=core as unknown as {runPids:Map<string,number>;endedRuns:Map<string,unknown>;stopRequestedRuns:Set<string>}
  return {runPids:[...inner.runPids].sort(),endedRuns:[...inner.endedRuns].sort(),stopRequestedRuns:[...inner.stopRequestedRuns].sort()}
}
async function storage(directory:string):Promise<{path:string;bytes:number}[]> {
  const files:{path:string;bytes:number}[]=[]
  for(const item of await readdir(directory,{withFileTypes:true})) {
    const path=join(directory,item.name)
    if(item.isDirectory())files.push(...await storage(path));else if(item.isFile())files.push({path,bytes:(await stat(path)).size})
  }
  return files
}

describe('registered Main official Performance vertical slice',()=>{
  it('actual production asset helper reads packaged app resources and invokes the current compiled CLI from the exact app topology',async()=>{
    const directory=await mkdtemp('/tmp/amx-toolkit-package-'),root=join(directory,'Contents','Resources','app')
    cleanups.push(()=>rm(directory,{recursive:true,force:true}))
    await mkdir(join(root,'resources','toolkit'),{recursive:true});await mkdir(join(root,'node_modules','@agentmux','core','dist'),{recursive:true})
    await symlink(resolve('apps/desktop/resources/toolkit/performance.mjs'),join(root,'resources','toolkit','performance.mjs'))
    await symlink(process.env.AGENTMUX_TOOLKIT_CLI!,join(root,'node_modules','@agentmux','core','dist','agentmux.js'))
    fixture.packaged=true;fixture.appPath=root
    const launch=assets.performanceLaunch()
    expect(launch.script).toBe(join(root,'resources','toolkit','performance.mjs'))
    expect(launch.cli).toBe(join(root,'node_modules','@agentmux','core','dist','agentmux.js'))
    const script=await assets.readPerformanceScript(launch)
    expect(script.text).toBe(await readFile(resolve('apps/desktop/resources/toolkit/performance.mjs'),'utf8'))
    expect(script.sha256).toMatch(/^[a-f0-9]{64}$/u)
    const help=await exec(launch.runner,[launch.cli,'toolkit','watch','--help'],{env:{...process.env,...launch.env}})
    expect(help.stdout.trim().length).toBeGreaterThan(30)
    await record('packaged-topology',{root,launch,sha256:script.sha256,help:help.stdout})
  })
  it('actual CLI/help/asset, shared consumers and ten native closed/reopen retirements preserve an external metrics observer and healthy Run',async()=>{
    const m=await nativeMain()
    const before=await readFile(join(m.directory,'config.json'))
    const healthy=await m.runtime.launchTerminal({hostId:'local',workspacePath:join(m.directory,'work'),shellCommand:'cat'},m.config)
    expect(healthy.kind).toBe('terminal');const healthyRef=healthy.control.run
    const original=(await m.core.listRuns()).find(run=>run.runId===healthyRef.runId)
    expect(original?.state).toBe('running');expect(original?.pid).toBeGreaterThan(0)
    const baseline=(await m.core.listRuns()).map(run=>run.runId)
    expect(baseline).toContain(healthyRef.runId)
    expect(m.sender.events.filter(e=>e.channel===SESSION_EVENT_CHANNEL && e.value.event?.run?.runId===healthyRef.runId).length).toBeGreaterThan(0)
    const scan=vi.spyOn(terminalQueries,'scanTerminalOscColorQueries')
    const baselineMetadata=terminalMetadata(m.core)
    expect(baselineMetadata.runPids.map(([id])=>id)).toContain(healthyRef.runId)
    const runningRemoval=await m.core.removeTerminal(healthyRef).then(()=>({accepted:true}),error=>({accepted:false,code:error.code}))
    expect(runningRemoval).toMatchObject({accepted:false,code:expect.stringMatching(/^CTXMUX_/u)})
    for(const verb of ['list','get','script','run','stop','watch']) {
      const h=cli('toolkit',verb,'--help');await until(()=>expect(h.code).not.toBeUndefined());expect(h.code,h.stderr).toBe(0);expect(h.stdout.trim().length).toBeGreaterThan(30)
    }
    expect((await oneCli('toolkit','list')).result.tools).toEqual([{toolId:'performance',name:'Performance',readonly:true}])
    const script=(await oneCli('toolkit','script','performance')).result.script
    expect(script.text).toBe(await readFile(process.env.AGENTMUX_TOOLKIT_ASSET ?? resolve('apps/desktop/resources/toolkit/performance.mjs'),'utf8'))
    expect(script.sha256).toMatch(/^[a-f0-9]{64}$/u)
    const external:unknown[]=[]
    const metric=await subscribeAgentMuxMetrics({schemaVersion:AGENTMUX_CONTROL_SCHEMA_VERSION,requestId:'external',operation:'metrics.watch'},{
      onFrame:frame=>{if(frame.event==='snapshot')external.push(frame.result.observation)},onEnd:()=>{}
    },{path:m.controlPath})
    cleanups.push(async()=>metric.dispose())
    let snapshots:ToolkitSnapshot[]=[], endError:Error|undefined
    const watcher=await subscribeAgentMuxToolkit(m.request('toolkit.watch') as any,{onFrame:f=>{if(f.event==='snapshot')snapshots.push(f.result.snapshot)},onEnd:e=>{endError=e}},{path:m.controlPath})
    cleanups.push(async()=>watcher.dispose())
    await until(()=>{expect(endError).toBeUndefined();expect(snapshots.filter(v=>v.sequence>0).length).toBeGreaterThanOrEqual(2)},15000)
    expect(scan).not.toHaveBeenCalled()
    const execution=snapshots.at(-1)!.executionId,ref=snapshots.at(-1)!.run!
    expect(ref.runId).not.toBe(healthyRef.runId);expect((await m.core.listRuns()).length).toBe(baseline.length+1)
    await m.invoke('toolkit:observe','actual-ui-lease')
    expect((await m.call('toolkit.get')).result).toMatchObject({snapshot:{executionId:execution,consumerCount:2}})
    await m.invoke('toolkit:release','actual-ui-lease')
    expect((await m.call('toolkit.get')).result).toMatchObject({snapshot:{executionId:execution,consumerCount:1}})
    expect(snapshots.at(-1)!.observation!.process.data!.length).toBeGreaterThan(0)
    const manual=(await oneCli('toolkit','run','performance')).result.snapshot
    expect(manual.executionId).toBe(execution)
    const ownPid=(await m.sdk.status(ref.runId as any)).pid!;expect(ownPid).toBeGreaterThan(0)
    const group=await executionGroup(ownPid)
    expect(group.length).toBeGreaterThanOrEqual(2)
    expect(group.some(p=>p.command.includes('metrics watch'))).toBe(true)
    watcher.dispose()
    await until(()=>expect((m.sampler as any).subscribers.size).toBe(2))
    expect((await m.call('toolkit.get')).result).toMatchObject({snapshot:{manual:true,consumerCount:0,state:'observing'}})
    let sequence=manual.sequence
    for(let n=0;n<3;n++){
      let current!:ToolkitSnapshot
      for(let attempt=0;attempt<150;attempt++){
        current=(await m.call('toolkit.get') as any).result.snapshot
        if(current.sequence>sequence)break
        await new Promise(resolve=>setTimeout(resolve,20))
      }
      expect(current.sequence).toBeGreaterThan(sequence);sequence=current.sequence
      const native=await m.sdk.status(ref.runId as any),files=await storage(join(m.directory,'state','ctxmux'))
      expect(native.latest_output_bytes).toBeGreaterThan(0);expect(native.durable_output_bytes).not.toBeNull()
      await record('storage-trend',{n,observedAt:Date.now(),sequence,runId:ref.runId,
        latestOutputBytes:native.latest_output_bytes,durableOutputBytes:native.durable_output_bytes,firstAvailableByte:native.first_available_byte,files})
    }
    expect((await oneCli('toolkit','stop','performance')).result.snapshot.state).toBe('paused')
    await until(()=>expect(group.filter(p=>alive(p.pid))).toEqual([]))
    expect(terminalMetadata(m.core)).toEqual(baselineMetadata)
    await record('execution-group',{phase:'explicit-stop',group,allExited:true})
    for(let n=0;n<10;n++){
      const seen:ToolkitSnapshot[]=[]
      const lease=await subscribeAgentMuxToolkit(m.request('toolkit.watch') as any,{onFrame:f=>{if(f.event==='snapshot')seen.push(f.result.snapshot)},onEnd:e=>{endError=e}},{path:m.controlPath})
      await until(()=>{expect(endError).toBeUndefined();expect(seen.some(v=>v.sequence>0)).toBe(true)},15000)
      const own=seen.at(-1)!.run!;expect(own.runId).toBeTruthy()
      const ownProcess=(await m.core.listRuns()).find(run=>run.runId===own.runId);expect(ownProcess?.pid).toBeGreaterThan(0)
      const closedGroup=await executionGroup(ownProcess!.pid!)
      expect(closedGroup.length).toBeGreaterThanOrEqual(2)
      lease.dispose()
      await until(()=>expect((m.sampler as any).subscribers.size).toBe(1))
      try {await until(async()=>expect((await m.core.listRuns()).map(run=>run.runId).sort()).toEqual([...baseline].sort()))}
      catch(error){await record('cleanup-failure',{list:await m.core.listRuns(),snapshot:(await m.call('toolkit.get') as any).result});throw error}
      expect((await m.core.listRuns()).find(run=>run.runId===healthyRef.runId)?.pid).toBe(original?.pid)
      await until(()=>expect(closedGroup.filter(p=>alive(p.pid))).toEqual([]))
      // Removal plus an event-loop turn settle the real Attachment pump.
      await new Promise<void>(resolve=>setImmediate(resolve))
      expect(terminalMetadata(m.core)).toEqual(baselineMetadata)
      const leaked=m.sender.events.filter(e=>e.channel===SESSION_EVENT_CHANNEL&&e.value?.event?.type==='terminal-output'&&e.value?.event?.run?.runId===own.runId)
      expect(leaked).toEqual([])
      await record('cycles',{n,ownRun:own.runId,ownPid:ownProcess?.pid,remaining:(await m.core.listRuns()).map(run=>run.runId),external:external.length,
        metadata:terminalMetadata(m.core),baselineMetadata})
    }
    expect(external.length).toBeGreaterThan(2)
    metric.dispose()
    await until(()=>expect((m.sampler as any).subscribers.size).toBe(0))
    expect((m.sampler as any).timer).toBeNull()
    expect(await readFile(join(m.directory,'config.json'))).toEqual(before)
    const final=await m.core.listRuns();expect(final).toHaveLength(baseline.length);expect(final[0]?.state).toBe('running')
    await m.core.attachTerminal(healthyRef.runId)
    const beforeInput=(await m.sdk.status(healthyRef.runId as any)).applied_input_bytes!
    const ack=await m.core.writeTerminal(healthyRef,{ownerInstanceId:await m.sdk.daemonInstance(),operationId:crypto.randomUUID(),expectedByte:beforeInput,data:'healthy-after-toolkit\n'})
    expect(ack.acceptedThroughByte).toBeGreaterThan(beforeInput)
    const healthReplay=await m.core.readRunReplay(healthyRef)
    expect(healthReplay.replay.map(c=>Buffer.from(c.dataBytes).toString()).join('')).toContain('healthy-after-toolkit')
    await until(()=>expect(scan).toHaveBeenCalled())
    await m.core.stopTerminal(healthyRef)
    await m.core.releaseRunAttachment(healthyRef)
    await m.core.removeTerminal(healthyRef)
    expect(await m.core.listRuns()).toEqual([])
    expect(terminalMetadata(m.core)).toEqual({runPids:[],endedRuns:[],stopRequestedRuns:[]})
    await record('native',{identity:m.core.runtimeIdentity(),script,observations:snapshots.length,external:external.length,cycles:10})
  })
  it('normal registered Main disposal releases a running manual execution and its actual CLI group',async()=>{
    const m=await nativeMain()
    const snapshot=(await oneCli('toolkit','run','performance')).result.snapshot as ToolkitSnapshot
    expect(snapshot.manual).toBe(true);expect(snapshot.run?.runId).toBeTruthy()
    let current!:ToolkitSnapshot
    for(let attempt=0;attempt<150;attempt++){
      current=(await m.call('toolkit.get') as any).result.snapshot
      if(current.sequence>=2)break
      await new Promise(resolve=>setTimeout(resolve,20))
    }
    expect(current.sequence).toBeGreaterThanOrEqual(2)
    const group=await executionGroup((await m.sdk.status(current.run!.runId as any)).pid!)
    expect(group.length).toBeGreaterThanOrEqual(2)
    await m.dispose()
    expect(await m.sdk.list()).toEqual([])
    await until(()=>expect(group.filter(p=>alive(p.pid))).toEqual([]))
    expect((m.sampler as any).subscribers.size).toBe(0);expect((m.sampler as any).timer).toBeNull()
    await record('execution-group',{phase:'registered-Main-dispose',group,allExited:true})
  })
  it('actual public terminal removal rejects an ended Run held by a slow raw Attachment without tearing down its pin',async()=>{
    const m=await nativeMain(),run=await m.core.createTerminal({createOperationId:crypto.randomUUID(),workspacePath:join(m.directory,'work'),
      command:process.execPath,args:['-e',"process.stdout.write('x'.repeat(512*1024));setInterval(()=>{},1000)"]})
    const ref={runId:run.runId}
    for(let n=0;n<200;n++){if((await m.sdk.status(run.runId as any)).latest_output_bytes>=512*1024)break;await new Promise(resolve=>setTimeout(resolve,10))}
    expect((await m.sdk.status(run.runId as any)).latest_output_bytes).toBeGreaterThanOrEqual(512*1024)
    const socket=createConnection(join(m.directory,'ctxmux.sock'));cleanups.push(()=>{socket.destroy();return Promise.resolve()})
    await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject)})
    const hello= new Promise<any>((resolve,reject)=>{let text='';const read=(b:Buffer)=>{text+=b.toString();if(text.includes('\n')){socket.off('data',read);socket.pause();resolve(JSON.parse(text.split('\n')[0]!))}};socket.on('data',read);socket.once('error',reject)})
    socket.write(JSON.stringify({type:'hello',hello:{protocol:PROTOCOL_VERSION}})+'\n')
    expect((await hello).type).toBe('hello')
    socket.write(JSON.stringify({type:'request',request:{type:'attach',id:run.runId,after_byte:0,view:'raw'}})+'\n')
    for(let n=0;n<200;n++){if((await m.sdk.status(run.runId as any)).attachments>0)break;await new Promise(resolve=>setTimeout(resolve,10))}
    expect((await m.sdk.status(run.runId as any)).attachments).toBeGreaterThan(0)
    await m.core.stopTerminal(ref)
    await until(async()=>expect((await m.sdk.status(run.runId as any)).state.type).toBe('exited'))
    await expect(m.core.removeTerminal(ref)).rejects.toMatchObject({code:'CTXMUX_backend_unavailable'})
    expect((await m.sdk.status(run.runId as any)).attachments).toBeGreaterThan(0)
    socket.destroy()
    for(let n=0;n<200;n++){if((await m.sdk.status(run.runId as any)).attachments===0)break;await new Promise(resolve=>setTimeout(resolve,10))}
    expect((await m.sdk.status(run.runId as any)).attachments).toBe(0)
    await m.core.removeTerminal(ref)
    expect((await m.sdk.list()).map(v=>v.id)).toEqual([])
    await record('terminal-removal',{runId:run.runId,bytes:512*1024,endedPinnedRefused:true,disconnectThenRemoved:true})
  })
})
