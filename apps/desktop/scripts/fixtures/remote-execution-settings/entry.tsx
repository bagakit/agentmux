import { useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout } from '@agentmux/layout'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import type { AgentExecutionInspection } from '@agentmux/core'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { SettingsNavigation, type SettingsNavigationRequest } from '../../../src/renderer/src/components/SettingsNavigation'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import type { SettingsPageId } from '../../../src/renderer/src/components/settings/settings-modules'
import '../../../src/renderer/src/styles/index.css'

// Only external API facts are controlled. Production Settings, Store, navigation,
// Launcher, Workbench and CSS are consumed unchanged. No Main or SSH claim.
mountThemeRuntime(window, { appAppearance: 'dark' })
await useAppStore.getState().initialize()
const initial = useAppStore.getState()
if (!initial.config) throw new Error('Preview configuration is absent')
const agents = initial.sessions.filter(session => session.kind === 'agent')
if (agents.length < 2) throw new Error('Two typed original preview Agent Sessions are required')
const local = { id: 'local', kind: 'local' as const, label: 'Studio' }
const remote = { id: 'execution-host', kind: 'ssh' as const, label: 'Studio', hostname: 'execution.example.invalid', user: 'research' }
const project = { id: 'local-project', hostId: local.id, name: 'Interface research', path: '/workspace/interface-research', kind: 'folder' as const }
const remoteProject = { id: 'remote-project', hostId: remote.id, name: 'Runtime laboratory', path: '/srv/projects/runtime-laboratory/experiments/retained-conversation-and-original-resource-context', kind: 'folder' as const }
const sessions = agents.slice(0, 2).map((session, index) => ({ ...session,
  hostId: index === 0 ? remote.id : local.id,
  workspacePath: index === 0 ? remoteProject.path : project.path,
  control: { ...session.control, hostId: index === 0 ? remote.id : local.id },
  toolExecution: { bindingId: `preview-binding-${index + 1}`, resourceHostId: index === 0 ? local.id : remote.id,
    workspacePath: index === 0 ? project.path : remoteProject.path }
}))
const config = { ...initial.config, hosts: [local, remote], workspaces: [project, remoteProject] }
const originalAttach = api.sessions.attach, originalSnapshot = api.sessions.snapshot
api.sessions.snapshot = async () => ({ ...await originalSnapshot(), sessions })
api.sessions.attach = async (...args) => {
  const result = await originalAttach(...args)
  const session = sessions.find(item => item.control.agentSessionId === (args[0].kind === 'agent' ? args[0].agentSessionId : undefined))
  return session ? { ...result, session } : result
}
const tabs = Object.fromEntries(sessions.map((session, index) => {
  const tabId = `original-work-${index + 1}`, regionId = `original-region-${index + 1}`
  return [tabId, createWorkbenchTab(tabId, { kind: 'agent', phase: 'attached', regionId, workspaceId: project.id, sessionId: session.id })]
}))
useAppStore.setState({ config, sessions, tabs,
  layouts: { [project.id]: createWorkspaceLayout('original-work-group', Object.keys(tabs)),
    [remoteProject.id]: createWorkspaceLayout('remote-work-group', []) },
  activeWorkspaceId: project.id, mainSurface: 'workbench', loading: false,
  retainedSpatialFocus: null, workbenchNavigationInputPolicy: null, workbenchSpaceSelection: null,
  agentNames: { ...initial.agentNames, [sessions[0]!.id]: 'Interface research', [sessions[1]!.id]: 'Runtime analysis' },
  agentComposerDrafts: { 'original-region-1': 'Keep this original draft unsent.', 'original-region-2': 'Continue the original runtime investigation.' }
})
api.executors.discover = async hostId => ({ routeHostId: hostId, runtimeId: `preview-runtime-${hostId}`, executors: [
  { executorId: 'codex', providerId: 'codex', label: 'Codex', command: 'codex', source: 'registered',
    configRevision: `preview-revision-${hostId}`, availability: 'available' }
] })
const facts = new Map<string, AgentExecutionInspection>(sessions.map(session => [session.toolExecution.bindingId, {
  bindingId: session.toolExecution.bindingId, agentHostId: session.control.hostId, agentSessionId: session.control.agentSessionId,
  resourceHostId: session.toolExecution.resourceHostId, resourceWorkspacePath: session.toolExecution.workspacePath,
  state: 'connected', notices: [
    { providerId: 'codex', role: 'frontend', capability: 'hooks', state: 'unqualified', code: 'HOOKS_UNQUALIFIED',
      message: 'Native remote Hooks have not been qualified for this binding.', action: 'Continue in the original Agent workface.' },
    { providerId: 'codex', role: 'executor', capability: 'agent-control', state: 'unverified', code: 'CONTROL_UNVERIFIED',
      message: 'Tool-side Agent control has not yet been verified.', action: 'Continue using the original Agent workface.' }
  ]
}]))
const originalFacts = new Map(facts)
const readers = new Map<number, { bindingId: string; listener: (value: AgentExecutionInspection | null) => void; error: (error: string) => void }>()
let nextReader = 0
const readerEvents: { kind: string; id: number; bindingId: string }[] = []
api.sessions.executionBinding = async bindingId => structuredClone(facts.get(bindingId) ?? null)
api.sessions.observeExecutionBinding = (bindingId, listener, error) => {
  const id = ++nextReader
  readers.set(id, { bindingId, listener, error }); readerEvents.push({ kind: 'subscribe', id, bindingId })
  queueMicrotask(() => { if (readers.has(id)) listener(structuredClone(facts.get(bindingId) ?? null)) })
  return () => { readers.delete(id); readerEvents.push({ kind: 'unsubscribe', id, bindingId }) }
}
const forbiddenCalls: string[] = []
for (const name of ['launchAgent', 'submitPrompt', 'stop', 'resume'] as const) {
  Object.assign(api.sessions, { [name]: async () => { forbiddenCalls.push(name); throw new Error('This presentation must not start or change an Agent: ' + name) } })
}
const trustedEvents: { type: string; trusted: boolean; key?: string }[] = []
for (const type of ['click', 'keydown']) document.addEventListener(type, event => {
  trustedEvents.push({ type, trusted: event.isTrusted, ...(event instanceof KeyboardEvent ? { key: event.key } : {}) })
}, true)
let select: (page: SettingsPageId | null) => void
function Scene() {
  const [request, setRequest] = useState<SettingsNavigationRequest | null>({ section: 'remote-execution' })
  select = section => setRequest(section ? { section } : null)
  const workspaceId = useAppStore(state => state.activeWorkspaceId)
  const unavailable = () => { throw new Error('This scene does not supply that navigation destination') }
  return <SettingsNavigation.Provider value={{
    open: (section, executorId, field) => setRequest({ section, ...(executorId ? { executorId } : {}), ...(field ? { field } : {}) }),
    openHost: hostId => setRequest({ section: 'hosts', hostId }), openToolkit: unavailable, openChannel: unavailable,
    channelEntries: [], channelPresentation: () => null, openMoteLark: unavailable, chooseAgent: unavailable,
  }}>{request ? <SettingsPanel initialSection={request.section} navigationRequest={request} onClose={() => setRequest(null)} />
    : <div id="remote-settings-workbench"><WorkspaceWorkbench workspaceId={workspaceId ?? project.id} visible /></div>}
  </SettingsNavigation.Provider>
}
const root = createRoot(document.getElementById('root')!)
flushSync(() => root.render(<DesktopClientUiProvider><Scene /></DesktopClientUiProvider>))
Object.assign(window, { remoteExecutionVisual: {
  ready: true, sessions, project, remoteProject, trustedEvents,
  show(page: SettingsPageId = 'remote-execution') { flushSync(() => select(page)) },
  theme(value: 'light' | 'dark', themeId = 'graphite') { updateThemeSelection({ appAppearance: value, themeId }) },
  many(value: boolean) {
    const additional = Array.from({ length: 24 }, (_, index) => {
      const original = sessions[0]!, id = `controlled-extra-${index + 1}`
      return { ...original, id, label: `Retained work ${index + 1}`, control: { ...original.control, agentSessionId: id, run: { runId: `controlled-run-${index + 1}` } },
        toolExecution: { ...original.toolExecution, bindingId: `controlled-binding-${index + 1}` } }
    })
    flushSync(() => useAppStore.setState({ sessions: value ? [...sessions, ...additional] : sessions }))
  },
  missing(value: boolean) {
    const id = sessions[0]!.toolExecution.bindingId
    if (value) facts.delete(id)
    else facts.set(id, structuredClone(originalFacts.get(id)!))
    for (const reader of readers.values()) if (reader.bindingId === id) reader.listener(structuredClone(facts.get(id) ?? null))
  },
  empty(value: boolean) { flushSync(() => useAppStore.setState({ sessions: value ? [] : sessions })) },
  longLabels() {
    flushSync(() => useAppStore.setState(state => ({
      config: { ...state.config!, hosts: state.config!.hosts.map(host => ({ ...host, label: 'Studio · distributed systems research workstation' })) },
      agentNames: { ...state.agentNames, [sessions[1]!.id]: 'Runtime analysis · retained conversations and original resource context' }
    })))
  },
  unknown() {
    for (const reader of readers.values()) reader.error('The original observation route is unavailable. The Agent and its work remain retained.')
  },
  facts() {
    const state = useAppStore.getState()
    return { tabs: state.tabs, layouts: state.layouts, activeWorkspaceId: state.activeWorkspaceId,
      sessions: state.sessions.filter(session => session.kind === 'agent').map(session => ({ id: session.id, hostId: session.hostId, control: session.control, status: session.status, toolExecution: session.toolExecution })),
      drafts: state.agentComposerDrafts, readers: [...readers.values()].map(reader => reader.bindingId), readerEvents, forbiddenCalls }
  }
} })
