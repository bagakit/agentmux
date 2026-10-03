import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { api } from '../../../src/renderer/src/lib/api'
import { applyAppAppearance } from '../../../src/renderer/src/lib/app-appearance'
import { useAppStore } from '../../../src/renderer/src/store'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { GlobalSystemNotices } from '../../../src/renderer/src/components/GlobalSystemNotices'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { SettingsNavigation, type SettingsNavigationRequest } from '../../../src/renderer/src/components/SettingsNavigation'
import '../../../src/renderer/src/styles/index.css'

const config = await api.config.get()
config.hosts = [{ id: 'local', kind: 'local', label: 'This Mac' },
  { id: 'build', kind: 'ssh', label: 'Build server', hostname: 'build.example.invalid', user: 'developer',
    remoteCommand: _hygiene_fixturePath("opt/agentmux/bin/agentmux-public"), remoteSocketPath: _hygiene_fixturePath("srv/agentmux/runtime/control.sock"), runtimeId: 'original-runtime' },
  { id: 'analysis', kind: 'ssh', label: 'Analysis server', hostname: 'analysis.example.invalid' }]
config.workspaces = []
applyAppAppearance('dark')
useAppStore.setState({ config, loading: false, sessions: [], sessionSnapshots: {}, hostChecks: {},
  runtimeOwnershipWarnings: [], environmentWarning: undefined, displacedAgentSessionIds: [],
  runtimeEndpointWarnings: [{ hostId: 'build', step: 'Connecting to Runtime', availability: 'unverified',
    code: 'REMOTE_CORE_UPGRADE_REQUIRED', message: 'The remote Core uses an older endpoint interface without a confirmed connection receipt.',
    recovery: 'Update this exact service while retaining its original Runtime and Sessions.' }] })
const calls: string[] = []
Object.assign(api.hosts, {
  upgradeCheck: async (input: unknown) => { calls.push('check'); return { input, eligible: false, reason: 'runtime-update-required',
    candidate: { digest: 'controlled-candidate', sourceCommit: 'controlled-source', protocolVersion: 22 },
    detail: 'This service uses Runtime protocol 21. The update needs protocol 22. A safe Runtime upgrade is not available for this deployment; existing Agents were kept.' } },
  upgrade: async () => { throw new Error('The controlled preview never upgrades a service') },
  upgradeInspect: async () => { throw new Error('No real maintenance operation exists in this preview') }
})
function Fixture() {
  const [request, setRequest] = useState<SettingsNavigationRequest | null>(null)
  const navigation = { open: (section: SettingsNavigationRequest['section']) => setRequest({ section }),
    openToolkit: (toolId: string) => setRequest({ section: 'toolkit', toolId }),
    openHost: (hostId: string) => { calls.push('open-host:' + hostId); setRequest({ section: 'hosts', hostId }) } }
  return <DesktopClientUiProvider><SettingsNavigation.Provider value={navigation}><div className="app-shell">
    {request ? <SettingsPanel initialSection={request.section} navigationRequest={request} onClose={() => setRequest(null)} /> :
      <main className="app-shell__workspace"><div className="focus-empty"><h2>AgentMux</h2><p>Remote connection observation</p></div></main>}
    <footer className="window-status-bar"><GlobalSystemNotices /></footer>
  </div></SettingsNavigation.Provider></DesktopClientUiProvider>
}
Object.assign(window, { remoteUpgradePreview: { ready: true, calls,
  boundary: 'Actual production notification, SettingsPanel and Host editor/CSS. Controlled endpoint and maintenance DTOs; no real SSH, Main, installation or Run qualification.' } })
createRoot(document.getElementById('root')!).render(<Fixture />)
