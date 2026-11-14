import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { Button } from '@agentmux/client-ui/components/Button'
import type { HostConfig } from '../../../../shared/contracts'
import { currentHostCheck, hostCheckLabel } from '../../lib/host-check'
import { hostConnectionSummary, hostTransportLabel } from '../../lib/host-transport'
import { useAppStore } from '../../store'
import { HostIcon } from '../HostBadge'
import { useHostConnectionHint } from '../HostConnectionTooltip'

export type SavedHostNode = Node<{ locationHint?: string; host: HostConfig; selected: boolean; dimmed: boolean; onSelect: (id: string) => void }, 'savedHost'>
export type SavedClientNode = Node<{ locationHint?: string }, 'savedClient'>
export const savedHostId = (id: string) => `saved:host:${id}`
export const SAVED_CLIENT_ID = 'saved:client'
const HOST_SIZE = { width: 158, height: 64 }
const CLIENT_SIZE = { width: 112, height: 52 }

export function MeshPorts({ type }: { type: 'source' | 'target' }) {
  return [Position.Left, Position.Right, Position.Top, Position.Bottom].map(position => <Handle
    key={position} type={type} id={position} position={position} isConnectable={false} />)
}

export function MeshSavedHost({ data }: NodeProps<SavedHostNode>) {
  const { host, selected, dimmed, onSelect } = data
  const connection = useHostConnectionHint(host.id, host.label)
  return <>
    <MeshPorts type="target" />
    <button type="button" className="mesh-explorer-node mesh-saved-host nopan" data-host-node={host.id} data-dimmed={dimmed || undefined}
      aria-pressed={selected} title={connection.detail} onClick={() => onSelect(host.id)}>
      <span className="mesh-explorer-node__kind" title={data.locationHint ? 'Estimated from public egress · ' + data.locationHint : undefined}><HostIcon kind={host.kind} size={12} />{data.locationHint ?? hostTransportLabel(host)}{selected ? <span aria-label="Selected">✓</span> : null}</span>
      <strong>{host.label}</strong>
      <span className="mesh-explorer-node__state">{connection.summary.replace(/^Current: /, '')}</span>
    </button>
  </>
}

export function MeshSavedClient({ data }: NodeProps<SavedClientNode>) {
  return <div className="mesh-saved-client" data-location-estimate={data.locationHint ? '' : undefined}>
    {!data.locationHint && <HostIcon kind="local" size={15} />}
    <strong>This device</strong>
    {data.locationHint && <small title="Estimated from public egress">{data.locationHint}</small>}
    <MeshPorts type="source" />
  </div>
}

export function savedConnectionNodes(hosts: readonly HostConfig[], twoBanks: boolean,
  selectedId: string | undefined, matches: (host: HostConfig) => boolean, onSelect: (id: string) => void, includeClient = false): (SavedHostNode | SavedClientNode)[] {
  if (hosts.length === 0 && !includeClient) return []
  const bank = Math.max(1, Math.ceil(hosts.length / 2))
  return [
    { id: SAVED_CLIENT_ID, type: 'savedClient', ...CLIENT_SIZE, selectable: false,
      position: twoBanks ? { x: 175, y: (bank - 1) * 40 + 6 } : { x: (bank - 1) * 88 + 23, y: 91 }, data: {} },
    ...hosts.map((host, index): SavedHostNode => ({
      id: savedHostId(host.id), type: 'savedHost', ...HOST_SIZE, selectable: false,
      position: twoBanks ? { x: index < bank ? 0 : 304, y: index % bank * 80 } : { x: index % bank * 176, y: index < bank ? 0 : 170 },
      data: { host, selected: selectedId === host.id, dimmed: selectedId !== host.id && !matches(host), onSelect },
    })),
  ]
}

export function SavedConnectionDetails({ host, onDevice, onLocation, location, onClear }: {
  host: HostConfig
  onDevice: ((hostId: string) => void) | undefined
  onLocation: ((hostId: string) => void) | undefined
  location: string
  onClear: () => void
}) {
  const connection = useHostConnectionHint(host.id, host.label)
  const authoredCheck = useAppStore(state => state.hostChecks[host.id])
  const check = currentHostCheck(authoredCheck, host)
  const testedAt = check?.observedAt
  return <aside className="mesh-explorer__detail mesh-saved-connections__details" aria-label="Selected saved connection">
    <header><span className="mesh-explorer__eyebrow">SAVED CONNECTION</span><Button type="button" onClick={onClear}>Clear</Button></header>
    <h4>{host.label}</h4>
    <p>{hostConnectionSummary(host)}<br />{connection.summary}</p>
    {check && check.state !== 'idle' ? <p>Connection test · {hostCheckLabel(check)}{testedAt !== undefined ? ` · ${new Date(testedAt).toLocaleString()}` : ''}</p> : null}
    {onLocation ? <p>{location || 'Location unknown'}</p> : null}
    <div className="mesh-explorer__detail-actions">
      {onLocation ? <Button type="button" onClick={() => onLocation(host.id)}>{location ? 'Edit map location' : 'Set map location'}</Button> : null}
      {onDevice ? <Button type="button" onClick={() => onDevice(host.id)}>Manage connection</Button> : null}
    </div>
  </aside>
}
