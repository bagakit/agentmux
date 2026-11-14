import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { api } from '../../../src/renderer/src/lib/api'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import { useAppStore } from '../../../src/renderer/src/store'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import '../../../src/renderer/src/styles/index.css'
const config = await api.config.get()
const host = { id: 'build', kind: 'ssh' as const, label: 'Build server', hostname: 'build.example.invalid', user: 'developer' }
config.hosts = [{ id: 'local', kind: 'local', label: 'This Mac' }, host]
config.workspaces = []
mountThemeRuntime(window, { appAppearance: 'dark' })
useAppStore.setState({ config, loading: false, sessions: [], sessionSnapshots: {}, hostChecks: {}, runtimeOwnershipWarnings: [], environmentWarning: undefined, displacedAgentSessionIds: [], runtimeEndpointWarnings: [] })
let mode = 'ready', stage = 'staging-core', release: (() => void) | undefined
const calls: string[] = []
const check = { input: host, eligible: true, reason: 'ready', detail: 'No Core is installed here. Review the startup option before installing.',
  probe: { platform: 'linux', machine: 'x86_64', glibc: '2.36', home: '/home/developer', prefix: '/home/developer/.agentmux/server', user: 'developer', installed: false, socket: 'absent', availableBytes: 4 * 1024 ** 3, systemd: { user: true, linger: false, unitAvailable: true } },
  candidate: { digest: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), version: '0.1.0' }, node: { version: 'v24.22.1', sha256: 'c'.repeat(64) },
  keepRunning: [{ mode: 'start-script', available: true, startsAtBoot: false }, { mode: 'systemd', available: true, startsAtBoot: false }],
  expected: { targetDigest: 'd'.repeat(64), prefix: '/home/developer/.agentmux/server', candidateDigest: 'a'.repeat(64), nodeSha256: 'c'.repeat(64) } }
let original: { input: unknown; expected: unknown; operationId: string } | undefined
const installed = { remoteCommand: '/home/developer/.agentmux/server/bin/amux', remoteSocketPath: '/home/developer/.agentmux/server/runtime/control.sock',
  runtimeId: 'runtime-build-server', startScript: '/home/developer/.agentmux/server/start.sh', unit: null }
const receipt = () => ({ ...original, status: mode === 'unknown' ? 'unknown' : 'running', stage, detail: mode === 'unknown' ? 'The connection closed before the Core identity was confirmed. Inspect this original operation; it will not be repeated.' : 'Verifying and unpacking the bundled Core release.', updatedAt: 100 })
Object.assign(api.hosts, {
  upgradeCheck: async (input: unknown) => ({ input, current: { state: 'unavailable', observedAt: 1, code: 'UNAVAILABLE', detail: 'No Core endpoint has been confirmed.' },
    candidate: null, eligible: false, reason: 'unverified', detail: 'Check installation to set up a new machine.' }),
  installCheck: async () => { calls.push('check'); return structuredClone(check) },
  install: async (input: unknown, expected: unknown, operationId: string) => {
    calls.push('install'); original = { input, expected, operationId }
    if (mode === 'unknown') return receipt()
    await new Promise<void>(done => { release = done })
    const next = { ...host, remoteCommand: installed.remoteCommand, remoteSocketPath: installed.remoteSocketPath, runtimeId: installed.runtimeId }
    useAppStore.setState({ config: { ...config, hosts: [config.hosts[0]!, next] } })
    return { ...original, installed, status: 'completed', stage: 'completed', detail: 'Core installed. The saved connection was verified.',
      updatedAt: 200, connectionAdoption: { state: 'connected', readAt: 200, detail: 'Connection verified at this receipt time.' } }
  },
  installInspect: async () => receipt()
})
function Fixture() {
  const [revision, setRevision] = useState(0)
  Object.assign(window, { installPreview: { ready: true, revision, calls, setMode: (next: string) => { mode = next; useAppStore.setState({ config }); setRevision(value => value + 1); return revision + 1 },
    finish: () => release?.() } })
  return <DesktopClientUiProvider><div className="app-shell"><SettingsPanel key={revision} initialSection="hosts"
    navigationRequest={{ section: 'hosts', hostId: 'build' }} onClose={() => {}} /></div></DesktopClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
