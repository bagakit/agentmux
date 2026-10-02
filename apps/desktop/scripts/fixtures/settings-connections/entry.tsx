import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { HostConfig } from '../../../src/shared/contracts'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import type { SettingsPageId } from '../../../src/renderer/src/components/settings/settings-modules'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { applyAppAppearance } from '../../../src/renderer/src/lib/app-appearance'
import { connectionsConfig, deviceInvitation, deviceList } from './data'
import '../../../src/renderer/src/styles/index.css'

const before = await api.config.get(), seeded = connectionsConfig(before)
const realSave = api.config.save.bind(api.config)
const calls: { kind: string; input?: unknown }[] = []
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
api.deviceManagement.invite = async input => { calls.push({ kind: 'device.invite-intent', input }); return structuredClone(deviceInvitation) }
api.deviceManagement.approve = async input => { calls.push({ kind: 'device.approve-intent', input }); throw new Error('Controlled preview does not grant OS authorization') }
api.deviceManagement.reject = async input => { calls.push({ kind: 'device.reject-intent', input }); throw new Error('Controlled preview does not reject OS authorization') }
api.deviceManagement.revoke = async input => { calls.push({ kind: 'device.revoke-intent', input }); throw new Error('Controlled preview does not revoke OS authorization') }
const config = await realSave(seeded, before)
useAppStore.setState({ config, providerCatalog: await api.providers.list(), activeWorkspaceId: 'project-a',
  sessions: [], sessionSnapshots: {}, hostChecks: {}, executorDetections: {} })
api.config.onChange(next => useAppStore.setState({ config: next }))
let disposeAppearance = applyAppAppearance('dark')
const probe = { ready: false, calls, errors: [] as string[], closeCount: 0,
  select: (_section: SettingsPageId) => {}, reopen: (_section: SettingsPageId) => {}, theme: (_theme: 'light' | 'dark') => {},
  current: () => api.config.get(),
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
    disposeAppearance(); disposeAppearance = applyAppAppearance(theme)
    useAppStore.setState(state => ({ config: { ...state.config!, appearance: { ...state.config!.appearance, appAppearance: theme } } }))
  }
  return <DesktopClientUiProvider>{opened ? <SettingsPanel key={epoch} initialSection={section} navigationRequest={request}
    onClose={() => { probe.closeCount++; setOpened(false) }} /> : null}</DesktopClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
probe.ready = true
