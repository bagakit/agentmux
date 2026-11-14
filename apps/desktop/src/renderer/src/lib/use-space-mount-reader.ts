import { useEffect, useState } from 'react'
import type { SpaceMountRecord } from '../../../shared/space-mount'
import { api } from './api'
import { useAppStore } from '../store'
import { useWorkbenchDocument } from './workbench-document'
import { useWorkbenchDocumentVisibility } from './workbench-window-registry'

export function useMountedSpaceReader(target: SpaceMountRecord | undefined, active: boolean) {
  const id = JSON.stringify(target), [refresh, setRefresh] = useState(0)
  const foreground = useWorkbenchDocumentVisibility(useWorkbenchDocument())
  useEffect(() => {
    if (!target || !active || !foreground) return
    const controller = new AbortController(), observe = useAppStore.getState().observeSpaceMount
    observe(target, { reading: true, error: undefined })
    let dispose: (() => void) | undefined
    void api.spaceMounts.watch({ hostId: target.hostId, reference: target.reference }, event => {
      if (controller.signal.aborted) return
      if (event.type === 'snapshot') observe(target, { snapshot: event.snapshot, reading: false, error: undefined })
      else observe(target, { reading: false, error: event.error.message })
    }, controller.signal).then(reply => {
      if (controller.signal.aborted) { reply.dispose(); return }
      dispose = reply.dispose
      observe(target, { snapshot: reply.initial, reading: false, error: undefined })
    }).catch(error => {
      if (!controller.signal.aborted) observe(target, { reading: false, error: error instanceof Error ? error.message : String(error) })
    })
    return () => { controller.abort(); dispose?.() }
  }, [id, active, foreground, refresh])
  useEffect(() => {
    if (!target || !active || !foreground) return
    const controller = new AbortController(), observe = useAppStore.getState().observeSpaceMountSessions
    observe(target, { begin: true })
    let dispose: (() => void) | undefined
    void api.spaceMounts.sessions({ hostId: target.hostId, reference: target.reference }, event => {
      if (controller.signal.aborted) return
      try { if (event.type === 'observation') observe(target, { observation: event.observation }); else observe(target, { error: event.error.message }) }
      catch (cause) { observe(target, { error: cause instanceof Error ? cause.message : String(cause) }) }
    }, controller.signal).then(reply => {
      if (controller.signal.aborted) { reply.dispose(); return }
      dispose = reply.dispose; observe(target, { opening: reply.initial })
    }).catch(cause => { if (!controller.signal.aborted) observe(target, { error: cause instanceof Error ? cause.message : String(cause) }) })
    return () => { controller.abort(); dispose?.() }
  }, [id, active, foreground, refresh])
  return () => setRefresh(value => value + 1)
}

