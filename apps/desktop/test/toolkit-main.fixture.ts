import { localRuntimeConnector } from './helpers/local-runtime-connector.js'
import { toolkitRuntime } from './helpers/toolkit-runtime.fixture.js'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, appendFile, readdir, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ directory: process.env.AGENTMUX_TOOLKIT_EVIDENCE ?? process.cwd(), handlers: new Map<string, (...args: any[]) => unknown>(),
  ipc: new (class { listeners = new Map<string, Set<Function>>() })(),
  packaged:false,appPath:undefined as string|undefined,
  rendererRequest: undefined as undefined | ((request: any) => void), rendererCancel: undefined as undefined | ((request: any) => void) }))
vi.mock('electron', () => ({ app: { get isPackaged(){return fixture.packaged},getAppPath: () => fixture.appPath??process.cwd() + '/apps/desktop', getPath: () => fixture.directory, getAppMetrics: () => [] },
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => unknown) => fixture.handlers.set(channel, handler),
    removeHandler: (channel: string) => fixture.handlers.delete(channel),
    on: (channel: string, handler: Function) => { const values = fixture.ipc.listeners.get(channel) ?? new Set(); values.add(handler); fixture.ipc.listeners.set(channel, values) },
    removeListener: (channel: string, handler: Function) => fixture.ipc.listeners.get(channel)?.delete(handler) },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {},
  nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false }) }))
vi.mock('@agentmux/demand', async original => ({ ...await original(), openDemandStore: () => ({}) }))
vi.mock('../src/main/browser-profile-manager.js', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal.js', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private-journal.json',
  BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store.js', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager.js', () => ({ BrowserViewManager: class {
  resourceProcessIds() { return [] } resourceOwnerCounts() { return { browserViews: 0, releasedBrowserViews: 0 } } dispose() {}
} }))
vi.mock('../src/main/agent-notifier.js', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))

import { AgentMuxMemoryAgentSessionStore, AgentMuxClient, connectAgentMuxRpc, type AgentMuxRpcClient } from '@agentmux/core'
import { registerIpc } from '../src/main/ipc.js'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { desktopBusinessSocketPath } from '../src/main/desktop-host.js'
import { ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store.js'
import { ProcessResourceSampler } from '../src/main/process-resource-sampler.js'
import { runOwnerDisposals } from '../src/main/owner-disposal.js'
import * as assets from '../src/main/toolkit-asset.js'
import { PROTOCOL_VERSION } from '../../../packages/core/node_modules/@ctxmux/sdk/dist/index.js'

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
  const child = spawn(process.execPath, [process.env.AGENTMUX_TOOLKIT_CLI!, '--endpoint', process.env.AGENTMUX_RPC_ENDPOINT!, ...args], { env:process.env, stdio:['ignore','pipe','pipe'] })
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
  const owned = await toolkitRuntime(), directory = owned.directory
  fixture.directory = directory
  fixture.handlers.clear();fixture.ipc.listeners.clear()
  const names=['AGENTMUX_RUNTIME_DIRECTORY','AGENTMUX_STATE_DIRECTORY','AGENTMUX_MESSAGE_QUEUE_PATH','AGENTMUX_AGENT_SESSION_STORE','AGENTMUX_AGENT_SESSION_ID','AGENTMUX_AGENT_CAPABILITY','AGENTMUX_RPC_ENDPOINT'] as const
  const old=Object.fromEntries(names.map(n=>[n,process.env[n]]))
  process.env.AGENTMUX_RUNTIME_DIRECTORY=directory;process.env.AGENTMUX_STATE_DIRECTORY=join(directory,'state')
  process.env.AGENTMUX_MESSAGE_QUEUE_PATH=join(directory,'queue.ndjson');process.env.AGENTMUX_AGENT_SESSION_STORE=join(directory,'agent-sessions.json')
  delete process.env.AGENTMUX_AGENT_SESSION_ID;delete process.env.AGENTMUX_AGENT_CAPABILITY
  const controlPath=desktopBusinessSocketPath();process.env.AGENTMUX_RPC_ENDPOINT='unix:'+controlPath
  cleanups.push(async()=>{for(const n of names) if(old[n]===undefined)delete process.env[n];else process.env[n]=old[n]})
  await mkdir(join(directory,'work'))
  vi.spyOn(assets,'performanceLaunch').mockReturnValue({ runner:process.execPath, cli:process.env.AGENTMUX_TOOLKIT_CLI!,
    script:process.env.AGENTMUX_TOOLKIT_ASSET ?? resolve('apps/desktop/resources/toolkit/performance.mjs'),cwd:join(directory,'work'),env:{ELECTRON_RUN_AS_NODE:'1'} })
  let sampler=new ProcessResourceSampler()
  let runtime=new RuntimeController(new AgentMuxMemoryAgentSessionStore(), localRuntimeConnector,undefined,sampler)
  let store=new ConfigStore(join(directory,'config.json'));await store.save(structuredClone(DEFAULT_CONFIG));let config=await store.get()
  const makeSender=()=>new class extends EventEmitter {
    readonly id=71;readonly mainFrame={framesInSubtree:[]};readonly events: {channel:string;value:any}[]=[]
    isDestroyed(){return false} isLoadingMainFrame(){return false}
    send(channel:string,value:any){this.events.push({channel,value})}
  }()
  let sender=makeSender(), detachRenderer=runtime.attach(sender as any)
  const sdk=owned.activation.client
  let dispose: (()=>Promise<void>) | undefined, rpc: AgentMuxRpcClient | undefined
  await record('fixture-startup',{directory,phase:'before-registerIpc'})
  let closing: Promise<Awaited<ReturnType<typeof owned.cleanup>>> | undefined
  const close=()=>closing??=(async()=>{
    try {
    let failure: unknown, runsRetired = false
    try { await runOwnerDisposals([
      { owner: 'fixture-rpc', dispose: async () => { await rpc?.dispose() } },
      { owner: 'fixture-main', dispose: async () => { await dispose?.() } },
      { owner: 'fixture-runs', dispose: async () => {
    // Exact private fixture cleanup uses the public SDK, independently of any Source mutant.
    // Its corrective actions are recorded, never counted as the product oracle.
    const correctiveRuns=await sdk.list().catch(async error=>{await record('fixture-cleanup-error',{directory,phase:'before-list',namespace:'retained',error:String(error)});throw error})
    for(const run of correctiveRuns) {
      if(run.state.type==='running') {
        await sdk.stop(await sdk.prepareStop(run.id))
      }
      await sdk.remove(run.id)
      await record('fixture-cleanup',{runId:run.id,corrective:true})
    }
    const remainingRuns=await sdk.list()
    expect(remainingRuns).toEqual([])
    await record('fixture-cleanup-summary',{directory,correctiveRunIds:correctiveRuns.map(run=>run.id),remainingRuns,
      runtimeIdentity:await sdk.runtimeInfo()})
    runsRetired = true
      } },
      { owner: 'fixture-renderer', dispose: detachRenderer },
      { owner: 'fixture-core', dispose: async () => { await runtime.dispose() } },
      { owner: 'fixture-sampler', dispose: () => sampler.dispose() }
    ], 'Private Toolkit fixture disposal failed') } catch (error) { failure = error }
    // Unconfirmed Runs retain their Runtime and namespace. A failed client
    // disposal cannot strand the SDK child after its exact Runs are retired.
    if (!runsRetired) throw failure
    const cleanup=await owned.cleanup({ retainNamespace: failure !== undefined })
    await record('fixture-cleanup-summary',cleanup)
    if (failure !== undefined) throw failure
    expect(cleanup.namespace,JSON.stringify(cleanup)).toBe('removed')
    return cleanup
    } catch(error) {
      await record('fixture-cleanup-error',{directory,namespace:'retained-unless-release-confirmed',error:String(error)})
      throw error
    }
  })()
  cleanups.push(async()=>{await close()})
  dispose=await registerIpc({initialConfig:config,window:{setBackgroundColor:vi.fn(),id:7,isDestroyed:()=>false,webContents:sender} as any,runtime,configStore:store,
    progressLoops:{subscribe:()=>()=>{}} as any,scratchTopics:{ setNameAudit() {}, async normalizeDirectoryIdentities() {} } as any,workspaceFiles:{dispose:async()=>{}, read() { throw Error('Unrelated file read outside Toolkit fixture') }, listFiles() { throw Error('Unrelated file list outside Toolkit fixture') }} as any})
  expect(owned.activation.spawned).toBe(true)
  expect(await sdk.daemonInstance()).toBe(owned.activation.runtime.daemonInstanceId)
  await record('fixture-startup',{directory,phase:'registered',protocol:PROTOCOL_VERSION,runtimeIdentity:await sdk.runtimeInfo(),
    daemon:{pid:owned.activation.childPid,executable:owned.executable,spawned:owned.activation.spawned,
      sha256:createHash('sha256').update(await readFile(owned.executable)).digest('hex')},
    runner:{path:process.execPath,sha256:await (runnerDigest??=readFile(process.execPath).then(bytes=>createHash('sha256').update(bytes).digest('hex')))}})
  const core=()=>(runtime as any).hosts.get('local').client as AgentMuxClient
  rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:controlPath}})
  const invoke=(channel:string,...args:any[])=>fixture.handlers.get(channel)!({sender,senderFrame:sender.mainFrame},...args)
  const restart=async()=>{
    await rpc!.dispose();await dispose!();detachRenderer();await runtime.dispose();sampler.dispose()
    fixture.handlers.clear();fixture.ipc.listeners.clear()
    sampler=new ProcessResourceSampler();runtime=new RuntimeController(new AgentMuxMemoryAgentSessionStore(), localRuntimeConnector,undefined,sampler)
    // Reopen the actual durable stores and same private Native. Never recreate defaults or the daemon.
    store=new ConfigStore(join(directory,'config.json'));config=await store.get();sender=makeSender();detachRenderer=runtime.attach(sender as any)
    dispose=await registerIpc({initialConfig:config,window:{setBackgroundColor:vi.fn(),id:7,isDestroyed:()=>false,webContents:sender} as any,runtime,configStore:store,
      progressLoops:{subscribe:()=>()=>{}} as any,scratchTopics:{ setNameAudit() {}, async normalizeDirectoryIdentities() {} } as any,workspaceFiles:{dispose:async()=>{}, read() { throw Error('Unrelated file read outside Toolkit fixture') }, listFiles() { throw Error('Unrelated file list outside Toolkit fixture') }} as any})
    rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:controlPath}})
    expect(await sdk.daemonInstance()).toBe(owned.activation.runtime.daemonInstanceId)
    await record('fixture-restart',{directory,phase:'registered',runtimeInstance:await sdk.daemonInstance()})
  }
  return {directory,get runtime(){return runtime},get sampler(){return sampler},get store(){return store},get config(){return config},
    get sender(){return sender},dispose:()=>dispose!(),close,get core(){return core()},sdk,activation:owned.activation,controlPath,get rpc(){return rpc!},invoke,restart}
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
