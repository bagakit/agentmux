import { NativeSelect } from '@agentmux/client-ui/input'
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { MeshOwnerTarget } from '@agentmux/core/mesh-network'
import type { HostConfig } from '../../../../shared/contracts'
import { api } from '../../lib/api'
import { useAppStore } from '../../store'

function routeKey({ label: _label, ...route }: HostConfig) {
  return JSON.stringify(route)
}

/** Resolve only the selected saved Host. Its own Core still authorizes every operator request. */
export function MeshOperatorTarget({ label, active, initial, request, localLabel = 'This device', children }: {
  label: string; active: boolean; initial?: MeshOwnerTarget | undefined
  localLabel?: string
  request?: { hostId?: string | undefined } | undefined
  children(target: MeshOwnerTarget | undefined, label: string): ReactNode
}) {
  const hosts = useAppStore(state => state.config?.hosts)
  const remotes = (hosts ?? []).filter(host => host.kind === 'ssh')
  const requestedSelection = () => {
    if (request) {
      if (request.hostId === undefined || hosts?.some(host => host.id === request.hostId && host.kind === 'local')) return ''
      const saved = remotes.find(host => host.id === request.hostId)
      return saved ? routeKey(saved) : JSON.stringify({ hostId: request.hostId })
    }
    const match = initial && remotes.find(host => host.id === initial.hostId && (!host.runtimeId || host.runtimeId === initial.expectedRuntimeId))
    return match ? routeKey(match) : initial ? JSON.stringify(initial) : ''
  }
  const applied = useRef(request)
  const [chosen, setSelection] = useState(requestedSelection)
  const selection = applied.current !== request && request ? requestedSelection() : chosen
  useLayoutEffect(() => {
    if (applied.current !== request && request) setSelection(selection)
    applied.current = request
  }, [request, selection])
  const selected = remotes.find(host => routeKey(host) === selection)
  const option = (host: HostConfig) => JSON.stringify([host.id])
  const choice = selected ? option(selected) : selection ? 'unavailable' : ''
  const [resolved, setResolved] = useState<{ route: string; runtime?: string; error?: string }>()
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!active || !selected || selected.runtimeId) return
    const controller = new AbortController()
    void api.nodePublishing.call('node.inspect', { hostId: selected.id }, controller.signal).then(reply => {
      if (!controller.signal.aborted) setResolved({ route: selection, runtime: reply.node.runtimeId })
    }).catch(cause => {
      if (!controller.signal.aborted) setResolved({ route: selection, error: cause instanceof Error ? cause.message : String(cause) })
    })
    return () => controller.abort()
  }, [active, selection, retry])
  const runtime = selected?.runtimeId ?? (resolved?.route === selection ? resolved.runtime : undefined)
  const target = selected && runtime ? { hostId: selected.id, expectedRuntimeId: runtime } : undefined
  return <>
    {remotes.length || selection ? <label className="mesh-form-field"><span>{label}</span><NativeSelect aria-label={label} value={choice} onChange={event => {
      const host = remotes.find(item => option(item) === event.target.value)
      setSelection(host ? routeKey(host) : '')
    }}>
      <option value="">{localLabel}</option>
      {selection && !selected ? <option value="unavailable">Previously selected Host unavailable</option> : null}
      {remotes.map(host => <option key={host.id} value={option(host)}>{host.label} · {host.id}</option>)}
    </NativeSelect></label> : null}
    {!selection || target ? <Fragment key={JSON.stringify([selection, runtime])}>{children(target, selected?.label ?? localLabel)}</Fragment>
      : <div role="status">{!selected ? 'Select a saved Host to continue.' : resolved?.route === selection && resolved.error
        ? <>{resolved.error} <button type="button" className="small-button" onClick={() => setRetry(value => value + 1)}>Check selected Host</button></> : 'Reading the selected Host identity…'}</div>}
  </>
}
