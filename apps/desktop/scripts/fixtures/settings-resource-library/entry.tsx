import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AppConfig, HostConfig } from '../../../src/shared/contracts'
import type { SettingsNavigationRequest } from '../../../src/renderer/src/components/SettingsNavigation'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { applyAppAppearance } from '../../../src/renderer/src/lib/app-appearance'
import '../../../src/renderer/src/styles/index.css'

type Section = 'agents' | 'hosts'
const before = await api.config.get(), catalog = await api.providers.list(), template = Object.values(before.executors)[0]!
const seeded: AppConfig = { ...before,
  executors: Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`executor-${String(index + 1).padStart(3, '0')}`, {
    ...template, label: index === 127 ? 'Production code review · long recognizable executor name' : `Executor ${String(index + 1).padStart(3, '0')}`,
    args: ['--model', 'literal model name'], env: { LITERAL: '$HOME remains literal' }
  }])),
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }, ...Array.from({ length: 23 }, (_, index) => ({
    id: `host-${String(index + 1).padStart(2, '0')}`, kind: 'ssh' as const, label: `Remote development ${String(index + 1).padStart(2, '0')}`,
    hostname: `controlled-${index + 1}.invalid`, user: 'developer', port: 2222, identityFile: '~/.ssh/controlled key',
    remoteCommand: (_hygiene_fixturePath("opt/agentmux") + " --literal"), remoteSocketPath: _hygiene_fixturePath("srv/literal.sock"), runtimeId: 'controlled-bound-runtime'
  }))],
  workspaces: [{ id: 'project-a', name: 'Application', kind: 'folder', hostId: 'host-01', path: _hygiene_fixturePath("controlled/application") },
    { id: 'project-b', name: 'Library', kind: 'folder', hostId: 'host-01', path: _hygiene_fixturePath("controlled/library") }]
}
const calls: { kind: string; input?: unknown }[] = []
const realSave = api.config.save.bind(api.config), realDetect = api.executors.detect.bind(api.executors)
api.config.save = async (next, expected) => {
  calls.push({ kind: 'preview-config-save', input: { executors: Object.keys(next.executors).length, hosts: next.hosts.length } })
  return realSave(next, expected)
}
api.executors.detect = async (executorId, hostId) => { calls.push({ kind: 'preview-detect', input: { executorId, hostId } }); return realDetect(executorId, hostId) }
const diagnostic = 'The controlled remote service did not confirm its bound Runtime identity. Original Sessions are retained. Verify the existing AgentMux service and this exact connection; no service was installed or restarted.\n' + 'Original diagnostic '.repeat(12)
api.hosts.check = async (host: HostConfig) => {
  calls.push({ kind: 'controlled-host-check', input: structuredClone(host) })
  return { input: structuredClone(host), outcome: 'unsupported', detail: diagnostic }
}
const config = await realSave(seeded, before)
useAppStore.setState({ config, providerCatalog: catalog, activeWorkspaceId: 'project-a', sessions: [], sessionSnapshots: {}, hostChecks: {}, executorDetections: {} })
api.config.onChange(next => useAppStore.setState({ config: next }))
let disposeAppearance = applyAppAppearance('dark')
const probe = { ready: false, calls, errors: [] as string[], closeCount: 0,
  select: (_section: Section) => {}, theme: (_theme: 'light' | 'dark') => {}, reopen: (_section: Section) => {},
  navigate: (_request: SettingsNavigationRequest) => {}, current: () => api.config.get(),
  reset: async () => { const current = await api.config.get(); await realSave(seeded, current); useAppStore.setState({ hostChecks: {}, executorDetections: {} }) }
}
Object.assign(window, { resourceLibraryProof: probe })
window.addEventListener('error', event => probe.errors.push(event.message))
window.addEventListener('unhandledrejection', event => probe.errors.push(String(event.reason)))
function Fixture() {
  const [opened, setOpened] = useState(true), [section, setSection] = useState<Section>('agents')
  const [navigationRequest, setRequest] = useState<SettingsNavigationRequest>({ section: 'agents' })
  const [epoch, setEpoch] = useState(0)
  probe.select = id => { setSection(id); setRequest({ section: id }) }
  probe.navigate = request => { setSection(request.section as Section); setRequest(request) }
  probe.reopen = id => { setSection(id); setRequest({ section: id }); setEpoch(current => current + 1); setOpened(true) }
  probe.theme = theme => {
    disposeAppearance(); disposeAppearance = applyAppAppearance(theme)
    useAppStore.setState(state => ({ config: { ...state.config!, appearance: { ...state.config!.appearance, appAppearance: theme } } }))
  }
  return <DesktopClientUiProvider>{opened ? <SettingsPanel key={epoch} initialSection={section} navigationRequest={navigationRequest}
    onClose={() => { probe.closeCount++; setOpened(false) }} /> : null}</DesktopClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
probe.ready = true
