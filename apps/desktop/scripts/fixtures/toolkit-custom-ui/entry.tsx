import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { loader } from '@monaco-editor/react'
import '../../../src/renderer/src/monaco'
import { createWorkspaceLayout } from '@agentmux/layout'
import { App } from '../../../src/renderer/src/App'
import { api } from '../../../src/renderer/src/lib/api'
import { createRendererSessionEvents } from '../../../src/renderer/src/lib/session-events'
import { useAppStore } from '../../../src/renderer/src/store'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { readTerminalViewObservation } from '../../../src/renderer/src/lib/terminal-view-observation'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import '../../../src/renderer/src/styles/index.css'

// First App hydrate sees the unique private ConfigOwner. Qualification consumes the
// actual RuntimeController Session bridge; preview scenes keep their controlled boundary.
const w = window as any, bridge = w.toolkitProof
const setup = await bridge.seed(await api.config.get())
api.config.get = () => bridge.get()
api.config.save = (next, expected) => bridge.save(next, expected)
api.config.onChange = listener => bridge.onChange(listener)
api.ui.requestStorageFlush = () => bridge.flush()
api.toolkit = w.agentmux.toolkit
const attachments: unknown[] = [], writes: unknown[] = [], events: unknown[] = [], toolkitCalls: unknown[] = []
if (setup.qualification) {
  const original=w.agentmux.toolkit, observed:any={...original}
  for(const method of ['add','update','remove','get','run','stop','action']) observed[method]=async(...input:unknown[])=>{
    const fact:{method:string;input:unknown[];at:number;returnedAt?:number;result?:unknown;error?:string}={method,input,at:Date.now()};toolkitCalls.push(fact)
    try{fact.result=await original[method](...input);fact.returnedAt=Date.now();return fact.result}catch(error){fact.returnedAt=Date.now();fact.error=String(error);throw error}
  }
  api.toolkit=observed
  api.sessions = { ...w.agentmux.sessions, onEvent: createRendererSessionEvents(w.agentmux.sessions.onEvent) }
  const attach = api.sessions.attach, write = api.sessions.write
  api.sessions.attach = async (...args) => { const result = await attach(...args); attachments.push({ control: args[0], attachmentId: result.attachmentId, session: result.session }); return result }
  api.sessions.write = async (...args) => { await write(...args); writes.push({ control: args[0], data: args[1], source: args[2] }) }
  document.addEventListener('keydown', event => events.push({ key: event.key, isTrusted: event.isTrusted, isComposing: event.isComposing, target: (event.target as HTMLElement)?.className, originalInputTarget: event.target === w.toolkitInputNode }), true)
}
createRoot(document.getElementById('root')!).render(createElement(App))
while (useAppStore.getState().loading || !useAppStore.getState().config) await new Promise(resolve => setTimeout(resolve, 10))
const state = useAppStore.getState(), session = state.sessions.find(value => setup.qualification ? value.control.run.runId === setup.healthy.runId : value.id === 'session-codex')
if (!session) throw Error('The bounded preview Session must be nonempty.')
const workspace = state.config!.workspaces.find(value => value.hostId === session.hostId) ?? state.config!.workspaces[0]!
if (!setup.qualification || setup.stage === 'control') {
const tab = createWorkbenchTab('toolkit-original-tab', { regionId: 'toolkit-original-region', kind: setup.qualification ? 'terminal' : 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: session.id })
useAppStore.setState({ tabs: { [tab.id]: tab }, layouts: { ...state.layouts, [workspace.id]: createWorkspaceLayout('toolkit-original-group', [tab.id]) },
  activeWorkspaceId: workspace.id, mainSurface: 'workbench', toolsOpen: false, projectRailOpen: false,
  viewModes: { [session.id]: 'terminal' }, agentComposerDrafts: { [session.id]: 'Original unsent draft remains exact.' } })
}
const surface = () => { const value = useAppStore.getState(); return { ...projectPersistedWorkbench(value), mainSurface: value.mainSurface, activeWorkspaceId: value.activeWorkspaceId, drafts: value.agentComposerDrafts, sessions: value.sessions.filter(value => !setup.qualification || value.id === session.id).map(session => ({ id: session.id, control: session.control })) } }
w.toolkitScene = {
  ready: true, setup, attachments, writes, events, toolkitCalls, surface, display: () => useAppStore.getState().config?.toolkit, facts: () => bridge.facts(),
  holdSave: () => bridge.holdSave(), saveHeld: () => bridge.saveHeld(), releaseSave: () => bridge.releaseSave(),
  terminalObservation: () => readTerminalViewObservation({regionId:'toolkit-original-region',sessionId:session.id,runId:session.control.run.runId}),
  terminalReplay: async () => { const attachment=[...attachments as any[]].reverse().find(value=>value.session.control.run.runId===session.control.run.runId);if(!attachment)throw Error('No actual Terminal consumer attachment');return await api.sessions.replay(attachment.attachmentId,0) },
  scriptValue: async () => { const models=(await loader.init()).editor.getModels();if(models.length!==1)throw Error('Expected one selected actual model');return models[0]!.getValue() },
  models: async () => (await loader.init()).editor.getModels().map(model => ({uri:model.uri.toString(),scheme:model.uri.scheme,authority:model.uri.authority,path:model.uri.path,disposed:model.isDisposed()})),
  unrelated: () => { const current=useAppStore.getState(),sample=current.sessions[0]!;const unrelated=Array.from({length:128},(_,index)=>({...sample,id:`cost-unrelated-${index}`,control:sample.control.kind==='agent'?{...sample.control,agentSessionId:`cost-unrelated-${index}`,run:{runId:`cost-run-${index}`}}:{...sample.control,runId:`cost-run-${index}`,run:{runId:`cost-run-${index}`}},latestOutputBytes:index+1}));useAppStore.setState({sessions:[...current.sessions.filter(value=>!value.id.startsWith('cost-unrelated-')), ...unrelated]}) },
  restoreInputs: () => useAppStore.setState({sessions:useAppStore.getState().sessions.filter(value=>!value.id.startsWith('cost-unrelated-'))}),
  inputCounts: () => ({sessions:useAppStore.getState().sessions.length,unrelated:useAppStore.getState().sessions.filter(value=>value.id.startsWith('cost-unrelated-')).length,hosts:useAppStore.getState().config?.hosts.length,unrelatedRunIds:useAppStore.getState().sessions.filter(value=>value.id.startsWith('cost-unrelated-')).map(value=>value.control.run.runId)}),
  theme: async (appearance: 'light' | 'dark') => { const current = await api.config.get(); await api.config.save({ ...current, appearance: { ...current.appearance, appAppearance: appearance } }, current) }
}
