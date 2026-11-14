import { useState } from 'react'
import type { Node, NodeProps } from '@xyflow/react'
import { Button } from '@agentmux/client-ui/components/Button'
import { meshDeviceMapId, readMeshDeviceLink } from '../../../../shared/mesh-device-link'
import { api } from '../../lib/api'
import { MeshPorts } from './MeshSavedConnections'

export type SavedDevice = { id: string; serverId: string; routes: { url: string; gateway: string }[] }
export type DeviceNode = Node<{ locationHint?: string; device: SavedDevice; selected: boolean; dimmed: boolean; choose(id: string): void }, 'device'>

export function savedMeshDevices(urls: readonly string[]) {
  const devices = new Map<string, SavedDevice>()
  for (const source of urls) {
    let link: ReturnType<typeof readMeshDeviceLink>
    try { link = readMeshDeviceLink(source) } catch { continue }
    const id = meshDeviceMapId(link.offer)
    const device: SavedDevice = devices.get(id) ?? { id, serverId: link.offer.serverId, routes: [] }
    device.routes.push({ url: link.url, gateway: link.offer.relay.endpoint })
    devices.set(id, device)
  }
  return [...devices.values()]
}

export function SavedDeviceNode({ data }: NodeProps<DeviceNode>) {
  return <><MeshPorts type="target" /><button type="button" className="mesh-explorer-node nopan" data-mesh-device={data.device.serverId}
    aria-pressed={data.selected} data-dimmed={data.dimmed || undefined} onClick={() => data.choose(data.device.id)}>
    <span className="mesh-explorer-node__kind" title={data.locationHint ? 'Estimated from public egress · ' + data.locationHint : undefined}>{data.locationHint ?? 'Device endpoint'}</span>
    <strong title={data.device.serverId}>{data.device.serverId}</strong>
    <span className="mesh-explorer-node__state">Saved access link</span>
  </button></>
}

export function SavedDeviceDetails({ device, location, edit, clear }: {
  device: SavedDevice; location: string; edit?: (() => void) | undefined; clear(): void
}) {
  const [error, setError] = useState('')
  async function open(url: string) {
    setError('')
    try { await api.ui.openMeshDevice(url) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  return <aside className="mesh-explorer__detail" aria-label="Selected device endpoint">
    <header><span className="mesh-explorer__eyebrow">Device endpoint</span><Button type="button" onClick={clear}>Clear</Button></header>
    <h4>{device.serverId}</h4><p>{location || 'Location unknown'}</p>
    <div className="mesh-explorer__detail-actions">
      {edit && <Button type="button" onClick={edit}>{location ? 'Edit map location' : 'Set map location'}</Button>}
      {device.routes.map(route => <Button key={route.url} type="button" onClick={() => void open(route.url)}>Open via {route.gateway}</Button>)}
    </div>
    {error && <p role="alert">{error}</p>}
  </aside>
}
