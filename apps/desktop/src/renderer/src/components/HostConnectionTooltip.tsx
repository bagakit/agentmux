import { useAppStore } from '../store'
import { hostConnectionPresentation } from '../lib/host-connection-presentation'
import { useWorkbenchNameTooltip } from './WorkbenchNameTooltip'
import { useMemo } from 'react'

/** Every consumer reads the same exact Host's passive snapshot; opening a hint performs no I/O. */
export function useHostConnectionHint(hostId: string | null, label: string, homeAction = false) {
  const hosts = useAppStore(state => state.config?.hosts)
  const host = useMemo(() => hosts?.find(item => item.id === hostId), [hosts, hostId])
  const observation = useAppStore(state => hostId ? state.hostTransports?.[hostId] : undefined)
  const { summary, detail } = hostConnectionPresentation(host, observation)
  return { summary, name: hostId ? `${label} · ${hostId}` : 'Host unknown', detail: detail + (homeAction && host?.kind !== 'local' ? '\n~ opens this device’s home.' : '') }
}

export function useHostConnectionTooltip(hostId: string | null, label: string, suppressed = false) {
  const hint = useHostConnectionHint(hostId, label)
  return useWorkbenchNameTooltip(hint.name, hint.detail, suppressed, { pointerPassThrough: true })
}
