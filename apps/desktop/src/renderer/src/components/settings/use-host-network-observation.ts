import { useCallback, useEffect, useRef, useState } from 'react'
import type { HostNetworkObservation, HostRuntimeSource } from '@agentmux/core'
import type { HostConfig } from '../../../../shared/contracts'
import { configValuesEqual } from '../../../../shared/config-edit'
import { api } from '../../lib/api'

export type HostNetworkRead = { configuration: HostConfig; latest?: HostNetworkObservation; retained?: HostNetworkObservation; busy?: boolean; error?: string | undefined }
function keep<T>(next: HostRuntimeSource<T>, previous?: HostRuntimeSource<T>): HostRuntimeSource<T> {
  return next.state === 'available' || previous?.state !== 'available' ? next : previous
}
function retain(next: HostNetworkObservation, previous?: HostNetworkObservation): HostNetworkObservation {
  return { ...next, observer: keep(next.observer, previous?.observer), target: keep(next.target, previous?.target),
    ssh: next.ssh === null ? null : keep(next.ssh, previous?.ssh ?? undefined) }
}
export function currentHostNetwork(read: HostNetworkRead | undefined, host: HostConfig): HostNetworkRead | undefined {
  return read && configValuesEqual(read.configuration, host) ? read : undefined
}
/** One workbench-local observation per visited route. No polling or connection ownership. */
export function useHostNetworkObservation(activeHost: HostConfig | null) {
  const [reads, setReads] = useState<Record<string, HostNetworkRead>>({})
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  const controller = useRef<{ key: string; configuration: HostConfig; controller: AbortController } | null>(null)
  const scope = activeHost ? JSON.stringify(activeHost) : null
  useEffect(() => { const changed = () => setVisible(document.visibilityState !== 'hidden'); document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed) }, [])
  const cancel = useCallback(() => {
    const pending = controller.current
    if (!pending) return
    pending.controller.abort(); controller.current = null
    setReads(previous => {
      const held = currentHostNetwork(previous[pending.configuration.id], pending.configuration)
      return held ? { ...previous, [pending.configuration.id]: { ...held, busy: false, error: 'This read was cancelled. Read the original link again when needed.' } } : previous
    })
  }, [])
  useEffect(() => () => { if (controller.current?.key === scope) cancel() }, [scope, visible, cancel])
  const read = useCallback(async (configuration: HostConfig) => {
    if (!visible || scope !== JSON.stringify(configuration)) return
    cancel()
    const current = new AbortController(); controller.current = { key: scope, configuration, controller: current }
    setReads(previous => ({ ...previous, [configuration.id]: { ...currentHostNetwork(previous[configuration.id], configuration), configuration, busy: true, error: undefined } }))
    try {
      const observation = await api.hosts.network(configuration, { signal: current.signal })
      current.signal.throwIfAborted()
      if (observation.routeHostId !== configuration.id || !configValuesEqual(observation.configuration, configuration)) throw new Error('This network observation belongs to another saved connection. Read the original link again.')
      setReads(previous => ({ ...previous, [configuration.id]: { configuration, latest: observation,
        retained: retain(observation, currentHostNetwork(previous[configuration.id], configuration)?.retained), busy: false } }))
    } catch (error) {
      // Capture request ownership before React schedules the updater; finally releases the ref.
      if (controller.current?.controller !== current) return
      const message = current.signal.aborted ? 'This read was cancelled. Read the original link again when needed.' : error instanceof Error ? error.message : 'This link could not be observed.'
      setReads(previous => {
        const held = currentHostNetwork(previous[configuration.id], configuration)
        return held ? { ...previous, [configuration.id]: { ...held, busy: false, error: message } } : previous
      })
    } finally { if (controller.current?.controller === current) controller.current = null }
  }, [scope, visible, cancel])
  return { reads, read, visible }
}
