// T-005 of f-25k8f8m9k：身份绑定与重启恢复的 durable 边界。
//
// 两条会静默腐烂的性质，各配一条**被破坏时会红**的测试，都跑在真的收敛 owner 上（渲染层的持久化
// 恢复入口 `useAppStore.initialize` 与运行时成员对齐 reducer `reduceAgentMembershipSnapshot`，两者
// 是同一个「一份快照要不要退役一个 Region」判断的两个出口）：
//
//   1. 空快照 / 恢复路径故障**不清工作面**。空快照分不清「真的没有 Session」与「Core 没就绪 /
//      根目录接错」；这是 AGENTS.md 原则 11 的 class-2/3 典型——我们这段读失败了，Agent 可能好好
//      活着。此时清掉用户的工作面正是被禁止的动作。两条出口都必须 fail-open。
//   2. 新进程按**原 Session 身份**恢复，输入投到它、不投到新铸的身份。恢复出来的 Session 必须保留
//      原 agentSessionId 与原 control（含 run 绑定），渲染层据此把输入送回原 Agent。
//
// 每条都配一处 mutation 说明：破坏该性质会让点名的断言变红（见各 it 内注释）。
//
// 这是渲染/持久化 owner 侧的证据；Core owner 侧（provider-native resume 后仍是原 agentSessionId、
// 输入落到新 Run 而非退役旧 Run）由 packages/core/test/agent-session-continuity.test.ts 的
// 「重启恢复保持原 Session 身份且输入不误投递」一组证明。两侧合起来覆盖 outcome 的两个性质。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  AgentMuxFileAgentSessionStore,
  AgentProviderRegistry,
  connectLocalAgentMux,
  loadAgentSessions,
  resolveManagedHookPlan,
  type AgentProvider
} from '@agentmux/core'
import { RuntimeController } from '../src/main/runtime-controller.js'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})
// Process sampling is outside this Node integration. No Electron process is claimed here.
vi.mock('electron', () => ({ app: {} }))
const fixtureHome = vi.hoisted(() => ({ path: null as string | null }))
// Connect only restores Hook bindings. Create/recovery owns the explicit Executor env;
// keep Node's home private too, so a missing-env regression cannot touch the user's config.
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => fixtureHome.path ?? actual.homedir() }
})

import type {
  AppConfig,
  RuntimeSnapshot,
  SessionSnapshot
} from '../src/shared/contracts.js'
import { api } from '../src/renderer/src/lib/api.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import {
  createWorkbenchTab,
  addWorkbenchRegion,
  initialWorkbenchRegionId,
  workbenchSurfaces
} from '../src/renderer/src/lib/workbench-tabs.js'
import {
  reduceAgentMembershipSnapshot,
  reduceTerminalMembershipSnapshot
} from '../src/renderer/src/lib/session-state.js'
import { useAppStore } from '../src/renderer/src/store.js'

const initialState = useAppStore.getState()

const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [
    { id: 'workspace-a', name: 'A', hostId: 'local', path: '/repo/a', kind: 'folder' }
  ],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}

function agentSession(id: string, runId: string): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    id,
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true,
      timeline: 'complete-events',
      permission: 'observe',
      providerResume: true,
      replyCorrelation: 'none'
    },
    hostId: 'local',
    workspacePath: '/repo/a',
    label: 'Codex',
    createdAt: 1,
    updatedAt: 2,
    agentSessionUpdatedAt: 2,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 2 },
    latestOutputBytes: 0,
    control: {
      kind: 'agent',
      hostId: 'local',
      agentSessionId: id,
      run: { runId }
    }
  }
}

function agentTab(sessionId: string) {
  const tabId = `session:${sessionId}`
  const tab = createWorkbenchTab(tabId, {
    regionId: initialWorkbenchRegionId(tabId),
    kind: 'agent',
    phase: 'attached',
    workspaceId: 'workspace-a',
    sessionId
  })
  return { tabId, tab }
}

function terminalTab(sessionId: string) {
  const tabId = `session:${sessionId}`
  const tab = createWorkbenchTab(tabId, {
    regionId: initialWorkbenchRegionId(tabId),
    kind: 'terminal',
    phase: 'attached',
    workspaceId: 'workspace-a',
    sessionId
  })
  return { tabId, tab }
}

function terminalSession(id: string): Extract<SessionSnapshot, { kind: 'terminal' }> {
  const runId = `run-${id}`
  return {
    id,
    kind: 'terminal',
    providerId: null,
    hostId: 'local',
    workspacePath: '/repo/a',
    label: 'Shell',
    createdAt: 1,
    updatedAt: 2,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 2 },
    latestOutputBytes: 0,
    control: { kind: 'terminal', hostId: 'local', runId, run: { runId } }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fixtureHome.path = null
  useAppStore.setState(initialState, true)
})

// T-016: the native identity below is emitted by a private CLI through the public, authenticated
// Hook ingress. Neither the FileStore nor Desktop snapshot is seeded with a native handle.
// This proves a new Core Client and the actual Desktop persistence owners; the separate isolated
// Electron probe is still required for two real Main/Renderer process lifetimes.
const historyProviders = new AgentProviderRegistry().list().filter(provider => provider.readSessionHistoryPage)

type NativeFixtureFormat = 'codex' | 'claude' | 'pi'
function nativeFixtureFormat(provider: AgentProvider): NativeFixtureFormat {
  const usage = provider.catalog.capabilities.usage
  if (usage?.kind === 'native-transcript' && usage.transcriptFormat === 'codex-rollout') return 'codex'
  if (usage?.kind === 'native-transcript' && usage.transcriptFormat === 'claude-jsonl') return 'claude'
  if (provider.catalog.resumeStrategy.kind === 'provider-native' &&
    provider.catalog.resumeStrategy.locator === 'transcript-path' &&
    provider.hook.nativeHandle?.requireTranscriptPath) return 'pi'
  throw new Error(`Native identity integration needs an explicit protocol fixture for ${provider.id}`)
}

// A native CLI protocol fixture, not a second Provider: all normalization, storage, readers,
// native launch arguments, continuity and Desktop projections remain production implementations.
const nativeCli = String.raw`#!/usr/bin/env node
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
if (process.argv.includes('--version')) { console.log('private-native-fixture 1'); process.exit(0) }
const f = JSON.parse(await readFile(process.env.AMX_IDENTITY_FIXTURE, 'utf8'))
const args = process.argv.slice(2)
const trace = entry => appendFile(f.trace, JSON.stringify(entry)+'\n')
const allowedAgentMuxEnv = new Set(['AGENTMUX_RUNTIME_DIRECTORY', 'AGENTMUX_STATE_DIRECTORY','AGENTMUX_MESSAGE_QUEUE_PATH','AGENTMUX_AGENT_SESSION_STORE',
  'AGENTMUX_ENV','AGENTMUX_CLI','AGENTMUX_HOOK_URL','AGENTMUX_HOOK_TOKEN','AGENTMUX_AGENT_SESSION_ID','AGENTMUX_PROVIDER_ID',
  'AGENTMUX_EXECUTOR_ID','AGENTMUX_LIFECYCLE_OPERATION_ID','AGENTMUX_AGENT_CAPABILITY','AGENTMUX_USAGE_TRANSCRIPT_FORMAT'])
for (const name of Object.keys(process.env).filter(name=>name.startsWith('AGENTMUX_'))) {
  if (!allowedAgentMuxEnv.has(name)) throw new Error('unexpected inherited AgentMux context: '+name)
}
for (const name of ['AGENTMUX_RUNTIME_DIRECTORY', 'AGENTMUX_STATE_DIRECTORY','AGENTMUX_MESSAGE_QUEUE_PATH','AGENTMUX_AGENT_SESSION_STORE']) {
  if (!process.env[name]?.startsWith(f.root+'/')) throw new Error('non-private fixture path: '+name)
}
if (args.includes('app-server')) {
  if (JSON.stringify(args) !== JSON.stringify(['-s','read-only','-a','never','app-server','--stdio'])) throw new Error('unsafe native read argv')
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line)
    if (!request.id) continue
    await trace({ mode:'read', method:request.method, params:request.params })
    let result
    if (request.method === 'initialize') result = {}
    else if (request.method === 'thread/read' && request.params.threadId === f.nativeId) result = { thread:{ id:f.nativeId, historyMode:'paginated' } }
    else if (request.method === 'thread/items/list' && request.params.threadId === f.nativeId) {
      const index = request.params.cursor === 'older' ? 1 : 0
      result = { data:[index === 0 ? {turnId:'turn-main',item:{id:'answer-main',type:'agentMessage',text:f.answer}} :
        {turnId:'turn-main',item:{id:'user-main',type:'userMessage',content:[{type:'text',text:f.question}]}}],nextCursor:index === 0 ? 'older' : null }
    } else throw new Error('unexpected native request: '+request.method)
    process.stdout.write(JSON.stringify({ id:request.id, result })+'\n')
  }
  await trace({mode:'read-eof'}); process.exit(0)
}
const resumed = args.includes('resume') || args.includes('--resume') || args.includes('--session')
if (process.env.AGENTMUX_AGENT_SESSION_ID !== f.agentSessionId || process.env.AGENTMUX_PROVIDER_ID !== f.providerId ||
  process.env.AGENTMUX_CLI !== f.agentMuxCli) throw new Error('Agent Run inherited another client identity')
if (resumed) {
  const flag = f.format === 'codex' ? 'resume' : f.format === 'claude' ? '--resume' : '--session'
  const target = f.format === 'pi' ? f.transcript : f.nativeId
  if (args[args.indexOf(flag)+1] !== target) throw new Error('native resume identity drift')
} else if (f.format !== 'codex') {
  const message = (id,parentId,role,text) => ({type:'message',id,parentId,timestamp:'2026-10-02T00:00:00Z',message:{role,content:[{type:'text',text}]}})
  const records = f.format === 'pi' ? [{type:'session',version:3,id:f.nativeId,cwd:process.cwd(),timestamp:'2026-10-02T00:00:00Z'},
    message('user-main',null,'user',f.question),message('answer-main','user-main','assistant',f.answer)] :
    [{sessionId:f.nativeId,uuid:'user-main',type:'user',message:{role:'user',content:f.question}},
     {sessionId:f.nativeId,uuid:'answer-main',type:'assistant',message:{role:'assistant',content:f.answer}}]
  await writeFile(f.transcript, records.map(r=>JSON.stringify(r)+'\n').join(''))
}
await trace({mode:resumed?'resume':'launch',args,agentSessionId:process.env.AGENTMUX_AGENT_SESSION_ID,pid:process.pid})
process.stdin.setRawMode?.(true); process.stdin.setEncoding('utf8')
let carry = ''
process.stdin.on('data', async data => {
  carry += data
  if (f.handshake && carry.includes(f.handshake.response)) {
    carry = carry.replace(f.handshake.response,'')
  }
  if (carry.includes('EXIT-PRIVATE')) { await trace({mode:'exit',pid:process.pid}); process.exit(0) }
  if (carry.includes('INPUT-AFTER-RESTART')) {
    await trace({mode:'input',agentSessionId:process.env.AGENTMUX_AGENT_SESSION_ID,pid:process.pid}); carry = ''
  }
})
process.stdout.write('\u001bc\u001b[?2026h\u001b[22;1H› \u001b[22;3H\u001b[?2026l')
if (f.handshake) process.stdout.write(f.handshake.query)
const response = await fetch(process.env.AGENTMUX_HOOK_URL, {method:'POST',headers:{authorization:'Bearer '+process.env.AGENTMUX_HOOK_TOKEN,'content-type':'application/json'},
  body:JSON.stringify({receiptId:'native-start-'+process.pid,agentSessionId:process.env.AGENTMUX_AGENT_SESSION_ID,
    providerId:process.env.AGENTMUX_PROVIDER_ID,eventName:f.event,
    payload:{[f.sessionKey]:f.nativeId,[f.transcriptKey]:f.transcript}})})
await trace({mode:'hook',status:response.status,pid:process.pid})
if (!response.ok) throw new Error('public Hook refused native identity: '+response.status)
`

async function waitForFact<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 10_000
  do {
    const value = await read()
    if (accept(value)) return value
    await new Promise(done => setTimeout(done, 20))
  } while (Date.now() < end)
  throw new Error('Private native identity fixture did not reach its required fact')
}

describe('public Hook native identity survives a new Client and Desktop durable workbench (T-016)', () => {
  it('derives a nonempty native-reader cohort from the builtin registry and fixes Claude coverage', () => {
    expect(historyProviders.length).toBeGreaterThan(0)
    expect(historyProviders.map(provider => provider.id)).toContain('claude')
    for (const provider of historyProviders) {
      expect(provider.catalog.resumeStrategy.kind).toBe('provider-native')
      expect(provider.hook.nativeHandle?.sessionIdKeys.length).toBeGreaterThan(0)
      expect(nativeFixtureFormat(provider)).toBeTruthy()
    }
  })

  it.each(historyProviders)('$id: Hook → durable identity → fresh Client native history/resume → same Desktop surface', async provider => {
    const root = await mkdtemp('/tmp/amx-native-identity-')
    const workspace = join(root, 'workspace'), runtime = join(root, 'runtime')
    const storePath = join(root, 'agent-sessions.json'), tracePath = join(root, 'native-trace.ndjson')
    const transcript = join(root, 'native-transcript.jsonl'), cliPath = join(root, 'native-cli.mjs')
    const fixturePath = join(root, 'fixture.json'), nativeId = `native-${provider.id}-main`
    const persistedPath = join(root, 'agentmux-workbench-v1.json')
    const format = nativeFixtureFormat(provider)
    const sessionId = `identity-${provider.id}`, executorId = `private-${provider.id}`
    const environment = { AMX_IDENTITY_FIXTURE:fixturePath, PI_CODING_AGENT_DIR:join(root,'pi-agent') }
    const privateConfig: AppConfig = { ...config, executors:{ [executorId]:{ label:provider.label,providerId:provider.id,
      command:cliPath,args:[],env:environment,injectAgentMuxGuide:false } },
      workspaces:[{id:'workspace-a',name:'Private identity fixture',hostId:'local',path:workspace,kind:'folder'}] }
    const nativeSpec = provider.hook.nativeHandle!
    const fixture = { root,agentSessionId:sessionId,providerId:provider.id,agentMuxCli:resolve('packages/core/bin/agentmux'),
      format,nativeId,transcript,trace:tracePath,question:`question-${provider.id}`,answer:`answer-${provider.id}`,
      event:format === 'pi' ? 'agent_start' : 'SessionStart',sessionKey:nativeSpec.sessionIdKeys[0],
      transcriptKey:nativeSpec.transcriptPathKeys?.[0] ?? 'transcript_path',handshake:provider.terminalHandshake }
    await mkdir(workspace); await mkdir(runtime); await writeFile(tracePath,'')
    await writeFile(cliPath,nativeCli,{mode:0o700}); await writeFile(fixturePath,JSON.stringify(fixture))
    const readTrace = async () => {
      const text = (await readFile(tracePath,'utf8')).trim()
      return text ? text.split('\n').map(line=>JSON.parse(line)) : []
    }
    // Remove the host Agent's invocation/auth/Hook context before either daemon or native helper
    // is spawned. The public Core installs fresh Run credentials after these private path guards.
    for (const name of Object.keys(process.env).filter(name=>name.startsWith('AGENTMUX_'))) vi.stubEnv(name,undefined)
    vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY',runtime)
    vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(runtime, 'state')); vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH',join(root,'messages.ndjson'))
    vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE',storePath)
    expect(Object.keys(process.env).filter(name=>name.startsWith('AGENTMUX_')).sort()).toEqual([
      'AGENTMUX_AGENT_SESSION_STORE','AGENTMUX_MESSAGE_QUEUE_PATH','AGENTMUX_RUNTIME_DIRECTORY','AGENTMUX_STATE_DIRECTORY'])
    for (const name of ['AGENTMUX_RUNTIME_DIRECTORY', 'AGENTMUX_STATE_DIRECTORY','AGENTMUX_MESSAGE_QUEUE_PATH','AGENTMUX_AGENT_SESSION_STORE']) {
      expect(process.env[name]?.startsWith(root+'/')).toBe(true)
    }
    fixtureHome.path = join(root,'home')
    await mkdir(fixtureHome.path)
    const repairPlan = resolveManagedHookPlan(provider.id,workspace,environment)
    expect(repairPlan?.mutations.length).toBeGreaterThan(0)
    for (const mutation of repairPlan!.mutations) expect(mutation.path.startsWith(root+'/')).toBe(true)
    const daemonPath = resolve('packages/core/vendor/ctxmux/darwin-arm64/bin/ctxmuxd')
    const daemonEnv = Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('AGENTMUX_')))
    expect(Object.keys(daemonEnv).filter(name=>name.startsWith('AGENTMUX_'))).toEqual([])
    // Own child and exact namespace: cleanup never selects an installed daemon or user Session.
    const daemon = spawn(daemonPath,['--socket',join(runtime,'ctxmux.sock'),'--state-dir',join(runtime,'state','ctxmux'),'--readiness-fd','3'],
      {env:daemonEnv,stdio:['ignore','ignore','ignore','pipe']})
    const daemonExit = once(daemon,'exit')
    let first: Awaited<ReturnType<typeof connectLocalAgentMux>> | undefined
    let desktop: RuntimeController | undefined
    let disposeUi: (() => void) | undefined
    const persistenceOptions = useAppStore.persist.getOptions()
    try {
      await once(daemon.stdio[3]!,'data')
      const firstStore = new AgentMuxFileAgentSessionStore(storePath)
      first = await connectLocalAgentMux({store:firstStore})
      expect(await loadAgentSessions(firstStore)).toEqual([])
      const created = await first.createAgent({agentSessionId:sessionId,createOperationId:`create-${provider.id}`,providerId:provider.id,
        executorId,workspacePath:workspace,injectAgentMuxGuide:false,commandOverride:cliPath,env:environment})
      await waitForFact(readTrace, entries=>entries.filter(entry=>entry.mode === 'hook').length === 1)
      const captured = (await loadAgentSessions(firstStore))[0]!
      expect(captured.nativeHandle).toEqual({kind:'provider',providerId:provider.id,sessionId:nativeId,transcriptPath:transcript})
      for (const mutation of repairPlan!.mutations) expect((await readFile(mutation.path)).length).toBeGreaterThan(0)
      const originalRun = created.run
      const originalPid = (await first.statusAgent(sessionId)).run.pid
      if (provider.terminalHandshake) expect(created.terminalHandshake?.acknowledged).toBe(true)
      await first.writeAgent({agentSessionId:sessionId,expectedRun:originalRun,source:'user',data:'EXIT-PRIVATE\r'})
      await waitForFact(() => first!.statusAgent(sessionId), status => status.run.state === 'exited')
      await first.dispose(); first = undefined
      // These files were created in this fixture's guarded private root. A fresh connection
      // cannot reconstruct Executor configuration; recovery must receive it from Desktop.
      for (const mutation of repairPlan!.mutations) await rm(mutation.path)

      // Only presentation is authored here. The native handle above exists solely through Hook.
      const {tabId,tab} = agentTab(sessionId)
      const fileRegionId = `file-${provider.id}`
      const split = addWorkbenchRegion(tab,tab.layout.activeRegionId,'right', {regionId:fileRegionId,kind:'file',
        workspaceId:'workspace-a',path:'notes.md'})
      useAppStore.persist.setOptions({storage:{
        getItem: () => JSON.parse(readFileSync(persistedPath,'utf8')),
        setItem: (_name,value) => writeFileSync(persistedPath,JSON.stringify(value)),removeItem: () => {}
      }})
      const focus = {execution:{sessionId,history:[{sessionId,focusedAt:1}]},pmo:{sessionId:null}}
      useAppStore.setState({tabs:{[tabId]:split},layouts:{'workspace-a':createWorkspaceLayout('pane',[tabId])},
        activeWorkspaceId:'workspace-a',agentFocus:focus,agentComposerDrafts:{[sessionId]:'draft survives'}})
      const durableUiBytes = await readFile(persistedPath)
      const durableUi = JSON.parse(durableUiBytes.toString()).state
      expect(Object.keys(durableUi.restoredWorkbench.tabs)).toEqual([tabId])
      expect(durableUi.restoredWorkbench.tabs[tabId].regions).toHaveProperty(tab.layout.activeRegionId)
      expect(durableUi).not.toHaveProperty('sessions')

      // A new FileStore and RuntimeController create a fresh public Core Client. Real Desktop
      // snapshot/history/recovery delegates supply the facts consumed by Store.initialize.
      desktop = new RuntimeController(new AgentMuxFileAgentSessionStore(storePath))
      const trackedRun = vi.spyOn(desktop.resourceSampler,'trackRun')
      desktop.commit(await desktop.prepare(privateConfig))
      for (const mutation of repairPlan!.mutations) await expect(readFile(mutation.path)).rejects.toMatchObject({code:'ENOENT'})
      const control = {kind:'agent' as const,hostId:'local',agentSessionId:sessionId,run:originalRun}
      const transcriptBefore = format === 'codex' ? undefined : await readFile(transcript)
      const newest = await desktop.sessionHistoryPage(control,{limit:1},privateConfig)
      expect(newest.agentSessionId).toBe(sessionId)
      expect(newest.source).toEqual({providerId:provider.id,nativeSessionId:nativeId})
      expect(newest.items.map(item=>item.contentParts)).toEqual([[{kind:'text',text:fixture.answer}]])
      expect(newest.nextCursor).toEqual(expect.any(String))
      const older = await desktop.sessionHistoryPage(control,{limit:1,cursor:newest.nextCursor!},privateConfig)
      expect(older.items.map(item=>item.contentParts)).toEqual([[{kind:'text',text:fixture.question}]])
      expect(older.nextCursor).toBeNull()
      if (transcriptBefore) expect(await readFile(transcript)).toEqual(transcriptBefore)
      const recovered = await desktop.recoverSession(control,privateConfig,workspace,`recover-${provider.id}`)
      expect(recovered.kind).toBe('resumed')
      if (recovered.kind !== 'resumed') throw new Error('Native resume did not produce a Session')
      expect(recovered.session.id).toBe(sessionId)
      expect(recovered.session.control.run.runId).not.toBe(originalRun.runId)
      for (const mutation of repairPlan!.mutations) expect((await readFile(mutation.path)).length).toBeGreaterThan(0)
      const snapshot = await desktop.snapshot(privateConfig)
      expect(snapshot.sessions.map(session=>session.id)).toEqual([sessionId])
      expect(snapshot.sessions[0]!.processState).toBe('running')

      // Reset memory without overwriting the durable record, then use the real Zustand read and
      // Desktop startup owner. This is durable hydration, not a claim of actual Electron restart.
      useAppStore.persist.setOptions({storage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}}})
      useAppStore.setState(initialState,true)
      useAppStore.persist.setOptions({storage:{getItem:()=>JSON.parse(readFileSync(persistedPath,'utf8')),setItem:()=>{},removeItem:()=>{}}})
      await useAppStore.persist.rehydrate()
      vi.spyOn(api.config,'get').mockResolvedValue(privateConfig)
      vi.spyOn(api.providers,'list').mockResolvedValue([])
      vi.spyOn(api.sessions,'snapshot').mockImplementation(() => desktop!.snapshot(privateConfig))
      disposeUi = await useAppStore.getState().initialize()
      const restored = useAppStore.getState()
      expect(restored.tabs[tabId]).toEqual(split)
      expect(restored.layouts['workspace-a']).toEqual(durableUi.restoredWorkbench.layouts['workspace-a'])
      expect(restored.agentComposerDrafts).toEqual({[sessionId]:'draft survives'})
      expect(restored.agentFocus).toEqual(focus)
      expect(restored.sessions[0]!.control).toEqual(recovered.session.control)
      // Non-handshake Providers may return before Node has installed its raw input reader. Wait
      // for this CLI's actual post-reader Hook response before delivering the test keyboard bytes.
      await waitForFact(readTrace, entries=>entries.filter(entry=>entry.mode === 'hook').length === 2)
      await desktop.write(restored.sessions[0]!.control,'INPUT-AFTER-RESTART\r','user')
      const traces = await waitForFact(readTrace, entries=>entries.some(entry=>entry.mode === 'input'))
      expect(traces.filter(entry=>entry.mode === 'launch')).toHaveLength(1)
      expect(traces.filter(entry=>entry.mode === 'resume')).toHaveLength(1)
      const resumedPid = traces.find(entry=>entry.mode === 'resume')!.pid
      expect(traces.find(entry=>entry.mode === 'launch')!.pid).toBe(originalPid)
      expect(resumedPid).toBeGreaterThan(1)
      expect(resumedPid).not.toBe(originalPid)
      // This PID arrived from the actual ctxmux process-state event, through the production Core
      // publisher and Desktop sampler. A native read-only RPC helper cannot satisfy this Run id.
      expect(trackedRun.mock.calls.find(([runId])=>runId === recovered.session.control.run.runId)?.[1]).toBe(resumedPid)
      expect(traces.filter(entry=>entry.mode === 'input')).toEqual([{mode:'input',agentSessionId:sessionId,pid:resumedPid}])
      expect(traces.filter(entry=>entry.mode === 'hook').map(entry=>entry.status)).toEqual([204,204])
      expect(traces.filter(entry=>entry.mode === 'read').map(entry=>entry.method)).toEqual(format === 'codex'
        ? ['initialize','thread/read','thread/items/list','initialize','thread/read','thread/items/list'] : [])
      expect((await loadAgentSessions(new AgentMuxFileAgentSessionStore(storePath))).map(session=>session.nativeHandle)).toEqual([captured.nativeHandle])
      expect(await readFile(persistedPath)).toEqual(durableUiBytes)
      console.log(JSON.stringify({schema:'agentmux.provider-identity-fixture.v1',providerId:provider.id,agentSessionId:sessionId,
        nativeSessionId:nativeId,originalRunId:originalRun.runId,originalPid,resumedRunId:recovered.session.control.run.runId,resumedPid,
        ctxmuxDaemonPid:daemon.pid,
        ctxmuxResumePid:trackedRun.mock.calls.find(([runId])=>runId === recovered.session.control.run.runId)?.[1],
        historyItemIds:[...older.items,...newest.items].map(item=>item.id),tabId,
        durableWorkbenchSha256:createHash('sha256').update(durableUiBytes).digest('hex'),
        agentExecutable:'private Node native CLI fixture',kernel:'vendored release18 ctxmuxd',actualElectronRestart:false,
        sanitizedAgentMuxEnv:true,privateHookRepairTargets:repairPlan!.mutations.map(mutation=>mutation.path)}))
      await desktop.write(recovered.session.control,'EXIT-PRIVATE\r','user')
      await waitForFact(() => desktop!.snapshot(privateConfig), value=>value.sessions[0]?.processState === 'exited')
    } finally {
      disposeUi?.()
      useAppStore.persist.setOptions(persistenceOptions)
      const disposed = await Promise.allSettled([desktop?.dispose(),first?.dispose()])
      daemon.kill('SIGTERM')
      const killTimer = setTimeout(() => daemon.kill('SIGKILL'),2_000)
      try { await daemonExit }
      finally {
        clearTimeout(killTimer)
        vi.unstubAllEnvs()
        fixtureHome.path = null
        await rm(root,{recursive:true,force:true})
      }
      const failures = disposed.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures,'Private identity clients failed cleanup')
    }
  },30_000)
})

// ---------------------------------------------------------------------------
// 性质 1：空快照 / 恢复路径故障不清工作面。
// ---------------------------------------------------------------------------
describe('空快照与流程故障不清工作面（T-005 性质 1）', () => {
  it('启动路径：一份空快照下持久化的 Agent Region 原样保留', async () => {
    const sessionId = 'agent-empty-startup'
    const { tabId, tab } = agentTab(sessionId)
    useAppStore.setState({
      loading: true,
      restoredWorkbench: {
        tabs: { [tabId]: tab },
        layouts: { 'workspace-a': createWorkspaceLayout('pane', [tabId]) }
      }
    })
    vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.providers, 'list').mockResolvedValue([])
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({
      sessions: [],
      timelines: {},
      recoveryCandidates: []
    })

    const dispose = await useAppStore.getState().initialize()
    const state = useAppStore.getState()

    // 承重：Region 与它在 layout 里的位置都还在。删掉 store.ts 空快照守卫（`retainUnknownSessionViews`
    // 那段的空判据）后，restoreTab 会因 session 不在而摘掉这一格，这两条随之变红。
    expect(state.tabs[tabId]).toEqual(tab)
    expect(state.layouts['workspace-a']?.groups[0]?.tabOrder).toEqual([tabId])
    // 且必须响亮告知，而不是静默保留。
    expect(state.error).toContain('returned no Session facts')
    dispose()
  })

  it('运行时成员对齐：空快照不退役仍在跑的 Agent（原样返回）', () => {
    const sessionId = 'agent-empty-resync'
    const { tabId, tab } = agentTab(sessionId)
    const state = {
      sessions: [agentSession(sessionId, 'run-1')],
      timelines: {},
      pendingAgentLaunches: {},
      tabs: { [tabId]: tab },
      layouts: { 'workspace-a': createWorkspaceLayout('pane', [tabId]) },
      viewModes: {}
    }
    const empty: RuntimeSnapshot = { sessions: [], timelines: {}, recoveryCandidates: [] }

    const next = reduceAgentMembershipSnapshot(state, empty, new Set())

    // 承重：不可逆的删除面前 fail-open——整份 state 原样返回。把 session-state.ts:343 的空快照守卫
    // 删掉（让它继续走 removeSessionProjection），这一格连 tab 带 layout 会被摘掉，这三条变红。
    expect(next).toBe(state)
    expect(next.tabs[tabId]).toBeDefined()
    expect(next.layouts['workspace-a']?.groups[0]?.tabOrder).toEqual([tabId])
  })

  it('运行时成员对齐：空快照不退役仍在跑的 Terminal（原样返回）', () => {
    const sessionId = 'terminal-empty-resync'
    const { tabId, tab } = terminalTab(sessionId)
    const state = {
      sessions: [terminalSession(sessionId)],
      timelines: {},
      pendingAgentLaunches: {},
      tabs: { [tabId]: tab },
      layouts: { 'workspace-a': createWorkspaceLayout('pane', [tabId]) },
      viewModes: {}
    }
    const empty: RuntimeSnapshot = { sessions: [], timelines: {}, recoveryCandidates: [] }

    // 非空快照先立一个对照：这个 reducer 确实会摘掉快照里没有的 terminal。没有这一半，下面
    // 「空快照原样返回」就可能只是因为它对 terminal 从来什么都不做——那种绿是恒真的。
    const authoritative: RuntimeSnapshot = {
      sessions: [terminalSession('terminal-somebody-else')],
      timelines: {},
      recoveryCandidates: []
    }
    expect(reduceTerminalMembershipSnapshot(state, authoritative).tabs[tabId]).toBeUndefined()

    const next = reduceTerminalMembershipSnapshot(state, empty)

    // 承重：同一条 fail-open 规则的第二个出口。reduceTerminalMembershipSnapshot 的 docstring 明写
    // 「An empty snapshot is deliberately fail-open」，但在此之前**只有 agent 那一侧被钉住**——实测
    // 把 session-state.ts:384 的空快照守卫删掉，整份 desktop 测试面全绿。把它删掉，这三条会红。
    expect(next).toBe(state)
    expect(next.tabs[tabId]).toBeDefined()
    expect(next.layouts['workspace-a']?.groups[0]?.tabOrder).toEqual([tabId])
  })

  it('启动路径：自动恢复调用抛错时（我们这步故障），原 Region 仍可见', async () => {
    const sessionId = 'agent-recovery-failed'
    const { tabId, tab } = agentTab(sessionId)
    useAppStore.setState({
      loading: true,
      restoredWorkbench: {
        tabs: { [tabId]: tab },
        layouts: { 'workspace-a': createWorkspaceLayout('pane', [tabId]) }
      }
    })
    vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.providers, 'list').mockResolvedValue([])
    // 快照点名它为恢复候选（「还在，只是要重连」），但恢复调用本身抛错——这是 class-2：我们这步
    // 失败了，不是 Agent 死了。不能据此删掉用户的 Region。
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({
      sessions: [],
      timelines: {},
      recoveryCandidates: [{
        agentSessionId: sessionId,
        semanticStatus: { state: 'done', source: 'native-hook', observedAt: Date.now(), stateEnteredAt: Date.now() },
        hostId: 'local',
        workspacePath: '/repo/a',
        providerId: 'codex',
        executorId: 'codex',
        capabilities: {
          terminal: true,
          timeline: 'complete-events',
          permission: 'observe',
          providerResume: true,
          replyCorrelation: 'none'
        },
        label: 'Codex',
        createdAt: 1,
        updatedAt: 1,
        run: { runId: 'run-1' }
      }]
    })
    vi.spyOn(api.sessions, 'recover').mockRejectedValue(new Error('Provider handshake unavailable'))

    const dispose = await useAppStore.getState().initialize()
    const state = useAppStore.getState()

    // 承重：Region 保留，且故障被说清（而非静默）。
    expect(state.tabs[tabId]).toEqual(tab)
    expect(state.layouts['workspace-a']?.groups[0]?.tabOrder).toEqual([tabId])
    expect(state.error).toContain('Automatic Agent recovery did not complete: Provider handshake unavailable')
    expect(state.error).toContain('The original Region remains visible')
    dispose()
  })
})

// ---------------------------------------------------------------------------
// 性质 2：新进程按原 Session 身份恢复，输入投到它、不投到新铸身份。
//
// 分工：Core owner 侧证「provider-native resume 后仍是原 agentSessionId、输入落到新 Run 而非退役
// 旧 Run」，并带真 mutation（见 packages/core/test/agent-session-continuity.test.ts 的
// 「重启恢复保持原 Session 身份且输入不误投递」——把 client.ts 的 `...current` 换成铸新 id 会让那
// 两条红）。这里证渲染/重启 owner 侧的对应半：新进程的第一份权威快照到达后，持久化 Region 绑回
// **原身份**，投递用的 control 正是这个原身份——不孤儿化、不改键。
// ---------------------------------------------------------------------------
describe('重启后按原 Session 身份恢复且输入不误投递（T-005 性质 2）', () => {
  it('一份活的快照把持久化 Region 恢复到原 agentSessionId 与原 control（投递身份不漂移）', async () => {
    const sessionId = 'agent-restart-identity'
    const restoredRunId = 'run-after-restart'
    const { tabId, tab } = agentTab(sessionId)
    useAppStore.setState({
      loading: true,
      restoredWorkbench: {
        tabs: { [tabId]: tab },
        layouts: { 'workspace-a': createWorkspaceLayout('pane', [tabId]) }
      }
    })
    vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.providers, 'list').mockResolvedValue([])
    // 新进程的第一份权威快照：同一 agentSessionId 下的一个活着的 Run（重启后 reattach/resume 的结果）。
    const restored = agentSession(sessionId, restoredRunId)
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({
      sessions: [restored],
      timelines: { [sessionId]: { agentSessionId: sessionId, revision: 1, items: [] } },
      recoveryCandidates: []
    })

    const dispose = await useAppStore.getState().initialize()
    const state = useAppStore.getState()

    // 承重：恢复出来的 Session 仍是**原身份**（agentSessionId 未变），绑到重启后的新 Run；持久化
    // Region 依旧挂在这个原身份上。TerminalView 键入走 `api.sessions.write(session.control, data)`，
    // 用的正是这个 control，所以「control 保持原身份」就是「输入投回原 Agent、不投到新铸身份」。
    // 若恢复铸了新 id，权威快照里就没有原 sessionId，下面 find 得到 undefined，Region 也绑不回去——
    // 三条都红。（铸新 id 的生产 owner 是 Core 的 client.ts；那侧的 mutation 证据见 core 测试。）
    const projected = state.sessions.find((session) => session.id === sessionId)
    expect(projected?.control).toMatchObject({
      kind: 'agent',
      agentSessionId: sessionId,
      run: { runId: restoredRunId }
    })
    const surface = workbenchSurfaces(state.tabs[tabId]!).find((s) => s.kind === 'agent')
    expect(surface).toMatchObject({ kind: 'agent', sessionId })
    expect(state.layouts['workspace-a']?.groups[0]?.tabOrder).toEqual([tabId])
    dispose()
  })
})
