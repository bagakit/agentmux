import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { api } from '../../../src/renderer/src/lib/api'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
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
mountThemeRuntime(window, { appAppearance: 'dark' })
useAppStore.setState({ config, loading: false, sessions: [], sessionSnapshots: {}, hostChecks: {},
  runtimeOwnershipWarnings: [], environmentWarning: undefined, displacedAgentSessionIds: [],
  runtimeEndpointWarnings: [{ hostId: 'build', step: 'Connecting to Runtime', availability: 'unverified',
    code: 'REMOTE_CORE_UPGRADE_REQUIRED', message: 'The remote Core uses an older endpoint interface without a confirmed connection receipt.',
    recovery: 'Update this exact service while retaining its original Runtime and Sessions.' }] })
const calls: string[] = []
const copied: string[] = []
let mode: 'refusal' | 'ready' | 'unknown' | 'replacement' | 'replacement-idle' = 'refusal'
const candidate = { digest: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), version: '0.1.0', ownerProtocolVersion: 2, requiredNativeProtocolVersion: 25 }
const current = { state: 'available' as const, observedAt: 1700000000000, version: '0.1.0', sourceCommit: 'd'.repeat(40), deploymentDigest: 'e'.repeat(64), ownerProtocolVersion: 1, runtimeId: 'original-runtime', ownerInstanceId: 'original-owner', processId: 100, native: { instanceId: 'native-owner', buildId: 'native-build', protocolVersion: 25 } }
// Three Agent Sessions and two terminals are running on the older Native.
const ending = [{ runId: 'run-1', agentSessionId: 'agent-1' }, { runId: 'run-2', agentSessionId: 'agent-2' }, { runId: 'run-3', agentSessionId: 'agent-3' },
  { runId: 'run-4', agentSessionId: null }, { runId: 'run-5', agentSessionId: null }]
let releaseUpgrade: ((value: unknown) => void) | undefined
const expected = { targetDigest: 'c'.repeat(64), runtimeId: 'original-runtime', ownerInstanceId: 'original-owner',
  processId: 100, startTicks: '123', candidateDigest: candidate.digest, nativeInstanceId: 'native-owner', nativeProcessId: 101, nativeStartTicks: '456' }
let releaseCheck: (() => void) | undefined
Object.assign(api.hosts, {
  upgradeCheck: async (input: unknown) => {
    calls.push('check'); await new Promise<void>(done => { releaseCheck = done })
    if (mode === 'replacement' || mode === 'replacement-idle') {
      const runs = mode === 'replacement' ? ending : []
      return { input, current: { ...current, native: { ...current.native, protocolVersion: 22 } }, eligible: true, reason: 'native-replacement', candidate,
        nativeReplacement: { ending: runs, stateBytes: 1163264 }, expected: { ...expected, nativeReplacement: { endingRunIds: runs.map(run => run.runId) } },
        detail: 'Native Runtime 使用协议 22，本 App 需要协议 25，无法在原进程中交接。' }
    }
    return mode === 'ready' ? { input, current, eligible: true, reason: 'ready', candidate, expected, detail: 'The original owner is qualified for a Core deployment.' } : mode === 'unknown' ?
      { input, current, eligible: false, reason: 'unverified', candidate, detail: 'The original operation needs reconciliation.', latestOperation: { input, expected,
        operationId: '6f801593-fbda-44a7-9130-43723b979b73', status: 'unknown', stage: 'verifying', updatedAt: 1,
        detail: 'The staged Core was observed, but reconnection to the exact original owner could not be confirmed. No replacement update was started.' } } :
      { input, current: { ...current, native: { ...current.native, protocolVersion: 26 } }, eligible: false, reason: 'runtime-update-required', candidate,
        detail: '远端 Runtime 为协议 26，本机候选为协议 25。当前没有经验证的无损 Runtime 升级入口，暂不能执行此升级；原 Agent 和运行进程已保留。' }
  },
  // A controlled receipt for the replacement scenes; no service is ever changed.
  upgrade: async (input: unknown, admitted: typeof expected, operationId: string) => {
    calls.push('upgrade'); await new Promise(done => { releaseUpgrade = done })
    return { input, operationId, expected: admitted, candidate, status: 'completed', stage: 'completed', updatedAt: 1700000005000, remoteCommand: _hygiene_fixturePath('opt/agentmux/state/core-releases/' + candidate.digest + '/launcher/amux'),
      detail: 'Core 与 Native Runtime 已升级；原 Runtime、Session 与历史保留，5 个运行中的进程已结束，可沿原 Session 恢复。', connectionAdoption: { state: 'connected', readAt: 1700000006000 },
      nativeReplacement: { stateCopy: _hygiene_fixturePath('opt/agentmux/state/core-releases/' + operationId + '.native-state'), endedRunIds: admitted.nativeReplacement?.endingRunIds ?? [], survivingProcessIds: [] } }
  },
  upgradeInspect: async () => { throw new Error('No real maintenance operation exists in this preview') }
})
Object.assign(api.ui, { writeClipboardText: async (text: string) => { calls.push('copy'); copied.push(text) } })
function Fixture() {
  const [request, setRequest] = useState<SettingsNavigationRequest | null>(null)
  const navigation = { open: (section: SettingsNavigationRequest['section']) => setRequest({ section }),
    openToolkit: (toolId: string) => setRequest({ section: 'toolkit', toolId }),
    openHost: (hostId: string) => { calls.push('open-host:' + hostId); setRequest({ section: 'hosts', hostId }) } }
  return <DesktopClientUiProvider><SettingsNavigation.Provider value={navigation}><div className="app-shell app-shell--project-rail-collapsed">
    <div className="app-shell__workspace" aria-hidden={Boolean(request)} inert={Boolean(request)}><main className="main-shell main-shell--merged">
      <div className="workbench-shell"><section className="workspace-main-surface"><div className="focus-empty"><h2>AgentMux</h2><p>Remote connection observation</p></div></section></div>
    </main></div>
    {request ? <SettingsPanel initialSection={request.section} navigationRequest={request} onClose={() => setRequest(null)} /> : null}
    <footer className="window-status-bar" style={{ position: 'fixed', left: 0, right: 0, bottom: 0 }}><GlobalSystemNotices /></footer>
  </div></SettingsNavigation.Provider></DesktopClientUiProvider>
}
Object.assign(window, { remoteUpgradePreview: { ready: true, calls, copied, setMode: (value: typeof mode) => { mode = value }, releaseCheck: () => { const release = releaseCheck; releaseCheck = undefined; release?.() },
  releaseUpgrade: () => { const release = releaseUpgrade; releaseUpgrade = undefined; release?.(undefined) },
  boundary: 'Actual production notification, SettingsPanel and Host editor/CSS. Controlled endpoint and maintenance DTOs; no real SSH, Main, installation or Run qualification.' } })
createRoot(document.getElementById('root')!).render(<Fixture />)
