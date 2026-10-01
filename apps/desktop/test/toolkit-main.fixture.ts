import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
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

export const children: ChildProcess[] = [], cleanups: (() => Promise<void>)[] = []
let runnerDigest: Promise<string> | undefined
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGTERM')
  for (const close of cleanups.splice(0).reverse()) await close()
  fixture.packaged=false;fixture.appPath=undefined
  vi.restoreAllMocks()
})
export async function until(check: () => void | Promise<void>, ms = 10000) {
  const end = Date.now() + ms
  for (;;) { try { await check(); return } catch (error) { if (Date.now() > end) throw error; await new Promise(resolve => setTimeout(resolve,20)) } }
}
export function cli(...args: string[]) {
  expect(process.env.AGENTMUX_TOOLKIT_CLI).toBeTruthy()
  const child = spawn(process.execPath, [process.env.AGENTMUX_TOOLKIT_CLI!,...args], { env:process.env, stdio:['ignore','pipe','pipe'] })
  children.push(child)
  let stdout = '', stderr = '', code: number | null | undefined
  child.stdout!.on('data', b => { stdout += b }); child.stderr!.on('data', b => { stderr += b }); child.once('close', value => { code = value })
  return { child, get code() {return code}, get stdout() {return stdout}, get stderr() {return stderr},
    frames: () => stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)) }
}
export async function oneCli(...args: string[]) {
  const c=cli(...args);await until(()=>expect(c.code).not.toBeUndefined())
  expect(c.code, c.stderr).toBe(0);const frames=c.frames();expect(frames).toHaveLength(1);return frames[0]
}
export async function nativeMain() {
  const directory = await mkdtemp('/tmp/amx-tk-')
  fixture.directory = directory
  fixture.handlers.clear();fixture.ipc.listeners.clear()
  const names=['AGENTMUX_RUNTIME_DIRECTORY','AGENTMUX_STATE_DIRECTORY','AGENTMUX_MESSAGE_QUEUE_PATH','AGENTMUX_AGENT_SESSION_STORE'] as const
  const old=Object.fromEntries(names.map(n=>[n,process.env[n]]))
  process.env.AGENTMUX_RUNTIME_DIRECTORY=directory;process.env.AGENTMUX_STATE_DIRECTORY=join(directory,'state')
  process.env.AGENTMUX_MESSAGE_QUEUE_PATH=join(directory,'queue.ndjson');process.env.AGENTMUX_AGENT_SESSION_STORE=join(directory,'agent-sessions.json')
  cleanups.push(async()=>{for(const n of names) if(old[n]===undefined)delete process.env[n];else process.env[n]=old[n]})
  await mkdir(join(directory,'work'))
  vi.spyOn(assets,'performanceLaunch').mockReturnValue({ runner:process.execPath, cli:process.env.AGENTMUX_TOOLKIT_CLI!,
    script:process.env.AGENTMUX_TOOLKIT_ASSET ?? resolve('apps/desktop/resources/toolkit/performance.mjs'),cwd:join(directory,'work'),env:{ELECTRON_RUN_AS_NODE:'1'} })
  let sampler=new ProcessResourceSampler()
  let runtime=new RuntimeController(new AgentMuxMemoryAgentSessionStore(),undefined,sampler)
  let store=new ConfigStore(join(directory,'config.json'));await store.save(structuredClone(DEFAULT_CONFIG));let config=await store.get()
  const makeSender=()=>new class extends EventEmitter {
    readonly id=71;readonly mainFrame={framesInSubtree:[]};readonly events: {channel:string;value:any}[]=[]
    isDestroyed(){return false} isLoadingMainFrame(){return false}
    send(channel:string,value:any){this.events.push({channel,value})}
  }()
  let sender=makeSender(), detachRenderer=runtime.attach(sender as any)
  const sdk=new CtxmuxClient({socketPath:join(directory,'ctxmux.sock')})
  let dispose: (()=>Promise<void>) | undefined
  await record('fixture-startup',{directory,phase:'before-registerIpc'})
  cleanups.push(async()=>{
    await dispose?.()
    // Exact private fixture cleanup uses the public SDK, independently of any Source mutant.
    // Its corrective actions are recorded, never counted as the product oracle.
    const correctiveRuns=await sdk.list().catch(async error=>{await record('fixture-cleanup-error',{directory,phase:'before-list',error:String(error)});return []})
    for(const run of correctiveRuns) {
      if(run.state.type==='running') {
        // A completed Stop receipt may precede its terminal metadata. Reuse the
        // observed dead process instead of submitting a conflicting new Stop.
        if(run.pid!==null && !alive(run.pid)) await until(async()=>expect((await sdk.status(run.id)).state.type).not.toBe('running'))
        else await sdk.stop(await sdk.prepareStop(run.id))
      }
      await sdk.remove(run.id)
      await record('fixture-cleanup',{runId:run.id,corrective:true})
    }
    await record('fixture-cleanup-summary',{directory,correctiveRunIds:correctiveRuns.map(run=>run.id),remainingRuns:await sdk.list().catch(async error=>{
      await record('fixture-cleanup-error',{directory,phase:'final-list',error:String(error)});return null}),
      runtimeIdentity:await sdk.runtimeInfo().catch(()=>null)})
    detachRenderer();await runtime.dispose();sampler.dispose()
    const ownDaemons=(await processes()).filter(p=>p.command.includes('ctxmuxd --socket '+join(directory,'ctxmux.sock')))
    for(const daemon of ownDaemons) {process.kill(daemon.pid,'SIGTERM');await until(()=>expect(alive(daemon.pid)).toBe(false))}
    await record('fixture-cleanup-summary',{directory,endedOwnDaemonPids:ownDaemons.map(daemon=>daemon.pid),allEnded:ownDaemons.every(daemon=>!alive(daemon.pid))})
    await rm(directory,{recursive:true,force:true})
  })
  dispose=await registerIpc({window:{id:7,isDestroyed:()=>false,webContents:sender} as any,runtime,configStore:store,
    progressLoops:{subscribe:()=>()=>{}} as any,scratchTopics:{} as any,workspaceFiles:{dispose:async()=>{}} as any})
  const ownDaemons=(await processes()).filter(p=>p.command.includes('ctxmuxd --socket '+join(directory,'ctxmux.sock')))
  expect(ownDaemons).toHaveLength(1)
  const daemon=ownDaemons[0]!, executable=daemon.command.slice(0,daemon.command.indexOf(' --socket '))
  await record('fixture-startup',{directory,phase:'registered',protocol:PROTOCOL_VERSION,runtimeIdentity:await sdk.runtimeInfo(),
    daemon:{...daemon,sha256:createHash('sha256').update(await readFile(executable)).digest('hex')},
    runner:{path:process.execPath,sha256:await (runnerDigest??=readFile(process.execPath).then(bytes=>createHash('sha256').update(bytes).digest('hex')))}})
  const core=()=>(runtime as any).hosts.get('local').client as AgentMuxClient
  const controlPath=join(directory,'control.sock')
  const request=(operation:any)=>({schemaVersion:AGENTMUX_CONTROL_SCHEMA_VERSION,requestId:crypto.randomUUID(),operation,toolId:'performance'})
  const call=(operation:any)=>requestAgentMuxControl(request(operation) as any,controlPath)
  const invoke=(channel:string,...args:any[])=>fixture.handlers.get(channel)!({sender},...args)
  const restart=async()=>{
    await dispose!();detachRenderer();await runtime.dispose();sampler.dispose()
    fixture.handlers.clear();fixture.ipc.listeners.clear()
    sampler=new ProcessResourceSampler();runtime=new RuntimeController(new AgentMuxMemoryAgentSessionStore(),undefined,sampler)
    // Reopen the actual durable stores and same private Native. Never recreate defaults or the daemon.
    store=new ConfigStore(join(directory,'config.json'));config=await store.get();sender=makeSender();detachRenderer=runtime.attach(sender as any)
    dispose=await registerIpc({window:{id:7,isDestroyed:()=>false,webContents:sender} as any,runtime,configStore:store,
      progressLoops:{subscribe:()=>()=>{}} as any,scratchTopics:{} as any,workspaceFiles:{dispose:async()=>{}} as any})
    await record('fixture-restart',{directory,phase:'registered',runtimeInstance:await sdk.daemonInstance()})
  }
  return {directory,get runtime(){return runtime},get sampler(){return sampler},get store(){return store},get config(){return config},
    get sender(){return sender},dispose:()=>dispose!(),get core(){return core()},sdk,controlPath,request,call,invoke,restart}
}
export async function record(name:string,value:unknown) {
  if(process.env.AGENTMUX_TOOLKIT_EVIDENCE)await appendFile(join(process.env.AGENTMUX_TOOLKIT_EVIDENCE!,name+'.jsonl'),JSON.stringify(value)+'\n')
}
const exec=promisify(execFile)
export async function processes() {
  const {stdout}=await exec('/bin/ps',['-eo','pid=,ppid=,command='])
  return stdout.trim().split('\n').map(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u)!;return {pid:Number(m[1]),ppid:Number(m[2]),command:m[3]!}})
}
export async function executionGroup(pid:number) {
  const rows=await processes(),ids=new Set([pid]);let count=-1
  while(count!==ids.size){count=ids.size;for(const p of rows)if(ids.has(p.ppid))ids.add(p.pid)}
  return rows.filter(p=>ids.has(p.pid))
}
export function alive(pid:number){try{process.kill(pid,0);return true}catch{return false}}
export function terminalMetadata(core:AgentMuxClient) {
  const inner=core as unknown as {runPids:Map<string,number>;endedRuns:Map<string,unknown>;stopRequestedRuns:Set<string>}
  return {runPids:[...inner.runPids].sort(),endedRuns:[...inner.endedRuns].sort(),stopRequestedRuns:[...inner.stopRequestedRuns].sort()}
}
export async function storage(directory:string):Promise<{path:string;bytes:number}[]> {
  const files:{path:string;bytes:number}[]=[]
  for(const item of await readdir(directory,{withFileTypes:true})) {
    const path=join(directory,item.name)
    if(item.isDirectory())files.push(...await storage(path));else if(item.isFile())files.push({path,bytes:(await stat(path)).size})
  }
  return files
}


export function mainFixtureState() { return fixture }
