import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { createWorkspaceLayout } from '@agentmux/layout'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { PmoTeamsTopicEntry } from '../../../src/renderer/src/components/PmoTeamsTopicEntry'
import { PmoTeamsTopicFloatingPanel } from '../../../src/renderer/src/components/PmoTeamsTopicFloatingPanel'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { WindowOverlayHost } from '../../../src/renderer/src/components/WindowOverlayHost'
import { useAppStore, executorDetectionKey, warmTerminalKey, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { useLauncherState } from '../../../src/renderer/src/lib/launcher-state'
import { usePmoTeamsTopicFloatingState, readPmoTeamsTopicFloatingState, pmoTeamsTopicFloatingViewTargets } from '../../../src/renderer/src/lib/pmo-teams-topic-floating'
import { createWorkbenchTab, addWorkbenchRegion } from '../../../src/renderer/src/lib/workbench-tabs'
import { draftDocument } from '../../../src/renderer/src/components/InlineComposer'
import type { Editor } from '@tiptap/core'
import { SCRATCH_WORKSPACE_ID } from '../../../src/shared/scratch-topics'
import '../../../src/renderer/src/styles/index.css'

// The production Workbench/Region, rich inputs, CSS and xterm run unchanged. Only native preview
// facts are controlled. This is not a vendor CLI or installed user-App proof.
const restarting = new URLSearchParams(location.search).get('phase') === 'restart'
const restartFacts = (window as typeof window & { launchpadFixtureBootFacts?: any }).launchpadFixtureBootFacts
if (!restarting) {
  const initial=await api.config.get()
  await api.config.save({...initial,workspaces:[...initial.workspaces.map(item=>item.path==='home//agentmux'?{...item,path:'/Users/preview/projects/agentmux'}:item),{id:SCRATCH_WORKSPACE_ID,name:'No Project',path:'/Users/preview/.agentmux/scratch',hostId:'local',kind:'folder'}]},initial)
  const snapshot=api.sessions.snapshot
  api.sessions.snapshot=async()=>{const value=await snapshot();return {...value,sessions:value.sessions.map(session=>session.workspacePath==='home//agentmux'?{...session,workspacePath:'/Users/preview/projects/agentmux'}:session)}}
}
if (restarting) {
  if (!restartFacts) throw new Error('Restart must have the exact captured preview API facts, not seeded views')
  api.config.get = async () => structuredClone(restartFacts.config)
  api.sessions.snapshot = async () => structuredClone(restartFacts.snapshot)
  api.sessions.attach = async control => {
    const session = restartFacts.snapshot.sessions.find((item: any) => item.control.run.runId === control.run.runId)
    if (!session) throw new Error('Captured preview Run is absent')
    const data = '$ original neighboring shell retained\r\n$ ', dataBytes = new TextEncoder().encode(data)
    return { attachmentId: crypto.randomUUID(), session, currentSize: {cols:80,rows:24}, resizeRevision:0,
      terminal: {type:'basic-vt',checkpoint:{runId:control.run.runId,throughByte:0,resizeRevision:0,size:{cols:80,rows:24}},restoreBytes:new Uint8Array(),resizes:[]},
      replay:[{type:'data',runId:control.run.runId,startByte:0,endByte:dataBytes.length,data,dataBytes}],gap:null }
  }
}
await useAppStore.getState().initialize()
const boot = useAppStore.getState(), baseConfig = boot.config!
const workspace = baseConfig.workspaces[0]!, workspaceId = workspace.id
const tabId = 'launchpad-tab', regionId = 'launchpad-input', neighborId = 'launchpad-neighbor', groupId = 'launchpad-group'
const snapshot = await api.sessions.snapshot()
const agents = snapshot.sessions.filter(session => session.kind === 'agent')
const warm = restarting ? restartFacts.warm : await api.sessions.launchTerminal({ hostId: workspace.hostId, workspacePath: workspace.path })
const neighbor = restarting ? restartFacts.neighbor : await api.sessions.launchTerminal({ hostId: workspace.hostId, workspacePath: workspace.path })
const calls = { stops: [] as unknown[], browsers: [] as unknown[], files: [] as unknown[], submissions: [] as unknown[], launches: [] as unknown[] }
const stop = api.sessions.stop, browserCreate = api.browser.create, write = api.files.write, submit = api.sessions.submitPrompt, launch = api.sessions.launchAgent
api.sessions.stop = async (...args) => { calls.stops.push(args); return stop(...args) }
api.browser.create = async (...args) => { calls.browsers.push(args); return browserCreate(...args) }
api.files.write = async (...args) => { calls.files.push(args); return write(...args) }
api.sessions.submitPrompt = async (...args) => { calls.submissions.push(args); return submit(...args) }
api.sessions.launchAgent = async (...args) => { calls.launches.push(args); return launch(...args) }
if (!restarting) {
  const attach=api.sessions.attach
  api.sessions.attach=async (...args)=>{
    const result=await attach(...args)
    return {...result,session:{...result.session,latestOutputBytes:Math.max(0,...result.replay.map(chunk=>chunk.endByte))},currentSize:{cols:80,rows:24},terminal:{type:'basic-vt',checkpoint:{runId:args[0].run.runId,throughByte:0,resizeRevision:0,size:{cols:80,rows:24}},restoreBytes:new Uint8Array(),resizes:[]}}
  }
}
if (!restarting) useLauncherState.getState().setSection(SCRATCH_WORKSPACE_ID,'terminal','hidden')
const root = createRoot(document.getElementById('root')!)
function Shell() {
  const [floating, setFloating] = usePmoTeamsTopicFloatingState()
  const tabs=useAppStore(state=>state.tabs),layouts=useAppStore(state=>state.layouts),agentFocus=useAppStore(state=>state.agentFocus)
  const targets=pmoTeamsTopicFloatingViewTargets(floating,tabs,layouts[SCRATCH_WORKSPACE_ID],agentFocus.pmo.sessionId)
  return <><div id="fixture-workbench"><WorkspaceWorkbench workspaceId={workspaceId} /></div>
    <footer id="fixture-footer"><span>{useAppStore.getState().config?.workspaces.find(item => item.id === workspaceId)?.name}</span><PmoTeamsTopicEntry /></footer>
    <div className="workspace-workbench-slot workspace-workbench-slot--parked" aria-hidden inert><WorkspaceWorkbench workspaceId={SCRATCH_WORKSPACE_ID} visible={false} viewTargets={targets} /></div>
    <WindowOverlayHost><PmoTeamsTopicFloatingPanel floating={floating} setFloating={setFloating} /></WindowOverlayHost></>
}
const probe = {
  workspaceId, tabId, regionId, neighborId, groupId,
  readBeforeFixtureSetup: restarting ? {tabs:boot.tabs,layouts:boot.layouts,activeWorkspaceId:boot.activeWorkspaceId,sections:useLauncherState.getState().sections,drafts:useLauncherState.getState().drafts,sourceDraft:boot.agentComposerDrafts[regionId]} : null,
  flush() { return prepareRendererUpdate('quit') },
  bootFacts() { const state=useAppStore.getState(); return {config:state.config,snapshot:{...snapshot,sessions:state.sessions,timelines:state.timelines,recoveryCandidates:state.recoveryCandidates},warm,neighbor} },
  settings() { flushSync(()=>root.render(<div style={{display:'flex',width:'100%',height:'100%'}}><SettingsPanel onClose={()=>probe.scene()} /></div>)) },
  scene({ split = false, long = false, theme = 'dark', ratio = 0.5 } = {}) {
    document.documentElement.dataset.appearance = theme
    const config = structuredClone(baseConfig)
    config.executors = Object.fromEntries(Object.entries(config.executors).slice(0, 6))
    config.workspaces = config.workspaces.map(item => item.id === workspaceId ? { ...item,
      name: long ? 'AgentMux · distributed runtime & workspace orchestration' : 'AgentMux',
      path: workspace.path } : item)
    config.hosts = config.hosts.map(host => host.id === workspace.hostId ? { ...host, label: long ? 'Local development · engineering workstation' : 'This Mac' } : host)
    const detections = Object.fromEntries(Object.entries(config.executors).map(([executorId, executor]) => [executorDetectionKey(workspace.hostId, executorId), {
      state: 'ready' as const, input: { executorId, providerId: executor.providerId, command: executor.command, host: config.hosts.find(host => host.id === workspace.hostId)! },
      result: { availability: 'available', executable: executor.command }, detail: 'Controlled preview detection result' }]))
    let tab = createWorkbenchTab(tabId, { regionId, kind: 'launcher', workspaceId })
    if (split) tab = addWorkbenchRegion(tab, regionId, 'right', { regionId: neighborId, kind: 'terminal', phase: 'attached', workspaceId, sessionId: neighbor.id })
    tab = { ...tab, layout: { ...tab.layout, root: tab.layout.root.type==='split'?{...tab.layout.root,ratio}:tab.layout.root, activeRegionId: regionId } }
    const state = useAppStore.getState()
    flushSync(() => useAppStore.setState({ config, sessions: [...agents, neighbor], executorDetections: detections,
      tabs: { ...Object.fromEntries(Object.entries(state.tabs).filter(([, item]) => item.workspaceId !== workspaceId)), [tabId]: tab },
      layouts: { ...state.layouts, [workspaceId]: createWorkspaceLayout(groupId, [tabId]) }, activeWorkspaceId: workspaceId,
      mainSurface: 'workbench', loading: false, retainedSpatialFocus: null, workbenchNavigationInputPolicy: null, workbenchSpaceSelection: null,
      warmTerminal: { key: warmTerminalKey(workspace.hostId, workspace.path), ownerLauncherId: `region:${regionId}`, session: warm, ready: Promise.resolve(warm) },
      recoveryCandidates: agents.map(session => ({ agentSessionId: session.id, hostId: session.hostId, workspacePath: session.workspacePath,
        providerId: session.providerId!, executorId: session.executorId!, capabilities: session.capabilities, label: session.label,
        createdAt: session.createdAt, updatedAt: session.updatedAt, run: session.control.run })),
      agentNames: { ...state.agentNames, [agents[0]!.id]: 'Runtime architecture', [agents[1]!.id]: 'Renderer composition' },
      timelines: snapshot.timelines,
      agentComposerDrafts: { [regionId]: 'Review the launch experience and preserve the original working context.\nFocus on clear runtime facts and small Region usability.', ...state.agentComposerDrafts } }))
    flushSync(() => root.render(<Shell />))
  },
  editNote(text: string) {
    const node = document.querySelector<HTMLElement & { editor: Editor }>(`[data-workbench-region-id="${regionId}"] .launcher-note-composer .tiptap`)
    if (!node?.editor) throw new Error('Actual Note editor is absent')
    node.editor.commands.setContent(draftDocument(text)); node.editor.commands.focus()
  },
  terminalFacts() { const records=(window as any).launchpadTerminals??[];const node=document.querySelector(`[data-workbench-region-id="${regionId}"] .launch-terminal__body .xterm`);const actual=records.find((item:any)=>item.element===node&&!item.disposed);if(!actual)return null;const buffer=actual.buffer.active;return {rows:actual.rows,cols:actual.cols,lines:Array.from({length:actual.rows},(_,index)=>buffer.getLine(buffer.viewportY+index)?.translateToString(true)??'')} },
  facts() {
    const state = useAppStore.getState(), launcher = useLauncherState.getState()
    return { sections: launcher.sections[workspaceId], drafts: launcher.drafts[`region:${regionId}`], selectedExecutor: launcher.executors[workspaceId],
      sourceDraft: state.agentComposerDrafts[regionId], agentDrafts: state.agentComposerDrafts, activeWorkspaceId: state.activeWorkspaceId,
      tab: state.tabs[tabId], layout: state.layouts[workspaceId], warmRun: state.warmTerminal?.session?.control.run.runId,
      originalWarmRun: warm.control.run.runId, neighborRun: neighbor.control.run.runId, calls, floating: readPmoTeamsTopicFloatingState(),
      storageBytes: localStorage.getItem('agentmux-launcher'), workbenchStorageBytes: localStorage.getItem('agentmux-workbench-v1'), persistenceIssue: launcher.persistenceIssue }
  },
  geometry() {
    const region = document.querySelector<HTMLElement>(`[data-workbench-region-id="${regionId}"]`)!, surface = region.querySelector<HTMLElement>('.launch-surface')!
    const box = (e: Element) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom } }
    return { region: box(region), surface: box(surface), clientWidth: surface.clientWidth, scrollWidth: surface.scrollWidth,
      clientHeight: surface.clientHeight, scrollHeight: surface.scrollHeight,
      controls: [...surface.querySelectorAll('button,input,[role="textbox"]')].map(e => ({ label: e.getAttribute('aria-label') ?? e.textContent?.trim(), box: box(e) })) }
  }
}
Object.assign(window, { launchpad: probe })
if (restarting) flushSync(()=>root.render(<Shell />)); else probe.scene()
