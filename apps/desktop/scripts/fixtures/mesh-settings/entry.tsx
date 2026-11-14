import { createRoot } from 'react-dom/client'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { connectionLinkUrl } from '@agentmux/relay/offer'
import type { MeshNetworkInspection, MeshNetworkSettings } from '@agentmux/core/mesh-network'
import '../../../src/renderer/src/styles/index.css'
const ids = ['aa11cc22dd33ee44'.repeat(4), 'bb22dd33ee44ff55'.repeat(4), 'cc33ee44ff55aa66'.repeat(4)]
const peer = ids[0]!, target = 'original-mac-publisher-bf8dc3c23ab8'
const own = { peerId: peer, publicKey: 'public-key-fixture', epoch: 3 }
let settings: MeshNetworkSettings = { owner: { runtimeId: 'core-original-review', ownerInstanceId: 'instance-review' }, identity: own, revision: 'saved-8', operation: null,
 configuration: { role: 'gateway', networkId: 'work-machines', endpointAccess: { allowedClientKeys: [] }, members: [], peers: [], publishers: [], listen: { host: '127.0.0.1', port: 8444 }, advertisedIngress: [{ endpoint: 'cn1.example.com', useTls: true }] } }
const originalOffer = { v: 2 as const, serverId: target, daemonPublicKeyB64: 'Hx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8=', relay: { endpoint: 'original-edge.local:7443', useTls: true } }
let state = 'active'
function observation(): MeshNetworkInspection {
 const record = (originPeerId: string, neighbors: number[], index: number) => ({ version: 1 as const, networkId: 'work-machines', originPeerId, epoch: 3, revision: 8, signature: 'fixture', publishers: index === 2 ? [{ serverId: target, generation: 'generation-original' }] : [], advertisedIngress: [], neighbors: neighbors.map(n => ({ peerId: ids[n]!, peerEpoch: 3, connectionId: `link-${Math.min(index,n)}-${Math.max(index,n)}`, rttMs: 23 })) })
 return { owner: settings.owner, identity: own, source: 'managed', desiredRevision: settings.revision, activeRevision: 'saved-8', apply: state === 'failure' ? { state: 'unavailable', issue: { code: 'EADDRINUSE', message: 'The new listener address is already in use. The previous listener remains active.' } } : { state: 'active' }, gateway: { state: 'listening', listener: { host: '127.0.0.1', port: 8444, protocol: 'http' } } as never,
 network: { protocol: 1, state: 'active', networkId: 'work-machines', identity: own, peers: [{ peerId: ids[1]!, state: 'connected', connectionId: 'link-0-1', rttMs: 23 }], records: [record(peer,[1],0),record(ids[1]!,[0,2],1),record(ids[2]!,[1],2)], routes: [{ serverId: target, originPeerId: ids[2]!, publisherGeneration: 'generation-original', path: ids, hops: 2, rttMs: 46, advertisedIngress: [] }], circuits: [] },
 endpoint: state === 'endpoint' ? { state: 'available', offer: originalOffer } : { state: 'not-provided' }, observedAt: Date.now(), coverage: { configuredOrigins: 3, observedOrigins: 3, complete: true } }
}
api.mesh.call = (async (method: string, params: any) => {
 if (method === 'mesh.inspect') return observation()
 if (method === 'settings.mesh.inspect') return settings
 if (method === 'mesh.link') { const offer = { ...params.offer, relay: { endpoint: 'cn1.example.com', useTls: true } }; return { offer, url: connectionLinkUrl('https://cn1.example.com', offer), observation: { owner: settings.owner, identity: own, activeRevision: 'saved-8', observedAt: Date.now(), route: observation().network!.routes[0], ingress: offer.relay } } }
 if (method === 'settings.mesh.configure') {
  settings = { ...settings, revision: 'saved-9', configuration: params.configuration, operation: { operationId: params.operationId, expectedRevision: params.expectedRevision, revision: 'saved-9', status: 'confirmed', updatedAt: Date.now() } }
  return { settings, diskDurability: 'confirmed' }
 }
 throw Error('This visual fixture does not simulate access links. Real Core coverage is recorded separately.')
}) as typeof api.mesh.call
mountThemeRuntime(window, { appAppearance: 'dark' })
useAppStore.setState({ config: { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }], executors: {}, workspaces: [], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: {} } } as never, sessions: [], meshSettingsDrafts: {} })
createRoot(document.getElementById('root')!).render(<DesktopClientUiProvider><div className="mesh-review-shell"><SettingsPanel onClose={() => {}} initialSection="hosts" /><footer className="mesh-review-footer">Visual review fixture · production Settings and theme · controlled network observations</footer></div></DesktopClientUiProvider>)
Object.assign(window, { meshFixture: { originalOffer, endpoint: () => { state = 'endpoint' }, theme: (mode: 'dark' | 'light') => updateThemeSelection({ appAppearance: mode }), failure: () => { state = 'failure'; settings = { ...settings, revision: 'saved-9' } } } })
