import { createRoot } from 'react-dom/client'
import type { SettingsNavigationRequest } from '../../../src/renderer/src/components/SettingsNavigation'
import type { NodeSettings } from '@agentmux/core/node-publishing'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { meshPeerCode } from '@agentmux/core/mesh-peer-code'
import { connectionLinkUrl } from '@agentmux/relay/offer'
import type { MeshNetworkInspection, MeshNetworkSettings } from '@agentmux/core/mesh-network'
import type { AppConfig } from '../../../src/shared/contracts'
import '../../../src/renderer/src/styles/index.css'
const ids = ['aa11cc22dd33ee44'.repeat(4), 'bb22dd33ee44ff55'.repeat(4), 'cc33ee44ff55aa66'.repeat(4)]
const peer = ids[0]!, target = 'original-mac-publisher-bf8dc3c23ab8'
const own = { peerId: peer, publicKey: 'public-key-fixture', epoch: 3 }
let settings: MeshNetworkSettings = { owner: { runtimeId: 'core-original-review', ownerInstanceId: 'instance-review' }, identity: own, revision: 'saved-8', operation: null,
 configuration: { role: 'gateway', networkId: 'work-machines', endpointAccess: { allowedClientKeys: [] }, members: [], peers: [], publishers: [], listen: { host: '127.0.0.1', port: 8444 }, advertisedIngress: [{ endpoint: 'cn1.example.com', useTls: true }] } }
const originalOffer = { v: 2 as const, serverId: target, daemonPublicKeyB64: 'Hx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8=', relay: { endpoint: 'original-edge.local:7443', useTls: true } }
let state = new URLSearchParams(location.search).get('scenario') ?? 'active'
if (['initial', 'gateway-join', 'runtime-identity'].includes(state)) settings = { ...settings, configuration: { ...settings.configuration, role: 'disabled', networkId: 'my-devices', listen: undefined, advertisedIngress: [] } }
api.ui.readLocalRuntimeRecovery = async () => state === 'runtime-identity' ? { state: 'needs-backup', code: 'IDENTITY_SOURCE_MISSING' }
  : state === 'runtime-identity-blocked' ? { state: 'blocked', code: 'IDENTITY_TARGET_UNCONFIRMED' } : { state: 'unchanged' }
api.ui.restoreLocalRuntimeIdentity = async () => { state = 'initial'; return { state: 'restored' } }
let confirmSeparate: (() => void) | undefined
api.ui.prepareMeshIdentity = async () => {
  await new Promise<void>(resolve => { confirmSeparate = resolve })
  state = 'gateway-join'
  settings = { ...settings, owner: { runtimeId: 'separate-review', ownerInstanceId: 'separate-process' } }
  return settings.owner
}
function observation(): MeshNetworkInspection {
 const record = (originPeerId: string, neighbors: number[], index: number) => ({ version: 1 as const, networkId: 'work-machines', originPeerId, epoch: 3, revision: 8, signature: 'fixture', publishers: index === 2 ? [{ serverId: target, generation: 'generation-original' }] : [], advertisedIngress: [], neighbors: neighbors.map(n => ({ peerId: ids[n]!, peerEpoch: 3, connectionId: `link-${Math.min(index,n)}-${Math.max(index,n)}`, rttMs: 23 })) })
 return { owner: settings.owner, identity: own, source: 'managed', desiredRevision: settings.revision, activeRevision: state === 'failure' ? 'saved-8' : settings.revision, apply: state === 'failure' ? { state: 'unavailable', issue: { code: 'EADDRINUSE', message: 'The new listener address is already in use. The previous listener remains active.' } } : { state: 'active' }, gateway: { state: 'listening', listener: { host: '127.0.0.1', port: 8444, protocol: 'http' } } as never,
 network: { protocol: 1, state: 'active', networkId: 'work-machines', identity: own, peers: state === 'gateway-join' ? [] : [{ peerId: ids[1]!, state: 'connected', connectionId: 'link-0-1', rttMs: 23 }], records: [record(peer,[1],0),record(ids[1]!,[0,2],1),record(ids[2]!,[1],2)], routes: [{ serverId: target, originPeerId: ids[2]!, publisherGeneration: 'generation-original', path: ids, hops: 2, rttMs: 46, advertisedIngress: [] }], circuits: [] },
 endpoint: state === 'endpoint' ? { state: 'available', offer: originalOffer } : { state: 'not-provided' }, observedAt: Date.now(), coverage: { configuredOrigins: 3, observedOrigins: 3, complete: true } }
}
api.mesh.call = (async (method: string, params: any) => {
 if (state === 'runtime-identity' || state === 'runtime-identity-blocked') throw Error('The original Runtime identity is unavailable.')
 if (state === 'unavailable') throw Object.assign(Error('This original Core has no durable Mesh settings owner.'), { code: 'MESH_OWNER_UNAVAILABLE' })
 if (state === 'settings-error' && method === 'settings.mesh.inspect') throw Error('The original settings reader is unavailable. The authenticated network is still observed.')
 if (method === 'mesh.inspect') { const result = observation(); if (params.target) result.owner = { runtimeId: params.target.expectedRuntimeId, ownerInstanceId: 'managed-gateway-instance' }; return settings.configuration.role === 'disabled' ? { ...result, apply: { state: 'disabled' }, gateway: { state: 'disabled' }, network: null, coverage: { configuredOrigins: 0, observedOrigins: 0, complete: true } } : result }
 if (method === 'settings.mesh.inspect') return params.target ? { ...settings, owner: { runtimeId: params.target.expectedRuntimeId, ownerInstanceId: 'managed-gateway-instance' } } : settings
 if (method === 'mesh.link') { const offer = { ...params.offer, relay: { endpoint: 'cn1.example.com', useTls: true } }; return { offer, url: connectionLinkUrl('https://cn1.example.com', offer), observation: { owner: settings.owner, identity: own, activeRevision: 'saved-8', observedAt: Date.now(), route: observation().network!.routes[0], ingress: offer.relay } } }
 if (method === 'settings.mesh.configure') {
  settings = { ...settings, revision: 'saved-9', configuration: params.configuration, operation: { operationId: params.operationId, expectedRevision: params.expectedRevision, revision: 'saved-9', status: 'confirmed', updatedAt: Date.now() } }
  return { settings, diskDurability: 'confirmed' }
 }
 throw Error('This visual fixture does not simulate access links. Real Core coverage is recorded separately.')
}) as typeof api.mesh.call
mountThemeRuntime(window, { appAppearance: 'dark' })
const savedHosts: AppConfig['hosts'] = [{ id: 'local', kind: 'local', label: 'This Mac' }, { id: 'studio', kind: 'ssh', label: state === 'workflow-gateway' ? 'Office gateway' : 'Studio', runtimeId: 'managed-gateway', hostname: 'studio.invalid', transport: 'tailcat', tailcat: { address: 'studio-private', keyFile: 'studio-key' } }]
const fixtureConfig = { version: 9, hosts: savedHosts, executors: {}, workspaces: [], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: {} } } as unknown as AppConfig
useAppStore.setState({ config: fixtureConfig, sessions: [], meshSettingsDrafts: {}, meshGatewayCode: '' })
function showHosts(localOnly: boolean) {
 const current = useAppStore.getState().config!
 useAppStore.setState({ config: { ...current, hosts: localOnly ? savedHosts.slice(0, 1) : savedHosts } })
}
const reviewCases: Record<string, SettingsNavigationRequest> = {
  providers: { section: 'agents', field: 'providers' },
  executor: { section: 'agents', field: 'executors' },
  host: { section: 'hosts', field: 'connection', hostId: 'studio' },
  incoming: { section: 'hosts', field: 'incoming', hostId: 'local' },
  mesh: { section: 'hosts', field: 'mesh-configuration' },
  node: { section: 'network-node' },
  remote: { section: 'remote-execution', field: 'prepare' }
}
const render = (request?: SettingsNavigationRequest) => createRoot(document.getElementById('root')!).render(
  <DesktopClientUiProvider><div className="mesh-review-shell">
    <SettingsPanel onClose={() => {}} initialSection={request?.section ?? 'hosts'} navigationRequest={request} />
    <footer className="mesh-review-footer">Visual review fixture · production Settings and theme · controlled observations</footer>
  </div></DesktopClientUiProvider>)
async function mountInputReview() {
  const config = await api.config.get()
  const hosts: AppConfig['hosts'] = [
    { id: 'local', kind: 'local', label: 'This Mac', tailcat: { enabled: true, keyFile: 'review-host-key', allowedClients: [] } },
    { id: 'studio', kind: 'ssh', label: 'Studio Mac', hostname: 'studio.invalid', runtimeId: 'managed-gateway',
      user: 'reviewer', port: 2222, transport: 'ssh' }
  ]
  const node = { runtimeId: 'fixture-node-runtime', ownerInstanceId: 'fixture-node-process', alias: 'studio-review' }
  const policy: NodeSettings = { node, policyRevision: 'fixture-policy', operation: null,
    policy: { alias: node.alias, shareResources: true, allowedPaths: ['/workspace/shared', '/workspace/review'],
      deniedPaths: ['/workspace/shared/private'], defaultPath: '/workspace/shared' } }
  api.nodePublishing.call = async method => (method === 'node.resources'
    ? { node, status: 'withheld' }
    : { node, policyRevision: policy.policyRevision, resourcesShared: true, roots: [], landing: null }) as never
  api.nodePublishing.owner = async () => structuredClone(policy) as never
  const unobserved = { state: 'unavailable', message: 'Service observations are outside this visual fixture.', readAt: Date.now() }
  api.hosts.inspect = async host => ({
    routeHostId: host.id, configuration: host, requestedAt: unobserved.readAt, completedAt: unobserved.readAt, owner: unobserved, nativeIdentity: unobserved, diagnostics: unobserved, resources: unobserved,
    tailcat: { state: 'listening', address: 'private-review-credential' }
  }) as never
  useAppStore.setState({ config: { ...config, hosts }, providerCatalog: await api.providers.list() })
  render(reviewCases[new URLSearchParams(location.search).get('case') ?? ''])
}
const workflowCode = meshPeerCode({ identity: { peerId: ids[1]!, publicKey: 'fixture-public-peer', epoch: 1 }, configuration: { ...settings.configuration, networkId: 'work-machines', advertisedIngress: [{ endpoint: 'gateway.example', useTls: true }] } })
const workflowDeviceCode = meshPeerCode({ identity: { peerId: ids[2]!, publicKey: 'fixture-device-public-peer', epoch: 1 }, configuration: settings.configuration }, false)
if (state === 'settings-inputs' || state === 'cluster-settings') void mountInputReview()
else if (state === 'remote-landing') render({ section: 'remote-execution', field: 'prepare' })
else if (state === 'gateway-join') void useAppStore.getState().initialize().then(() => {
  useAppStore.setState({ config: fixtureConfig, meshSettingsDrafts: {}, meshGatewayCode: '' })
  render()
})
else render()
Object.assign(window, { meshFixture: { originalOffer, workflowCode, workflowDeviceCode, confirmSeparate: () => confirmSeparate?.(), seedGatewayCode: () => useAppStore.setState({ meshGatewayCode: workflowCode ?? '' }), confirmGateway: () => { state = 'gateway-connected' }, endpoint: () => { state = 'endpoint' }, localOnly: () => showHosts(true), allHosts: () => showHosts(false), theme: (mode: 'dark' | 'light') => updateThemeSelection({ appAppearance: mode }), failure: () => { state = 'failure'; settings = { ...settings, revision: 'saved-9' } } } })
