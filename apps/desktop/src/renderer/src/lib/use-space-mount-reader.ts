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
    const controller = new AbortController(), state = useAppStore.getState()
    const observe = state.observeSpaceMount, observeSessions = state.observeSpaceMountSessions
    let generation = 0, spaceGeneration = 0, sessionsGeneration = 0, reopening = false
    const failed = new Set<'space' | 'sessions'>()
    const reopen = () => {
      if (controller.signal.aborted || reopening) return
      reopening = true
      setRefresh(value => value + 1)
    }
    // Connection recovery permits another original read; it is no source-health
    // receipt and never replays a business operation or an Agent input.
    const unsubscribe = api.sessions.onEvent(event => {
      if (event.hostId !== target.hostId || controller.signal.aborted) return
      const original = event.event
      if (!(original.type === 'connection-state' && original.state === 'restored') &&
        !(original.type === 'session-observation-state' && original.observation.state === 'ready')) return
      generation++
      if (failed.size) reopen()
    }, { kind: 'host-observation', hostId: target.hostId })
    const fail = (kind: 'space' | 'sessions', error: unknown) => {
      if (controller.signal.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      failed.add(kind)
      if (kind === 'space') observe(target, { reading: false, error: message })
      else observeSessions(target, { error: message })
      // A ready event can precede the old opening's rejection. Consume that
      // opportunity once; the next attempt starts with a fresh generation.
      if (generation > (kind === 'space' ? spaceGeneration : sessionsGeneration)) reopen()
    }
    observe(target, { reading: true })
    observeSessions(target, { begin: true })
    let disposeSpace: (() => void) | undefined, disposeSessions: (() => void) | undefined
    void api.spaceMounts.watch({ hostId: target.hostId, reference: target.reference }, event => {
      if (controller.signal.aborted) return
      if (event.type === 'snapshot') {
        failed.delete('space')
        spaceGeneration = generation
        observe(target, { snapshot: event.snapshot, reading: false, error: undefined })
      } else fail('space', event.error.message)
    }, controller.signal).then(reply => {
      if (controller.signal.aborted || failed.has('space')) { reply.dispose(); return }
      disposeSpace = reply.dispose
      failed.delete('space')
      spaceGeneration = generation
      observe(target, { snapshot: reply.initial, reading: false, error: undefined })
    }).catch(error => fail('space', error))
    void api.spaceMounts.sessions({ hostId: target.hostId, reference: target.reference }, event => {
      if (controller.signal.aborted) return
      try {
        if (event.type === 'observation') {
          observeSessions(target, { observation: event.observation })
          failed.delete('sessions')
          sessionsGeneration = generation
        } else fail('sessions', event.error.message)
      } catch (cause) { fail('sessions', cause) }
    }, controller.signal).then(reply => {
      if (controller.signal.aborted || failed.has('sessions')) { reply.dispose(); return }
      disposeSessions = reply.dispose
      observeSessions(target, { opening: reply.initial })
      failed.delete('sessions')
      sessionsGeneration = generation
    }).catch(cause => fail('sessions', cause))
    return () => { controller.abort(); unsubscribe(); disposeSpace?.(); disposeSessions?.() }
  }, [id, active, foreground, refresh])
  return () => setRefresh(value => value + 1)
}

