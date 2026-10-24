// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Terminal as BrowserTerminal } from '@xterm/xterm'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { inspect } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxFileAgentSessionStore } from '@agentmux/core'
import { createWorkspaceLayout } from '@agentmux/layout'
import { headlessFixture, until } from '../../../packages/core/test/helpers/headless-runtime-fixture'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { bridge, owningBridge } from './fixtures/terminal-observation-bridge'
import { useAppStore } from '../src/renderer/src/store'
import { TerminalView } from '../src/renderer/src/components/TerminalView'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { readTerminalViewObservation } from '../src/renderer/src/lib/terminal-view-observation'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { type AppConfig, type SessionControl, type SessionSnapshot } from '../src/shared/contracts'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false))
const fixture = vi.hoisted(() => ({ terminals: [] as BrowserTerminal[], reports: [] as import('@agentmux/core').AgentMuxClientIncidentReport[] }))
vi.mock('../src/renderer/src/lib/client-incident-recorder', async load => {
  const actual = await load<typeof import('../src/renderer/src/lib/client-incident-recorder')>()
  return { ...actual, createClientIncidentRecorder(input: Parameters<typeof actual.createClientIncidentRecorder>[0]) {
    return actual.createClientIncidentRecorder({ ...input, send: report => { fixture.reports.push(report); input.send(report) } })
  } }
})
vi.mock('@xterm/xterm', async () => {
  const { Terminal } = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm')
  return { Terminal: class extends Terminal {
    constructor(options: ConstructorParameters<typeof Terminal>[0]) { super(options); fixture.terminals.push(this) }
  } }
})
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { activate() {} dispose() {} fit() {} proposeDimensions() { return { cols: 80, rows: 24 } } } }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { activate() {} dispose() {} onDidChangeResults() { return { dispose() {} } } } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class { activate() {} dispose() {} } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { activate() {} dispose() {} onContextLoss() { return { dispose() {} } } } }))
vi.mock('../src/renderer/src/components/TerminalContextMenu', async () => {
  const { createElement } = await import('react')
  return { TerminalContextMenu: ({ children }: { children: ReactNode }) => createElement('div', null, children) }
})

const original = useAppStore.getState()
const origin = { workspaceId: 'private', tabGroupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' }
let scope: Awaited<ReturnType<typeof headlessFixture>>
let owner: Awaited<ReturnType<typeof owningBridge>>
let config: AppConfig, root: Root, container: HTMLDivElement
let run: { runId: string; pid: number | null }
const persistenceOptions = useAppStore.persist.getOptions()

let corrupted = 0, publicRpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
let publicFollow: { dispose(): Promise<void> } | undefined
const events: import('@agentmux/core').AgentMuxClientEvent[] = []
function resource(value: Record<string, unknown>) {
  if (process.env.SHARED_HANDOFF_RESOURCES) appendFileSync(process.env.SHARED_HANDOFF_RESOURCES, JSON.stringify({ ...value, workerPid: process.pid }) + '\n')
}
async function ownerRecords() {
  return (await readFile(join(scope.env.AGENTMUX_STATE_DIRECTORY!, 'handoff-owner.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}
function text(terminal: BrowserTerminal) {
  return Array.from({length:terminal.buffer.active.length},(_,index)=>terminal.buffer.active.getLine(index)?.translateToString(true)).join('\n')
}
function observation(session: SessionSnapshot) {
  return readTerminalViewObservation({regionId:origin.regionId,sessionId:session.id,runId:session.control.run.runId})
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('OffscreenCanvas', undefined)
  // Supply only font layout at the DOM boundary; xterm owns its real viewport and key scrolling.
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')?.get
  const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')?.get
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function () {
    return this.classList.contains('xterm-char-measure-element') ? this.textContent!.length * 9 : width?.call(this) ?? 0
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () {
    return this.classList.contains('xterm-char-measure-element') ? 18 : height?.call(this) ?? 0
  })
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockImplementation(()=>({font:'',measureText:()=>({width:8,actualBoundingBoxDescent:2,actualBoundingBoxAscent:10})}) as unknown as CanvasRenderingContext2D)
  fixture.terminals.length=0; fixture.reports.length=0; events.length=0; corrupted=0
  scope=await headlessFixture()
  resource({event:'allocated',root:scope.root,nativePid:scope.nativeProcessId,ownerPid:scope.ownerProcess.pid})
  for (const [key,value] of Object.entries(scope.env)) if (/^(HOME$|AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key,value)
  vi.stubEnv('AGENTMUX_SPATIAL_STATE_STORE',join(scope.root,'spatial.json'))
  const client=await scope.client(); client.onEvent(event=>events.push(event))
  config={...structuredClone(DEFAULT_CONFIG),hosts:[{id:'local',kind:'local',label:'Private proof'}],workspaces:[{id:'private',kind:'folder',hostId:'local',name:'Private proof',path:scope.root}]}
  owner=await owningBridge({client:client as never,store:new AgentMuxFileAgentSessionStore(scope.env.AGENTMUX_AGENT_SESSION_STORE!),config})
  resource({event:'bridge',root:bridge.directory})
  const invoke=bridge.invoke.getMockImplementation()!
  bridge.invoke.mockImplementation(async(...args)=>{try{return structuredClone(await invoke(...args))}catch(error){throw new Error(error instanceof Error?error.message:String(error))}})
  container=document.createElement('div');document.body.append(container);root=createRoot(container)
})
afterEach(async () => {
  const errors: unknown[]=[]
  for (const close of [async()=>{await act(async()=>root?.unmount())},async()=>{await publicFollow?.dispose();await publicRpc?.dispose()},async()=>owner?.dispose(),async()=>scope?.cleanup()]) {
    try{await close()}catch(error){errors.push(error);resource({event:'cleanup-error',detail:inspect(error,{depth:8})})}
  }
  publicFollow=undefined;publicRpc=undefined
  resource({event:'released',root:scope?.root,nativePid:scope?.nativeProcessId,ownerPid:scope?.ownerProcess.pid})
  if(run?.pid)expect(()=>process.kill(run.pid!,0)).toThrow()
  useAppStore.setState(original,true);useAppStore.persist.setOptions(persistenceOptions)
  document.body.replaceChildren();bridge.listeners.clear();vi.restoreAllMocks();vi.unstubAllEnvs()
  if(errors.length)throw new AggregateError(errors,'Private mounted shared observation cleanup failed')
})
it('shared observation keeps actual Native mounted history and public follower continuous through another reader fresh cut',async()=>{
  const client=owner.client as Awaited<ReturnType<typeof scope.client>>
  const commands=join(scope.root,'output.json')
  const agent=await client.createAgent({createOperationId:'original-shared-agent',providerId:'codex',executorId:'codex',workspacePath:scope.root,
    commandOverride:process.execPath,args:[resolve('apps/desktop/test/fixtures/shared-run-output.mjs'),commands],injectAgentMuxGuide:false,cols:80,rows:24})
  run=(await client.listRuns()).find(value=>value.runId===agent.run.runId)!
  resource({event:'run',runId:run.runId,pid:run.pid})
  const control:SessionControl={kind:'agent',hostId:'local',agentSessionId:agent.agentSessionId,run:agent.run}
  const session=(await owner.runtime.refresh(control,config))!
  const tab=createWorkbenchTab(origin.tabId,{regionId:origin.regionId,kind:'agent',phase:'attached',workspaceId:'private',sessionId:session.id})
  useAppStore.setState({sessions:[session],config,tabs:{[tab.id]:tab},layouts:{private:createWorkspaceLayout(origin.tabGroupId,[tab.id])},activeWorkspaceId:'private',
    closingWorkbenchViews:{},regionCaretFocus:null,timelines:{},pendingAgentLaunches:{},recoveryCandidates:[],viewModes:{},agentComposerDrafts:{[origin.regionId]:'retained original draft'}})
  await act(async()=>root.render(createElement(TerminalView,{session,interactiveResize:false,visible:true,autoFocus:false,themeId:config.appearance.terminalTheme,linkOrigin:origin})))
  await act(async()=>await until(()=>observation(session)?.liveReady,Boolean,'mounted original live reader'))
  const terminal=fixture.terminals[0]!
  await act(async()=>await until(()=>text(terminal),value=>value.includes('original-history-179'),'real initial private output'))
  // Grow actual live history after the initial checkpoint; its seed may cover only the current screen.
  await writeFile(commands,JSON.stringify({revision:0,text:Array.from({length:160},(_,index)=>`live-history-${index}\n`).join('')}))
  await act(async()=>await until(()=>text(terminal),value=>value.includes('live-history-159'),'actual live scrollback'))
  expect(terminal.buffer.active.baseY).toBeGreaterThan(0)
  // happy-dom omits legacy keyboard fields; real xterm key handling still owns the reading action.
  await act(async()=>terminal.focus())
  for(let index=0;index<3;index++)await act(async()=>{
    const key=new KeyboardEvent('keydown',{key:'PageUp',code:'PageUp',shiftKey:true,bubbles:true,cancelable:true})
    Object.defineProperties(key,{keyCode:{value:33},which:{value:33}})
    terminal.textarea!.dispatchEvent(key)
  })
  await act(async()=>await until(()=>terminal.buffer.active.viewportY,value=>value<terminal.buffer.active.baseY,'actual Shift-PageUp reading'))
  const reading=terminal.buffer.active.viewportY,firstLine=terminal.buffer.active.getLine(reading)!.translateToString(true)
  terminal.select(0,reading,12);const selection=terminal.getSelection();expect(selection.length).toBeGreaterThan(0)
  publicRpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:scope.socketPath}})
  let followed='',followerErrors=0
  publicFollow=await publicRpc.subscribe('agent.output',{agentSessionId:agent.agentSessionId,afterByte:0,follow:true},{onInitial(){},onEvent(event){
    if(event.type==='output')followed+=Buffer.from(event.data.dataBase64,'base64').toString()
    if(event.type==='error')followerErrors++
  }})
  await until(()=>followed,value=>value.includes('original-history-179'),'actual public agent.output follower')
  const initialPumps=(await ownerRecords()).filter(value=>value.event==='pump'&&value.runId===run.runId).map(value=>value.id)
  const holding=join(scope.env.AGENTMUX_STATE_DIRECTORY!,'hold-pump');await writeFile(holding,'hold')
  await writeFile(commands,JSON.stringify({revision:1,text:'retained-during-the-fresh-cut\n'}))
  await until(ownerRecords,rows=>rows.some(value=>value.event==='held'&&value.runId===run.runId),'Native original iterator held after retained output')
  const secondRpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:scope.socketPath}})
  const subscribe=secondRpc.subscribe.bind(secondRpc);let rejectFirst=true
  vi.spyOn(secondRpc,'subscribe').mockImplementation(async(method,params,handlers)=>await subscribe(method,params,{...handlers,onEvent(event){
    if(method==='runtime.attachment-watch'&&event.type==='snapshot'&&rejectFirst){rejectFirst=false;corrupted++;handlers.onEvent({...event,data:{...event.data,index:event.data.index+1}});return}
    handlers.onEvent(event)
  }}))
  const second=await scope.client(secondRpc)
  try{
    await expect(second.reattachAgent(agent.agentSessionId,0,'terminal')).rejects.toMatchObject({code:'CONTROL_PROTOCOL_ERROR'})
    const fresh=await second.refreshRunAttachment(agent.run,0,'terminal')
    expect(fresh.run).toMatchObject({runId:run.runId,pid:run.pid,acceptedInputBytes:0})
    expect(fresh.terminal.type).toBe('basic-vt');expect(corrupted).toBe(1)
    await rm(holding)
    await act(async()=>await until(()=>text(terminal),value=>value.includes('retained-during-the-fresh-cut'),'original pump still applies its retained suffix'))
    await writeFile(commands,JSON.stringify({revision:2,text:'live-after-the-shared-refresh\n'}))
    await act(async()=>await until(()=>text(terminal),value=>value.includes('live-after-the-shared-refresh'),'original live output after fresh cut'))
    await until(()=>followed,value=>value.includes('live-after-the-shared-refresh'),'public follower continues after fresh cut')
    expect(terminal.buffer.active.viewportY).toBe(reading)
    expect(terminal.buffer.active.getLine(reading)!.translateToString(true)).toBe(firstLine)
    expect(terminal.getSelection()).toBe(selection)
    expect(fixture.terminals).toEqual([terminal])
    expect(useAppStore.getState().agentComposerDrafts[origin.regionId]).toBe('retained original draft')
    expect(useAppStore.getState().tabs[origin.tabId]!.regions[origin.regionId]).toMatchObject({sessionId:session.id})
    expect(events.filter(event=>event.type==='attachment-state'&&event.state==='unavailable')).toEqual([])
    expect(events.filter(event=>event.type==='terminal-snapshot')).toEqual([])
    expect(followerErrors).toBe(0)
    const current=(await client.listRuns()).find(value=>value.runId===run.runId)!
    expect(current).toMatchObject({pid:run.pid,state:'running',acceptedInputBytes:0})
    const ending=await ownerRecords(),pumps=ending.filter(value=>value.event==='pump'&&value.runId===run.runId).map(value=>value.id)
    expect(pumps).toEqual(initialPumps)
    const freshIds=ending.filter(value=>value.event==='opened'&&value.runId===run.runId&&!initialPumps.includes(value.id)).map(value=>value.id)
    expect(freshIds.length).toBeGreaterThan(0)
    for(const id of freshIds)expect(ending.some(value=>value.id===id&&['detached','closed'].includes(value.event))).toBe(true)
    expect(bridge.invoke.mock.calls.filter(call=>['sessions:write','sessions:paste','sessions:submitPrompt','sessions:restart','sessions:recover','sessions:refreshAttachment'].includes(call[0]))).toEqual([])
    resource({event:'preserved',runId:run.runId,pid:run.pid,acceptedInputBytes:current.acceptedInputBytes,reading,selection:true,corruptedTransfers:corrupted,originalPumps:initialPumps.length,finalPumps:pumps.length,publicFollower:true})
  }finally{await rm(holding,{force:true});await second.dispose();await secondRpc.dispose()}
},40000)
