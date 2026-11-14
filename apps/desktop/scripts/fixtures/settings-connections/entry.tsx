import { fixturePath as _historyFixturePath } from "../../../../../test/fixture-values.mjs"
import { useState } from 'react'
import type { HostRuntimeObservation, HostNetworkObservation, RemoteCoreUpgradeCheck } from '@agentmux/core'
import type { ApplicationAccessConfiguration, ApplicationAccessOperation, ApplicationAccessPlan, ApplicationAccessProfile } from '@agentmux/core'
import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import type { SessionSnapshot } from '../../../src/shared/contracts'
import type { HostConfig, HostCreationTrustSnapshot } from '../../../src/shared/contracts'
import type { NodePublication, NodeSettings } from '@agentmux/core/node-publishing'
import type { DesktopHostRouteTarget } from '../../../src/shared/host-routes'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { SettingsNavigation } from '../../../src/renderer/src/components/SettingsNavigation'
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
useAppStore.setState({ selectSession: (id, group) => { calls.push({ kind: 'original-select-session', input: { id, group } }); return realSelectSession(id, group) } })
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
// Controlled public DTOs only; these are not observations of a real Host or Native process.
const runtimeCapture = { phase: 'healthy' as 'healthy' | 'partial' | 'opaque' | 'direct' | 'recovered', producerAt: Date.now() - 45_000 }
const networkCapture = { phase: 'healthy' as 'healthy' | 'partial' | 'opaque' | 'direct' }
api.hosts.network = async host => {
  const now = Date.now(), available = <T,>(value: T) => ({ state: 'available' as const, value, readAt: now })
  const missing = { state: 'unavailable' as const, code: 'CONTROLLED_NETWORK_UNCONFIRMED', message: 'The original owner response is temporarily unconfirmed. Existing connections and work remain available.', readAt: now }
  const owner = { runtimeId: host.kind === 'ssh' ? host.runtimeId ?? 'controlled-network-runtime' : 'controlled-local-runtime', ownerInstanceId: 'controlled-network-owner', processId: 42000, protocolVersion: 2 as const, ctxmux: null, availability: 'connected' as const }
  const interfaces = [
    { name: 'eth0', address: '192.0.2.24', family: 'IPv4' as const, cidr: '192.0.2.24/24', internal: false, scopeid: null },
    { name: 'eth0', address: '2001:db8:1234:5678:abcd:ef01:2345:6789', family: 'IPv6' as const, cidr: '2001:db8:1234:5678:abcd:ef01:2345:6789/64', internal: false, scopeid: 0 },
    { name: 'lo', address: '127.0.0.1', family: 'IPv4' as const, cidr: '127.0.0.1/8', internal: true, scopeid: null }
  ]
  calls.push({ kind: 'controlled-network-read', input: { host: structuredClone(host), phase: networkCapture.phase } })
  return { routeHostId: host.id, configuration: structuredClone(host), requestedAt: now - 34, completedAt: now,
    observer: available({ processId: 41000, observedAt: now, interfaces: [{ name: 'en0', address: '198.51.100.12', family: 'IPv4', cidr: '198.51.100.12/24', internal: false, scopeid: null }, { name: 'utun3', address: 'fe80::3', family: 'IPv6', cidr: 'fe80::3/64', internal: false, scopeid: 3 }] }),
    target: networkCapture.phase === 'partial' ? missing : available({ requestDurationMs: 34, sample: { owner, observedAt: now - 4, interfaces } }),
    ssh: host.kind === 'local' ? null : networkCapture.phase === 'partial' ? missing : available({ hostname: host.hostname, user: host.user ?? 'builder', port: host.port ?? 22,
      serverAliveInterval: 30, serverAliveCountMax: 3, tcpKeepAlive: 'yes', proxy: networkCapture.phase === 'opaque' ? 'command' : networkCapture.phase === 'direct' ? 'direct' : 'jump', jumps: networkCapture.phase === 'opaque' || networkCapture.phase === 'direct' ? [] : [{ host: 'entry.internal', user: 'ops', port: 2222 }, { host: '2001:db8::7', user: null, port: null }] }) } satisfies HostNetworkObservation
}
api.hosts.inspect = async (host: HostConfig) => {
  const now = Date.now(), recovered = runtimeCapture.phase === 'recovered'
  const available = <T,>(value: T) => ({ state: 'available' as const, value, readAt: now })
  const native = { hostId: 'controlled-native-host', ownership: 'owned' as const, buildIdentity: 'controlled-native-build',
    protocolVersion: 22, processId: 42001, instanceId: 'controlled-native-instance' }
  const owner = { runtimeId: host.kind === 'ssh' ? host.runtimeId ?? 'controlled-semantic-runtime' : 'controlled-local-runtime',
    ownerInstanceId: 'controlled-core-instance', protocolVersion: 2 as const, processId: 42000, ctxmux: native, availability: 'connected' as const }
  const diagnostics = { nodeVersion: 'v24.0.0', platform: 'linux', arch: 'x64', supported: true,
    ctxmux: { state: { configuredDirectory: _historyFixturePath("controlled/runtime"), servingDirectory: _historyFixturePath("controlled/runtime") },
      serving: { buildIdentity: native.buildIdentity, protocolVersion: native.protocolVersion, instanceId: native.instanceId, sourceCommit: null },
      bundled: { version: 'controlled-bundle', sourceCommit: 'f'.repeat(40), artifactPlatform: 'linux-x64' }, ready: true,
      capabilities: { transport: 'local-unix' as const, orderedOutputBytes: true as const, boundedReplay: true as const,
        recoverableInput: true as const, resize: true as const, interrupt: true as const, completeStop: true as const } } }
  const resources = { observedAt: runtimeCapture.producerAt + (recovered ? 1000 : 0), runCount: recovered ? 7 : 6,
    runningRuns: recovered ? 5 : 4, terminatedRuns: 2, terminatedUnattachedRuns: 1,
    attachments: recovered ? 4 : 3, retainedOutputBytes: (recovered ? 14 : 12) * 1024 * 1024 }
  calls.push({ kind: 'controlled-runtime-inspect', input: { host: structuredClone(host), phase: runtimeCapture.phase, producerAt: resources.observedAt } })
  return { routeHostId: host.id, configuration: structuredClone(host), requestedAt: now, completedAt: now,
    owner: available(owner), nativeIdentity: available(native), diagnostics: available(diagnostics),
    resources: runtimeCapture.phase === 'partial' ? { state: 'unavailable', readAt: now, code: 'CONTROLLED_RESOURCE_OBSERVATION_UNAVAILABLE',
      message: 'Resource observation is temporarily unavailable. Existing Agent work remains available.' } : available(resources) } satisfies HostRuntimeObservation
}
// Explicit controlled owner facts exercise the real access and maintenance consumers.
api.hosts.creationTrust = async host => {
  calls.push({ kind: 'controlled-source-trust-read', input: structuredClone(host) })
  return { source: { runtimeId: 'controlled-source-runtime', publicKey: 'controlled-source-key', fingerprint: 'a'.repeat(64) },
    target: { routeHostId: host.id, authority: { runtimeId: host.runtimeId ?? 'controlled-target-runtime', publicKey: 'controlled-target-key', fingerprint: 'b'.repeat(64) }, sources: [] } } satisfies HostCreationTrustSnapshot
}
api.hosts.trustCreationSource = async host => {
  calls.push({ kind: 'controlled-source-trust-approval', input: structuredClone(host) })
  throw new Error('Controlled approval response lost. Review the original target before continuing.')
}
api.hosts.upgradeCheck = async host => {
  calls.push({ kind: 'controlled-upgrade-check', input: structuredClone(host) })
  const expected = { targetDigest: 'c'.repeat(64), runtimeId: host.kind === 'ssh' ? host.runtimeId ?? 'controlled-target-runtime' : 'controlled-local-runtime',
    ownerInstanceId: 'controlled-core-instance', processId: 42000, startTicks: '123', candidateDigest: 'd'.repeat(64),
    nativeInstanceId: 'controlled-native-instance', nativeProcessId: 42001, nativeStartTicks: '456' }
  return { input: structuredClone(host), current: { state: 'unavailable', observedAt: Date.now(), code: 'CONTROLLED_CURRENT_UNCONFIRMED', detail: 'Controlled current deployment observation is unavailable.' }, eligible: false, reason: 'unverified', detail: 'An original operation is awaiting verification.',
    candidate: { digest: expected.candidateDigest, sourceCommit: 'e'.repeat(40), protocolVersion: 22 },
    latestOperation: { input: structuredClone(host), operationId: 'controlled-original-upgrade', expected, status: 'unknown', stage: 'verifying',
      detail: 'Original operation result is unconfirmed.', updatedAt: Date.now() - 90_000 } } satisfies RemoteCoreUpgradeCheck
}
api.executors.discover = async hostId => {
  calls.push({ kind: 'controlled-executor-discovery', input: { hostId } })
  return { routeHostId: hostId, runtimeId: 'controlled-executor-runtime', executors: [
    { executorId: 'shared', label: 'Remote Agent', providerId: 'claude', command: _historyFixturePath("remote/claude"), executable: _historyFixturePath("remote/claude"), configRevision: 'controlled-shared-revision', source: 'registered', availability: 'available' },
    { executorId: 'remote-only', label: 'Remote exclusive Agent', providerId: 'codex', command: _historyFixturePath("remote/exclusive"), executable: _historyFixturePath("remote/exclusive"), configRevision: 'controlled-exclusive-revision', source: 'registered', availability: 'available' }
  ] }
}
// Controlled public route DTOs let the real route editor render its saved-connection picker.
// No route write, SSH connection, device trust or physical network observation is performed.
api.hostRoutes.call = (async (target: DesktopHostRouteTarget, method: string) => {
  calls.push({ kind: 'controlled-host-route', input: { target: structuredClone(target), method } })
  const identity = { runtimeId: target.expectedRuntimeId ?? `${target.hostId}-controlled-runtime`, publicKey: 'controlled-route-key', fingerprint: 'f'.repeat(64) }
  if (method === 'route.identity') return identity
  if (method === 'route.inspect') return { identity, revision: 'controlled-route-revision', operation: null, routes: [], grants: [] }
  if (method === 'route.edges') return { identity, actor: { source: identity, kind: 'user', id: 'controlled-preview-user' },
    edges: [{ edgeId: 'D', label: 'Build node', kind: 'ssh', runtimeId: 'controlled-build-runtime' }], observedAt: Date.now() }
  throw new Error('Controlled route preview only reads identity, policy and saved connections. No route write was sent.')
}) as typeof api.hostRoutes.call
// Controlled Node observations preserve exact Host and Runtime targets without claiming a real Core.
let nodePhase: 'healthy' | 'identity-error' | 'owner-error' = 'healthy'
api.nodePublishing.call = (async (method: string, input: { hostId: string; expectedRuntimeId?: string }) => {
  calls.push({ kind: 'controlled-node-publication-read', input: { method, ...structuredClone(input) } })
  if (method !== 'node.inspect') throw new Error('Controlled Node preview only inspects publication metadata')
  if (nodePhase === 'identity-error') throw new Error('Controlled Node identity is unconfirmed. The original saved Host and drafts are retained.')
  const runtimeId = input.expectedRuntimeId ?? 'controlled-bound-runtime'
  return { node: { runtimeId, ownerInstanceId: 'controlled-node-owner', alias: `${input.hostId}-node` }, policyRevision: 'controlled-revision', resourcesShared: false, roots: [], landing: null } satisfies NodePublication
}) as typeof api.nodePublishing.call
api.nodePublishing.owner = (async (target: { hostId: string; expectedRuntimeId: string }, method: string) => {
  calls.push({ kind: method === 'settings.node.configure' ? 'controlled-node-configure' : 'controlled-node-owner-read', input: { target: structuredClone(target), method } })
  if (method === 'settings.node.configure') throw new Error('Controlled Node preview does not write publication policy')
  if (method !== 'settings.node.inspect') throw new Error('Controlled Node preview only reads policy')
  if (nodePhase === 'owner-error') throw new Error('Controlled Node owner read failed. Original publication drafts are retained.')
  return { node: { runtimeId: target.expectedRuntimeId, ownerInstanceId: 'controlled-node-owner', alias: `${target.hostId}-node` }, policyRevision: 'controlled-revision', operation: null,
    policy: { alias: `${target.hostId}-node`, shareResources: false, allowedPaths: [], deniedPaths: [], defaultPath: null } } satisfies NodeSettings
}) as typeof api.nodePublishing.owner
// Controlled metadata for real application UI. Domain transfer/verification is proved separately through actual connectors.
const applications = { configurations: [] as ApplicationAccessConfiguration[], operations: [] as ApplicationAccessOperation[], plans: [] as ApplicationAccessPlan[] }
api.applications.call = (async (method: string, input: Record<string, unknown>) => {
  calls.push({ kind: 'controlled-application-method', input: { method, ...structuredClone(input) } })
  if (method === 'settings.applications.ls') return {
    configurations: applications.configurations.filter(item => !input.hostId || item.profile.source.hostId === input.hostId || item.profile.target.hostId === input.hostId),
    operations: applications.operations.filter(item => !input.hostId || item.source.hostId === input.hostId || item.target.hostId === input.hostId)
  }
  if (method === 'settings.applications.configure') {
    const next: ApplicationAccessConfiguration = { profileId: input.profileId as string, revision: 'controlled-rule-' + calls.length, profile: structuredClone(input.profile as ApplicationAccessProfile) }
    applications.configurations = [...applications.configurations.filter(item => item.profileId !== next.profileId), next]
    return next
  }
  if (method === 'settings.applications.delete') {
    applications.configurations = applications.configurations.filter(item => item.profileId !== input.profileId)
    return { profileId: input.profileId, deleted: true }
  }
  if (method === 'settings.applications.plan') {
    const configuration = applications.configurations.find(item => item.profileId === input.profileId)!, p = configuration.profile
    const observation = (source: boolean) => {
      const endpoint = source ? p.source : p.target
      return { hostId: endpoint.hostId, runtimeId: endpoint.runtimeId, osAccount: endpoint.osAccount, applicationId: p.applicationId,
        status: source ? 'ready' as const : 'login-required' as const, accountId: source ? p.accountId : null,
        scopes: source ? p.scopes : [], revision: 'controlled-app-revision', transferable: true }
    }
    const plan: ApplicationAccessPlan = { planId: 'controlled-plan-' + calls.length, profileId: configuration.profileId,
      configurationRevision: configuration.revision, createdAt: new Date().toISOString(), source: observation(true), target: observation(false),
      disposition: 'transfer', accountId: p.accountId, scopes: p.scopes }
    applications.plans.push(plan); return plan
  }
  if (method === 'settings.applications.apply') {
    const plan = applications.plans.find(item => item.planId === input.planId)!, profile = applications.configurations.find(item => item.profileId === input.profileId)!.profile
    const operation: ApplicationAccessOperation = { operationId: input.operationId as string, profileId: input.profileId as string,
      planId: plan.planId, configurationRevision: plan.configurationRevision, applicationId: profile.applicationId,
      source: { hostId: profile.source.hostId, runtimeId: profile.source.runtimeId, osAccount: profile.source.osAccount },
      target: { hostId: profile.target.hostId, runtimeId: profile.target.runtimeId, osAccount: profile.target.osAccount }, accountId: plan.accountId, scopes: plan.scopes,
      status: 'unknown', stage: 'import-dispatched', createdAt: new Date(Date.now() - 60_000).toISOString(), updatedAt: new Date().toISOString(),
      cause: { code: 'CONTROLLED_APPLICATION_RECEIPT_UNKNOWN', message: 'The target import response was not confirmed. Check this original operation.' } }
    applications.operations = [operation]; return operation
  }
  if (method === 'settings.applications.operation') {
    const original = applications.operations.find(item => item.operationId === input.operationId)!
    const result: ApplicationAccessOperation = { ...original, status: 'succeeded', stage: 'complete', updatedAt: new Date().toISOString() }
    delete result.cause
    applications.operations = [result]; return result
  }
  throw new Error('Unknown controlled application method')
}) as typeof api.applications.call
let onlineDeviceScenario = false
api.deviceManagement.ls = async input => {
  calls.push({ kind: 'device.ls', input })
  const value = structuredClone(deviceList)
  if (!onlineDeviceScenario) return value
  const now = Date.now()
  return { ...value, mobileAccess: { state: 'connected' as const, message: 'Controlled online device observation.', origin: 'http://192.168.1.20:8443' },
    devices: value.devices.map(device => ({ ...device, online: true, keyFingerprint: 'sha256:' + 'a'.repeat(64),
      connection: { connectedAt: now - 60_000, observedAt: now, address: '2001:db8:1234:5678:abcd:ef01:2345:6789',
        userAgent: 'Controlled browser declaration with a deliberately long device and browser description; this is not a physical phone observation.' } })) }
}
api.deviceManagement.link = async input => { calls.push({ kind: 'device.link', input }); return structuredClone(deviceInvitation) }
api.deviceManagement.revoke = async input => { calls.push({ kind: 'device.revoke-intent', input }); throw new Error('Controlled preview does not revoke OS authorization') }
const config = await realSave(seeded, before)
useAppStore.setState({ config, providerCatalog: await api.providers.list(), activeWorkspaceId: 'project-a',
  sessions: [], sessionSnapshots: {}, hostChecks: {}, executorDetections: {} })
api.config.onChange(next => useAppStore.setState({ config: next }))
let disposeAppearance = mountThemeRuntime(window, { appAppearance: 'dark' })
const probe = { ready: false, calls, errors: [] as string[], closeCount: 0,
  select: (_section: SettingsPageId) => {}, reopen: (_section: SettingsPageId, _hostId?: string) => {}, theme: (_theme: 'light' | 'dark', _themeId: string = 'graphite') => {},
  current: () => api.config.get(),
  onlineDevices: (value: boolean) => { onlineDeviceScenario = value },
  runtimeScenario: (phase: typeof runtimeCapture.phase) => { runtimeCapture.phase = phase },
  networkScenario: (phase: typeof networkCapture.phase) => { networkCapture.phase = phase },
  nodeScenario: (phase: typeof nodePhase) => { nodePhase = phase },
  selection: () => useAppStore.getState().workbenchSpaceSelection,
  seedRemote: async () => {
    const current = await api.config.get()
    const hosts = seeded.hosts.slice(0, 7).map(host => {
      if (host.id !== 'host-02' || host.kind !== 'ssh') return host
      const { user: _user, port: _port, ...inherited } = host
      return inherited
    })
    const target = hosts.find(host => host.id === 'host-01')!
    applications.configurations = [{ profileId: 'controlled-build-access', revision: 'controlled-rule-original', profile: {
      label: 'Build service access', applicationId: 'build-cli', accountId: 'engineer@work.example', scopes: ['project:read', 'artifacts:write'],
      source: { hostId: 'local', runtimeId: 'controlled-local-runtime', osAccount: 'engineer', command: _historyFixturePath("usr/local/bin/application-connector"), args: ['--profile', 'work'] },
      target: { hostId: target.id, runtimeId: target.kind === 'ssh' ? target.runtimeId ?? 'controlled-semantic-runtime' : 'controlled-local-runtime', osAccount: 'builder', command: _historyFixturePath("opt/tools/application-connector"), args: [] }
    } }]
    applications.operations = []; applications.plans = []
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
  reset: async () => { onlineDeviceScenario = false; nodePhase = 'healthy'; const current = await api.config.get(); await realSave(seeded, current); useAppStore.setState({ hostChecks: {} }); calls.length = 0 }
}
Object.assign(window, { connectionsProof: probe })
window.addEventListener('error', event => probe.errors.push(event.message))
window.addEventListener('unhandledrejection', event => probe.errors.push(String(event.reason)))
function Fixture() {
  const [opened, setOpened] = useState(true), [section, setSection] = useState<SettingsPageId>('hosts')
  const [request, setRequest] = useState<{ section: SettingsPageId; hostId?: string }>({ section: 'hosts' })
  const [epoch, setEpoch] = useState(0)
  probe.select = id => { setSection(id); setRequest({ section: id }) }
  probe.reopen = (id, hostId) => { setSection(id); setRequest({ section: id, ...(hostId === undefined ? {} : { hostId }) }); setEpoch(value => value + 1); setOpened(true) }
  probe.theme = (theme, themeId = 'graphite') => {
    disposeAppearance(); disposeAppearance = mountThemeRuntime(window, { appAppearance: theme, themeId })
    useAppStore.setState(state => ({ config: { ...state.config!, appearance: { ...state.config!.appearance, appAppearance: theme } } }))
  }
  return <DesktopClientUiProvider><SettingsNavigation.Provider value={{
    open: id => { calls.push({ kind: 'settings-navigation-request', input: { section: id } }); probe.select(id); setOpened(true) },
    openToolkit: toolId => { calls.push({ kind: 'settings-toolkit-navigation-request', input: { toolId } }); probe.select('toolkit') },
    openHost: hostId => { calls.push({ kind: 'settings-host-navigation-request', input: { hostId } }); probe.select('hosts') },
    openChannel: origin => { calls.push({ kind: 'settings-channel-navigation-request', input: origin }) },
    openMoteLark: origin => { calls.push({ kind: 'settings-mote-navigation-request', input: origin }) },
    chooseAgent: () => { calls.push({ kind: 'settings-choose-agent-request' }) },
    channelEntries: [], channelPresentation: () => null
  }}>{opened ? <SettingsPanel key={epoch} initialSection={section} navigationRequest={request}
    onClose={() => { probe.closeCount++; setOpened(false) }} /> : null}</SettingsNavigation.Provider></DesktopClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
probe.ready = true
