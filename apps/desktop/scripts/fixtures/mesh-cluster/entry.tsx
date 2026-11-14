import { createRoot } from 'react-dom/client'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { connectionLinkUrl } from '@agentmux/relay/offer'
import type { HostConfig } from '../../../src/shared/contracts'
import { applyConfigEdit } from '../../../src/shared/config-edit'
import type { MeshNetworkInspection, MeshNetworkSettings } from '@agentmux/core/mesh-network'
import '../../../src/renderer/src/styles/index.css'
const ids = ['aa11cc22dd33ee44'.repeat(4), 'bb22dd33ee44ff55'.repeat(4), 'cc33ee44ff55aa66'.repeat(4), 'dd44ff55aa66bb77'.repeat(4), 'ee55aa66bb77cc88'.repeat(4)]
const peer = ids[0]!, target = 'original-mac-publisher-bf8dc3c23ab8'
const own = { peerId: peer, publicKey: 'public-key-fixture', epoch: 3 }
let settings: MeshNetworkSettings = { owner: { runtimeId: 'core-original-review', ownerInstanceId: 'instance-review' }, identity: own, revision: 'saved-8', operation: null,
 configuration: { role: 'gateway', networkId: 'work-machines', endpointAccess: { allowedClientKeys: [] }, members: [], peers: [{ peerId: 'saved-gateway-original', endpoints: [{ endpoint: 'regional-gateway.internal:8444', useTls: true }] }], publishers: [], listen: { host: '127.0.0.1', port: 8444 }, advertisedIngress: [{ endpoint: 'cn1.example.com', useTls: true }] } }
const originalOffer = { v: 2 as const, serverId: target, daemonPublicKeyB64: 'Hx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8=', relay: { endpoint: 'original-edge.local:7443', useTls: true } }
let state = new URLSearchParams(location.search).get('scenario') ?? 'active'
if (state === 'initial') settings = { ...settings, configuration: { ...settings.configuration, role: 'disabled', networkId: 'my-devices', listen: undefined, advertisedIngress: [] } }
function observation(): MeshNetworkInspection {
 const record = (originPeerId: string, neighbors: number[], index: number) => ({ version: 1 as const, networkId: 'work-machines', originPeerId, epoch: 3, revision: 8, signature: 'fixture', publishers: index === 2 ? [{ serverId: target, generation: 'generation-original' }] : [], advertisedIngress: [{endpoint:['this-device.internal:8444','farm-gateway.internal:443','studio.internal:443','build-agent.internal:443','gateway-secondary.internal:443'][index]!,useTls:true}], neighbors: neighbors.map(n => ({ peerId: ids[n]!, peerEpoch: 3, connectionId: `link-${Math.min(index,n)}-${Math.max(index,n)}`, rttMs: 23 })) })
 return { owner: settings.owner, identity: own, source: 'managed', desiredRevision: settings.revision, activeRevision: 'saved-8', apply: state === 'failure' ? { state: 'unavailable', issue: { code: 'EADDRINUSE', message: 'The new listener address is already in use. The previous listener remains active.' } } : { state: 'active' }, gateway: { state: 'listening', listener: { host: '127.0.0.1', port: 8444, protocol: 'http' } } as never,
 network: { protocol: 1, state: 'active', networkId: 'work-machines', identity: own, peers: [{ peerId: ids[1]!, state: 'connected', connectionId: 'link-0-1', rttMs: 23 }], records: [record(peer,[1,3],0),record(ids[1]!,[0,2,4],1),record(ids[2]!,[1],2),record(ids[3]!,[0,4],3),record(ids[4]!,[1,3],4)], routes: [{ serverId: target, originPeerId: ids[2]!, publisherGeneration: 'generation-original', path: ids.slice(0,3), hops: 2, rttMs: 46, advertisedIngress: [] }], circuits: [{circuitId:'original-live-circuit',serverId:target,path:[ids[0]!,ids[3]!,ids[4]!,ids[1]!,ids[2]!]}] },
 endpoint: state === 'endpoint' ? { state: 'available', offer: originalOffer } : { state: 'not-provided' }, observedAt: Date.now(), coverage: { configuredOrigins: 5, observedOrigins: 5, complete: true } }
}
api.mesh.call = (async (method: string, params: any) => {
 if (state === 'unavailable') throw Object.assign(Error('This original Core has no durable Mesh settings owner.'), { code: 'MESH_OWNER_UNAVAILABLE' })
 if (state === 'settings-error' && method === 'settings.mesh.inspect') throw Error('The original settings reader is unavailable. The authenticated network is still observed.')
 if (method === 'mesh.inspect') { const result = observation(); return ['initial','empty'].includes(state) ? { ...result, apply: { state: 'disabled' }, gateway: { state: 'disabled' }, network: null, coverage: { configuredOrigins: 0, observedOrigins: 0, complete: true } } : result }
 if (method === 'settings.mesh.inspect') return settings
 if (method === 'mesh.link') { const offer = { ...params.offer, relay: { endpoint: 'cn1.example.com', useTls: true } }; return { offer, url: connectionLinkUrl('https://cn1.example.com', offer), observation: { owner: settings.owner, identity: own, activeRevision: 'saved-8', observedAt: Date.now(), route: observation().network!.routes[0], ingress: offer.relay } } }
 if (method === 'settings.mesh.configure') {
  settings = { ...settings, revision: 'saved-9', configuration: params.configuration, operation: { operationId: params.operationId, expectedRevision: params.expectedRevision, revision: 'saved-9', status: 'confirmed', updatedAt: Date.now() } }
  return { settings, diskDurability: 'confirmed' }
 }
 throw Error('This visual fixture does not simulate access links. Real Core coverage is recorded separately.')
}) as typeof api.mesh.call
const samples: Record<string, number> = {}
const resource = (id: string) => {
 const step = samples[id] = (samples[id] ?? 0) + 1, index = ['local','farm-cn1','studio','build','private','unavailable'].indexOf(id)
 const node = { runtimeId: id === 'local' ? 'runtime-this-mac' : 'runtime-'+id, ownerInstanceId: 'original-'+id, alias: id }
 if (id === 'private' || index < 0) return { node, policyRevision: 'private-policy', status: 'withheld' }
 if (id === 'unavailable') throw Error('This saved Host did not return resource observations. Its connection and original work are retained.')
 const total=1024**3*[32,64,16,128][index]!, used=[.39,.72,.48,.87][index]!
 return {node,policyRevision:'original-policy',status:'available',sample:{node,policyRevision:'original-policy',processId:2450+index,observedAt:Date.now(),system:{state:'available',value:{platform:index===0||index===2?'darwin':'linux',architecture:'arm64',uptimeSeconds:86400*(index+3)+3768}},cpu:{state:'available',value:{logicalCpus:8,userMs:step*(index+1)*100,niceMs:0,systemMs:step*50,idleMs:step*(950-(index+1)*100),irqMs:0,loadAverage:[1.7+index,1.2+index,.9+index]}},memory:{state:'available',value:{totalBytes:total,freeBytes:total*(1-used)}},filesystem:{state:'available',value:{root:null,totalBytes:1024**4,availableBytes:1024**4*(1-used/1.2)}},process:{state:'available',value:{cpuUserMicros:10000*step,cpuSystemMicros:1000*step,rssBytes:1024**2*(85+index*25),heapUsedBytes:1,heapTotalBytes:2,externalBytes:1,uptimeSeconds:10000}}}}
}
api.nodePublishing.call = (async (method: string, params: { hostId: string }) => {
 const id = params.hostId
 const node = { runtimeId: id === 'local' ? 'runtime-this-mac' : 'runtime-' + id, ownerInstanceId: 'original-' + id, alias: id }
 if (method === 'node.location') {
   const location = state === 'geography' && id === 'farm-cn1'
     ? { latitude: 49, longitude: -123, label: 'Vancouver region', source: 'public-egress', accuracyKm: 120 } : null
   return { node, location }
 }
 if (method === 'node.inspect') return { node, policyRevision: 'original-policy', resourcesShared: true, roots: [], landing: null }
 return resource(id)
}) as typeof api.nodePublishing.call
api.nodePublishing.owner=(async(target:any)=>{if(target.hostId==='private')throw Error('This device has published access only.');return resource(target.hostId)}) as typeof api.nodePublishing.owner
api.config.save = async (next, expected) => applyConfigEdit(useAppStore.getState().config!, expected, next)
mountThemeRuntime(window, { appAppearance: 'dark' })
useAppStore.setState({ config: { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' },{ id:'farm-cn1',kind:'ssh',label:state === 'geography' ? 'Vancouver build host' : 'Farm CN1',hostname:'farm-cn1.internal',runtimeId:'runtime-farm-cn1' },{id:'studio',kind:'ssh',label:'Studio Mac',hostname:'studio.internal',runtimeId:'runtime-studio'},{id:'build',kind:'ssh',label:'Build runner',hostname:'build.internal',runtimeId:'runtime-build'},{id:'private',kind:'ssh',label:'Private workspace',hostname:'private.internal',runtimeId:'runtime-private'},{id:'unavailable',kind:'ssh',label:'Remote workbench · secondary machine',hostname:'remote.internal',runtimeId:'runtime-unavailable'},...(state === 'initial' ? ([
 { id:'build-secondary',kind:'ssh',label:'Build secondary',hostname:'build-secondary.internal',runtimeId:'runtime-build-secondary' },
 { id:'studio-tailcat',kind:'ssh',label:'Studio backup connection',hostname:'studio-backup.internal',runtimeId:'runtime-studio-tailcat',transport:'ssh-tailcat' },
 { id:'compute-east',kind:'ssh',label:'Compute East',hostname:'compute-east.internal',runtimeId:'runtime-compute-east' },
] satisfies HostConfig[]) : [])].filter(host => state !== 'empty' || host.kind === 'local'), executors: {}, workspaces: [], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: {} } } as never, sessions: [], meshSettingsDrafts: {}, hostTransports: {
  studio: {state:'connected', transport:'ssh', fallback:false, observedAt:Date.now(), establishedAt:Date.now()-180000},
  'farm-cn1': {state:'disconnected', transport:'ssh', fallback:false, observedAt:Date.now(), establishedAt:Date.now()-180000},
  'studio-tailcat': {state:'connected', transport:'tailcat', fallback:true, observedAt:Date.now(), establishedAt:Date.now()-180000},
 } })
createRoot(document.getElementById('root')!).render(<DesktopClientUiProvider><div className="mesh-review-shell"><SettingsPanel onClose={() => {}} initialSection="hosts" /><footer className="mesh-review-footer">Visual fixture · production Settings · controlled topology/resource observations; not live host telemetry</footer></div></DesktopClientUiProvider>)
Object.assign(window, { meshFixture: { originalOffer, endpoint: () => { state = 'endpoint' }, relayOff: () => { state = 'initial' }, theme: (mode: 'dark' | 'light') => updateThemeSelection({ appAppearance: mode }), failure: () => { state = 'failure'; settings = { ...settings, revision: 'saved-9' } } } })
if (state === 'device') {
 const offer = { ...originalOffer, serverId: 'office-workstation', relay: { endpoint: 'gateway.example', useTls: true } }
 useAppStore.setState({ meshDeviceLinks: { draft: '', saved: [connectionLinkUrl('https://gateway.example', offer)] } })
 api.nodePublishing.deviceLocation = async () => ({
   node: { runtimeId: 'workstation-core', ownerInstanceId: 'workstation-instance', alias: 'Office workstation' },
   location: { source: 'node', latitude: 1.35, longitude: 103.82, label: 'Singapore office' },
 })
}
if (state === 'geography') useAppStore.setState({ config: {
  ...useAppStore.getState().config!,
  meshMapLocations: { local: '31.2304, 121.4737', studio: '52.52, 13.405', build: '0, 0', private: '31.2304, 121.4737' },
} })
