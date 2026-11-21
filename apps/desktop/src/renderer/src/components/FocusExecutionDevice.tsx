import { useMemo } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { FocusContext } from '../lib/focus-context'
import { useAppStore } from '../store'
import { HostIcon } from './HostBadge'

const WarningIcon = semanticIconComponent('status.warning')

export function useFocusExecutionDevice(context: FocusContext) {
  // A Source-local Host ID and a Desktop route ID are different namespaces.
  const hostId = context.kind !== 'agent' ? undefined : context.access
    ? context.access.executionRouteHostId : context.control?.hostId ?? context.hostId
  const remoteId = hostId && hostId !== 'local' ? hostId : undefined
  const hosts = useAppStore(state => remoteId ? state.config?.hosts : undefined)
  const host = useMemo(() => hosts?.find(item => item.id === remoteId), [hosts, remoteId])
  const transport = useAppStore(state => remoteId ? state.hostTransports?.[remoteId]?.state : undefined)
  if (!remoteId || host?.kind === 'local') return undefined

  const label = host?.label.trim() || remoteId
  const connection = host?.kind === 'ssh' && transport && transport !== 'unopened' ? transport : 'unconfirmed'
  const status = connection === 'connected' ? undefined : connection === 'disconnected' ? 'Disconnected'
    : connection === 'connecting' ? 'Connecting' : 'Unconfirmed'
  const description = `Execution device: ${label}${label === remoteId ? '' : ` (${remoteId})`} · ${status ? `Connection ${status.toLowerCase()}` : 'Channel connected'}`
  return { hostId: remoteId, label, connection, status, description, kind: host?.kind ?? 'unknown' as const }
}

export function FocusExecutionDevice({ device }: { device: NonNullable<ReturnType<typeof useFocusExecutionDevice>> }) {
  return <span className="focus-execution-device" data-focus-device={device.hostId} data-connection={device.connection}
    title={device.description} aria-hidden="true">
    {device.connection === 'disconnected' ? <WarningIcon size={12} aria-hidden="true" /> : <HostIcon kind={device.kind} />}
    <span className="focus-execution-device__name">{device.label}</span>
    {device.status ? <span className="focus-execution-device__status">{device.status}</span> : null}
  </span>
}
