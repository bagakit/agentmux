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
export function useHostNetworkObservation(activeHost: HostConfig | null, localHost: HostConfig | null = null) {
  const [reads, setReads] = useState<Record<string, HostNetworkRead>>({})
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  const controllers = useRef(new Map<string, { configuration: HostConfig; controller: AbortController }>())
  const scope = activeHost ? JSON.stringify(activeHost) : null
  const localScope = localHost ? JSON.stringify(localHost) : null
  const automatic = useRef<string | null>(null)
  useEffect(() => { const changed = () => setVisible(document.visibilityState !== 'hidden'); document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed) }, [])
  const cancel = useCallback((id: string) => {
    const pending = controllers.current.get(id)
    if (!pending) return
    pending.controller.abort(); controllers.current.delete(id)
    setReads(previous => {
      const held = currentHostNetwork(previous[id], pending.configuration)
      return held ? { ...previous, [id]: { ...held, busy: false, error: 'This read was cancelled. Read the original link again when needed.' } } : previous
    })
  }, [])
  useEffect(() => {
    for (const [id, pending] of controllers.current) {
      const key = JSON.stringify(pending.configuration)
      if (!visible || key !== scope && key !== localScope) cancel(id)
    }
  }, [scope, localScope, visible, cancel])
  useEffect(() => () => { for (const pending of controllers.current.values()) pending.controller.abort(); controllers.current.clear() }, [])
  const read = useCallback(async (configuration: HostConfig) => {
    const key = JSON.stringify(configuration)
    if (!visible || key !== scope && key !== localScope) return
    cancel(configuration.id)
    const current = new AbortController(); controllers.current.set(configuration.id, { configuration, controller: current })
    setReads(previous => ({ ...previous, [configuration.id]: { ...currentHostNetwork(previous[configuration.id], configuration), configuration, busy: true, error: undefined } }))
    try {
      const observation = await api.hosts.network(configuration, { signal: current.signal })
      current.signal.throwIfAborted()
      if (observation.routeHostId !== configuration.id || !configValuesEqual(observation.configuration, configuration)) throw new Error('This network observation belongs to another saved connection. Read the original link again.')
      setReads(previous => ({ ...previous, [configuration.id]: { configuration, latest: observation,
        retained: retain(observation, currentHostNetwork(previous[configuration.id], configuration)?.retained), busy: false } }))
    } catch (error) {
      // Capture request ownership before React schedules the updater; finally releases the ref.
      if (controllers.current.get(configuration.id)?.controller !== current) return
      const message = current.signal.aborted ? 'This read was cancelled. Read the original link again when needed.' : error instanceof Error ? error.message : 'This link could not be observed.'
      setReads(previous => {
        const held = currentHostNetwork(previous[configuration.id], configuration)
        return held ? { ...previous, [configuration.id]: { ...held, busy: false, error: message } } : previous
      })
    } finally { if (controllers.current.get(configuration.id)?.controller === current) controllers.current.delete(configuration.id) }
  }, [scope, localScope, visible, cancel])
  useEffect(() => {
    if (!localScope) { automatic.current = null; return }
    if (!visible || automatic.current === localScope) return
    automatic.current = localScope
    void read(localHost!)
  }, [localScope, visible, read])
  return { reads, read, visible }
}
