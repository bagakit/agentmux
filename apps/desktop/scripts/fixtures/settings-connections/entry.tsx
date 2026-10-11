import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import type { SessionSnapshot } from '../../../src/shared/contracts'
import type { HostConfig } from '../../../src/shared/contracts'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import type { SettingsPageId } from '../../../src/renderer/src/components/settings/settings-modules'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import { connectionsConfig, deviceInvitation, deviceList } from './data'
import '../../../src/renderer/src/styles/index.css'

const before = await api.config.get(), seeded = connectionsConfig(before)
const realSave = api.config.save.bind(api.config)
const calls: { kind: string; input?: unknown }[] = []
const realSelectSession = useAppStore.getState().selectSession
useAppStore.setState({ selectSession: (id, group) => { calls.push({ kind: 'original-select-session', input: { id, group } }); realSelectSession(id, group) } })
api.config.save = async (next, expected) => {
  calls.push({ kind: 'preview-config-save', input: { hosts: next.hosts.length } })
  return realSave(next, expected)
}
api.hosts.check = async (host: HostConfig) => {
  calls.push({ kind: 'controlled-host-check', input: structuredClone(host) })
  return { input: structuredClone(host), outcome: 'unsupported',
    detail: 'Controlled service observation: the remote Runtime identity is unconfirmed. Original Sessions are retained. ' +
      'Verify this exact existing connection; no service was installed, stopped or restarted. Original diagnostic '.repeat(5) }
}
api.deviceManagement.ls = async input => { calls.push({ kind: 'device.ls', input }); return structuredClone(deviceList) }
api.deviceManagement.link = async input => { calls.push({ kind: 'device.link', input }); return structuredClone(deviceInvitation) }
api.deviceManagement.revoke = async input => { calls.push({ kind: 'device.revoke-intent', input }); throw new Error('Controlled preview does not revoke OS authorization') }
const config = await realSave(seeded, before)
useAppStore.setState({ config, providerCatalog: await api.providers.list(), activeWorkspaceId: 'project-a',
  sessions: [], sessionSnapshots: {}, hostChecks: {}, executorDetections: {} })
api.config.onChange(next => useAppStore.setState({ config: next }))
let disposeAppearance = mountThemeRuntime(window, { appAppearance: 'dark' })
const probe = { ready: false, calls, errors: [] as string[], closeCount: 0,
  select: (_section: SettingsPageId) => {}, reopen: (_section: SettingsPageId) => {}, theme: (_theme: 'light' | 'dark') => {},
  current: () => api.config.get(),
  selection: () => useAppStore.getState().workbenchSpaceSelection,
  seedRemote: async () => {
    const current = await api.config.get()
    const hosts = seeded.hosts.slice(0, 7)
    await realSave({ ...current, hosts, workspaces: seeded.workspaces }, current)
    const base = (await api.sessions.snapshot()).sessions.find(session => session.kind === 'agent')!
    if (base.kind !== 'agent') throw new Error('The original Preview Agent DTO is required')
    const agent: SessionSnapshot = { ...base, id: 'host-a-agent', hostId: 'host-01', workspacePath: seeded.workspaces[0]!.path,
      label: 'Build pipeline', control: { ...base.control, hostId: 'host-01', agentSessionId: 'host-a-agent' } }
    const shell: SessionSnapshot = { ...base, id: 'host-a-terminal', kind: 'terminal', providerId: null,
      hostId: 'host-01', workspacePath: agent.workspacePath, label: 'Project shell',
      status: { state: 'running', source: 'run-process', observedAt: base.updatedAt },
      control: { kind: 'terminal', hostId: 'host-01', runId: 'preview-shell-run', run: { runId: 'preview-shell-run' } } }
    const other: SessionSnapshot = { ...base, id: 'host-b-agent', hostId: 'host-02', workspacePath: agent.workspacePath,
      label: 'Release checks', control: { ...base.control, hostId: 'host-02', agentSessionId: 'host-b-agent' } }
    const sessions = [agent, shell, other]
    const tabs = sessions.map(session => createWorkbenchTab(`tab-${session.id}`, { kind: session.kind, phase: 'attached',
      regionId: `region-${session.id}`, workspaceId: 'project-a', sessionId: session.id }))
    useAppStore.setState({ sessions, tabs: Object.fromEntries(tabs.map(tab => [tab.id, tab])),
      layouts: { 'project-a': createWorkspaceLayout('original-group', tabs.map(tab => tab.id)) },
      activeWorkspaceId: 'project-a', workbenchSpaceSelection: null,
      agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
    calls.length = 0
  },
  seedFinalEditable: async () => {
    const current = await api.config.get()
    const hosts = current.hosts.filter(host => host.id === 'local' || host.id === 'host-02')
    calls.push({ kind: 'controlled-final-editable-seed', input: hosts.map(host => host.id) })
    await realSave({ ...current, hosts, workspaces: current.workspaces.filter(workspace => workspace.hostId === 'host-02') }, current)
  },
  reset: async () => { const current = await api.config.get(); await realSave(seeded, current); useAppStore.setState({ hostChecks: {} }); calls.length = 0 }
}
Object.assign(window, { connectionsProof: probe })
window.addEventListener('error', event => probe.errors.push(event.message))
window.addEventListener('unhandledrejection', event => probe.errors.push(String(event.reason)))
function Fixture() {
  const [opened, setOpened] = useState(true), [section, setSection] = useState<SettingsPageId>('hosts')
  const [request, setRequest] = useState({ section: 'hosts' as SettingsPageId })
  const [epoch, setEpoch] = useState(0)
  probe.select = id => { setSection(id); setRequest({ section: id }) }
  probe.reopen = id => { setSection(id); setRequest({ section: id }); setEpoch(value => value + 1); setOpened(true) }
  probe.theme = theme => {
    disposeAppearance(); disposeAppearance = mountThemeRuntime(window, { appAppearance: theme })
    useAppStore.setState(state => ({ config: { ...state.config!, appearance: { ...state.config!.appearance, appAppearance: theme } } }))
  }
  return <DesktopClientUiProvider>{opened ? <SettingsPanel key={epoch} initialSection={section} navigationRequest={request}
    onClose={() => { probe.closeCount++; setOpened(false) }} /> : null}</DesktopClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
probe.ready = true
