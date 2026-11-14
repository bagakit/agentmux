import type { MeshNetworkSettings } from './mesh-network.js'

export type MeshPeerCode = {
  schema: 'agentmux.mesh-peer.v1'
  networkId: string
  peerId: string
  publicKey: string
  endpoints: { endpoint: string; useTls: boolean }[]
  direct?: boolean
}

/** Public pairing material shared by Desktop and headless operators. The receiving Core verifies membership on save. */
export function meshPeerCode(settings: Pick<MeshNetworkSettings, 'identity' | 'configuration'>, direct = true): string | null {
  if (!settings.identity) return null
  const value: MeshPeerCode = {
    schema: 'agentmux.mesh-peer.v1', networkId: settings.configuration.networkId, peerId: settings.identity.peerId,
    publicKey: settings.identity.publicKey, endpoints: [...settings.configuration.advertisedIngress ?? []], direct
  }
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  return 'amux-mesh:' + btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replace(/=/gu, '').replace(/\+/gu, '-').replace(/\//gu, '_')
}

export function decodeMeshPeerCode(text: string): MeshPeerCode {
  if (!text.startsWith('amux-mesh:')) throw new Error('Paste a connection code copied from the other device’s Mesh settings.')
  try {
    const body = text.slice(10).replace(/-/gu, '+').replace(/_/gu, '/')
    const bytes = Uint8Array.from(atob(body), char => char.charCodeAt(0))
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (value?.schema !== 'agentmux.mesh-peer.v1' || !value.networkId || typeof value.networkId !== 'string' ||
      !value.peerId || typeof value.peerId !== 'string' || !value.publicKey || typeof value.publicKey !== 'string' ||
      (value.direct !== undefined && typeof value.direct !== 'boolean') || !Array.isArray(value.endpoints)) throw Error()
    const endpoints = value.endpoints.map((entry: MeshPeerCode['endpoints'][number]) => {
      if (!entry || typeof entry.endpoint !== 'string' || typeof entry.useTls !== 'boolean') throw Error()
      const url = new URL((entry.useTls ? 'https://' : 'http://') + entry.endpoint)
      if (!url.hostname || /[\s/?#@]/u.test(entry.endpoint)) throw Error()
      return { endpoint: url.host, useTls: entry.useTls }
    })
    return { schema: value.schema, networkId: value.networkId, peerId: value.peerId, publicKey: value.publicKey,
      endpoints, ...(value.direct === undefined ? {} : { direct: value.direct }) }
  } catch { throw new Error('This Mesh connection code is incomplete. Copy the full code from the other device.') }
}
