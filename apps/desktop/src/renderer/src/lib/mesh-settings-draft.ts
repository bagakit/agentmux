import type { MeshNetworkConfiguration, MeshNetworkSettings } from '@agentmux/core/mesh-network'

/** Authored form strings can be incomplete; only the original Core validates saved policy. */
export type MeshForm = {
  role: MeshNetworkConfiguration['role']; networkId: string; listen: boolean; host: string; port: string
  ingress: string; peers: string; clientKeys: string; keyPath: string; certPath: string; publishers: string
}
export type MeshSettingsDraft = {
  baseline: MeshNetworkSettings; form: MeshForm; linkInput?: string
  pending?: { operationId: string; expectedRevision: string; submitted: MeshNetworkConfiguration; submittedForm: MeshForm; phase: 'in-flight' | 'unknown' } | undefined
}
type PeerCode = { schema: 'agentmux.mesh-peer.v1'; networkId: string; peerId: string; publicKey: string; endpoints: { endpoint: string; useTls: boolean }[]; direct?: boolean }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const unreadable = (): never => { throw new Error('The original Mesh edit cannot be read. Its saved bytes and existing work are retained.') }
const fields = ['networkId', 'host', 'port', 'ingress', 'peers', 'clientKeys', 'keyPath', 'certPath', 'publishers'] as const
function readableForm(value: unknown): value is MeshForm { return record(value) && ['disabled', 'participant', 'gateway'].includes(value.role as string) && typeof value.listen === 'boolean' && fields.every(key => typeof value[key] === 'string') }
export function meshDraftRecord(value: unknown): Record<string, unknown> { if (value === undefined) return {}; return record(value) ? value : unreadable() }
export function meshDraftForRuntime(value: unknown, runtimeId: string): MeshSettingsDraft | undefined {
  const draft = meshDraftRecord(value)[runtimeId]
  if (draft === undefined) return undefined
  if (!record(draft) || !record(draft.baseline) || !record(draft.baseline.owner) || draft.baseline.owner.runtimeId !== runtimeId || typeof draft.baseline.revision !== 'string' ||
      !record(draft.baseline.configuration) || !readableForm(draft.form)) return unreadable()
  if (draft.linkInput !== undefined && typeof draft.linkInput !== 'string') return unreadable()
  if (draft.pending !== undefined && (!record(draft.pending) || typeof draft.pending.operationId !== 'string' || !draft.pending.operationId ||
      typeof draft.pending.expectedRevision !== 'string' || !record(draft.pending.submitted) || !readableForm(draft.pending.submittedForm) || !['in-flight', 'unknown'].includes(draft.pending.phase as string))) return unreadable()
  try { if (!readableForm(meshForm(draft.baseline.configuration as MeshNetworkConfiguration))) return unreadable() } catch { return unreadable() }
  return draft as unknown as MeshSettingsDraft
}
export function restoredMeshDrafts(value: unknown): unknown {
  if (!record(value)) return value
  let result: Record<string, unknown> | undefined
  for (const runtimeId of Object.keys(value)) try {
    const entry = meshDraftForRuntime(value, runtimeId)
    if (entry?.pending?.phase === 'in-flight') { result ??= { ...value }; result[runtimeId] = { ...entry, pending: { ...entry.pending, phase: 'unknown' } } }
  } catch { /* Keep unknown original entries opaque. Their own editor reports the gap. */ }
  return result ?? value
}
export function meshPeerCode(settings: MeshNetworkSettings, direct = true): string | null {
  if (!settings.identity) return null
  const data: PeerCode = { schema: 'agentmux.mesh-peer.v1', networkId: settings.configuration.networkId,
    peerId: settings.identity.peerId, publicKey: settings.identity.publicKey, endpoints: [...settings.configuration.advertisedIngress ?? []], direct }
  const text = JSON.stringify(data), bytes = new TextEncoder().encode(text)
  return 'amux-mesh:' + btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replace(/=/gu, '').replace(/\+/gu, '-').replace(/\//gu, '_')
}
function decodePeerCode(text: string): PeerCode {
  if (!text.startsWith('amux-mesh:')) throw new Error('Paste a peer connection code copied from Mesh settings.')
  const body = text.slice(10).replace(/-/gu, '+').replace(/_/gu, '/'), bytes = Uint8Array.from(atob(body), char => char.charCodeAt(0))
  const p: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (!record(p) || p.schema !== 'agentmux.mesh-peer.v1' || typeof p.networkId !== 'string' || typeof p.peerId !== 'string' || typeof p.publicKey !== 'string' || !Array.isArray(p.endpoints)) throw new Error('This peer connection code is incomplete.')
  return p as unknown as PeerCode
}
export function meshForm(configuration: MeshNetworkConfiguration, ownPeerId?: string): MeshForm {
  const codes = configuration.members.filter(member => member.peerId !== ownPeerId).map(member => {
    const settings = { identity: { ...member, epoch: 0 }, configuration: { networkId: configuration.networkId,
      advertisedIngress: configuration.peers.find(peer => peer.peerId === member.peerId)?.endpoints ?? [] } } as unknown as MeshNetworkSettings
    return meshPeerCode(settings, configuration.peers.some(peer => peer.peerId === member.peerId))!
  })
  return { role: configuration.role, networkId: configuration.networkId, listen: Boolean(configuration.listen), host: configuration.listen?.host ?? '127.0.0.1',
    port: String(configuration.listen?.port ?? 8444), ingress: (configuration.advertisedIngress ?? []).map(endpoint => (endpoint.useTls ? 'https://' : 'http://') + endpoint.endpoint).join('\n'),
    peers: codes.join('\n'), clientKeys: configuration.endpointAccess.allowedClientKeys.join('\n'),
    keyPath: configuration.listen?.tls?.keyPath ?? '', certPath: configuration.listen?.tls?.certPath ?? '', publishers: JSON.stringify(configuration.publishers, null, 2) }
}
/** This converts form input only. It neither declares valid membership nor admits a connection. */
export function meshConfiguration(form: MeshForm, baseline: MeshNetworkConfiguration, own?: { peerId: string; publicKey: string }): MeshNetworkConfiguration {
  const before = meshForm(baseline, own?.peerId), configuration = structuredClone(baseline)
  configuration.role = form.role; configuration.networkId = form.networkId
  if (form.peers !== before.peers || form.networkId !== before.networkId) {
    const codes = form.peers.split(/\s+/u).filter(Boolean).map(decodePeerCode)
    if (codes.some(code => code.networkId !== form.networkId)) throw new Error('Peer codes must belong to this network. Keep the original codes or choose their network name.')
    configuration.members = codes.map(code => ({ peerId: code.peerId, publicKey: code.publicKey }))
    configuration.peers = codes.filter(code => code.direct !== false && code.peerId !== own?.peerId).map(code => ({ peerId: code.peerId, endpoints: code.endpoints }))
  }
  if (own && form.role !== 'disabled') {
    const member = configuration.members.find(member => member.peerId === own.peerId)
    if (member && member.publicKey !== own.publicKey) throw new Error('The local network identity differs from its original Core public key. Keep the original identity.')
    if (!member) configuration.members = [...configuration.members, { peerId: own.peerId, publicKey: own.publicKey }]
    configuration.peers = configuration.peers.filter(peer => peer.peerId !== own.peerId)
  }
  if (form.clientKeys !== before.clientKeys) configuration.endpointAccess = { allowedClientKeys: form.clientKeys.split(/\r?\n/u).filter(Boolean) }
  if (form.ingress !== before.ingress) configuration.advertisedIngress = form.ingress.split(/\r?\n/u).filter(Boolean).map(text => {
    const url = new URL(text)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use a complete HTTP or HTTPS gateway origin without a path or credentials.')
    return { endpoint: url.host, useTls: url.protocol === 'https:' }
  })
  if (form.role !== 'gateway') { delete configuration.listen; configuration.advertisedIngress = [] }
  else if (!form.listen) delete configuration.listen
  else if (!baseline.listen || form.host !== before.host || form.port !== before.port || form.keyPath !== before.keyPath || form.certPath !== before.certPath) {
    if (!/^(0|[1-9][0-9]*)$/u.test(form.port)) throw new Error('Enter an explicit whole port number. Your incomplete input is retained.')
    configuration.listen = { host: form.host, port: Number(form.port), ...(form.keyPath || form.certPath ? { tls: { keyPath: form.keyPath, certPath: form.certPath } } : {}) }
  }
  if (form.publishers !== before.publishers) configuration.publishers = JSON.parse(form.publishers)
  return configuration
}
