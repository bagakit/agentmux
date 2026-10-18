import { useEffect, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { RoomBinding, RoomBindingTarget } from '@agentmux/core/connections'
import { api } from './api'
import { observeConnectorTarget } from './connector-room-intent'

/** A visible Session reads its original relationships; no directory, polling or durable projection. */
export function useSessionConnections(target: Pick<RoomBindingTarget, 'executionHostId' | 'agentSessionId'>, visible: boolean) {
  const identity = JSON.stringify([target.executionHostId, target.agentSessionId])
  const [read, setRead] = useState<{ identity: string; bindings: RoomBinding[]; issue: string; loading: boolean; version: number } | null>(null)
  useEffect(() => {
    if (!visible) return
    let live = true, generation = 0
    const refresh = () => {
      const request = ++generation
      setRead(previous => previous?.identity === identity ? { ...previous, loading: true } : { identity, bindings: [], issue: '', loading: true, version: 0 })
      void api.connections.call('connection.binding.ls', target).then(value => {
        if (live && request === generation) setRead({ identity, bindings: value.bindings, issue: '', loading: false, version: request })
      }).catch(error => {
        if (live && request === generation) setRead(previous => ({ identity, bindings: previous?.identity === identity ? previous.bindings : [],
          issue: presentError(error), loading: false, version: previous?.identity === identity ? previous.version : 0 }))
      })
    }
    refresh()
    const close = observeConnectorTarget(target, refresh)
    return () => { live = false; generation++; close() }
  }, [identity, visible])
  return read?.identity === identity ? read : null
}
