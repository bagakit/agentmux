import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { HostConfig } from '../../../../shared/contracts'
import { currentHostCheck, hostCheckLabel } from '../../lib/host-check'
import { hostConnectionSummary, hostTransportLabel } from '../../lib/host-transport'
import { useAppStore } from '../../store'
import { HostIcon } from '../HostBadge'
import { useHostConnectionHint } from '../HostConnectionTooltip'

export type SavedHostNode = Node<{ host: HostConfig; selected: boolean; dimmed: boolean; onSelect: (id: string) => void }, 'savedHost'>
export type SavedClientNode = Node<Record<string, never>, 'savedClient'>
export const savedHostId = (id: string) => `saved:host:${id}`
export const SAVED_CLIENT_ID = 'saved:client'
const HOST_SIZE = { width: 158, height: 64 }
const CLIENT_SIZE = { width: 112, height: 52 }
export const SAVED_BANK_WIDTH = 462

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
      <span className="mesh-explorer-node__kind"><HostIcon kind={host.kind} size={12} />{hostTransportLabel(host)}{selected ? <span aria-label="Selected">✓</span> : null}</span>
      <strong>{host.label}</strong>
      <span className="mesh-explorer-node__state">{connection.summary.replace(/^Current: /, '')}</span>
    </button>
  </>
}

export function MeshSavedClient() {
  return <div className="mesh-saved-client"><HostIcon kind="local" size={15} /><strong>This client</strong><MeshPorts type="source" /></div>
}

/** Layout only. IDs remain disjoint from Relay peer IDs and carry no authorization. */
export function savedConnectionNodes(hosts: readonly HostConfig[], stacked: boolean, twoBanks: boolean,
  selectedId: string | undefined, matches: (host: HostConfig) => boolean, onSelect: (id: string) => void): (SavedHostNode | SavedClientNode)[] {
  if (hosts.length === 0) return []
  const bank = Math.ceil(hosts.length / 2)
  const bankHeight = twoBanks ? (bank - 1) * 80 + HOST_SIZE.height : 234
  const offset = stacked ? -bankHeight - 54 : 0
  return [
    { id: SAVED_CLIENT_ID, type: 'savedClient', ...CLIENT_SIZE, selectable: false,
      position: twoBanks ? { x: 175, y: offset + (bank - 1) * 40 + 6 } : { x: (bank - 1) * 88 + 23, y: offset + 91 }, data: {} },
    ...hosts.map((host, index): SavedHostNode => ({
      id: savedHostId(host.id), type: 'savedHost', ...HOST_SIZE, selectable: false,
      position: twoBanks ? { x: index < bank ? 0 : 304, y: offset + index % bank * 80 } : { x: index % bank * 176, y: offset + (index < bank ? 0 : 170) },
      data: { host, selected: selectedId === host.id, dimmed: selectedId !== host.id && !matches(host), onSelect },
    })),
  ]
}

export function SavedConnectionDetails({ host, onDevice, onClear }: {
  host: HostConfig
  onDevice: ((hostId: string) => void) | undefined
  onClear: () => void
}) {
  const connection = useHostConnectionHint(host.id, host.label)
  const authoredCheck = useAppStore(state => state.hostChecks[host.id])
  const check = currentHostCheck(authoredCheck, host)
  const testedAt = check?.observedAt
  return <aside className="mesh-explorer__detail mesh-saved-connections__details" aria-label="Selected saved connection">
    <header><span className="mesh-explorer__eyebrow">SAVED CONNECTION</span><button type="button" className="small-button" onClick={onClear}>Clear</button></header>
    <h4>{host.label}</h4>
    <p>{hostConnectionSummary(host)}<br />{connection.summary}</p>
    {check && check.state !== 'idle' ? <p>Connection test · {hostCheckLabel(check)}{testedAt !== undefined ? ` · ${new Date(testedAt).toLocaleString()}` : ''}</p> : null}
    {onDevice ? <button type="button" className="small-button" onClick={() => onDevice(host.id)}>Manage connection</button> : null}
  </aside>
}
