import { useCallback, useSyncExternalStore } from 'react'
import type { AgentMuxNativeService } from '@agentmux/core'
import type { RuntimeEvent, SessionSnapshot } from '../../../shared/contracts'

type Listener = () => void
type Entry = { service: AgentMuxNativeService | null; health: string; version: number }
function targetKey(session: SessionSnapshot): string {
  return JSON.stringify([session.hostId, session.control.hostId, session.kind === 'agent' ? session.control.agentSessionId : null, session.control.run.runId])
}
function serviceHealth(service: AgentMuxNativeService | null): string {
  return JSON.stringify([service?.owner, service?.output, service?.input.phase, service?.terminalFault])
}

/** Read-only projection of Core facts. Progress advances the full revision without waking UI consumers.
 * Membership is reconciled only when the ordinary Session collection changes, never per service event. */
export function createRunServiceProjection() {
  const entries = new Map<string, Entry>()
  const listeners = new Map<string, Set<Listener>>()
  const globalListeners = new Set<Listener>()
  let version = 0
  const notify = (key: string): void => {
    ++version
    for (const listener of listeners.get(key) ?? []) listener()
    for (const listener of globalListeners) listener()
  }
  const update = (key: string, service: AgentMuxNativeService | null): void => {
    const previous = entries.get(key)
    if (previous && (!service || (previous.service && service.revision <= previous.service.revision))) return
    const health = serviceHealth(service)
    const changed = !previous || previous.health !== health
    entries.set(key, { service, health, version: changed ? version + 1 : previous.version })
    if (changed) notify(key)
  }
  return {
    reconcile(sessions: readonly SessionSnapshot[]): void {
      const retained = new Set<string>()
      for (const session of sessions) {
        if (session.hostId !== session.control.hostId) continue
        const key = targetKey(session)
        retained.add(key)
        update(key, session.nativeService ?? null)
      }
      for (const key of entries.keys()) if (!retained.has(key)) {
        entries.delete(key)
        notify(key)
      }
    },
    apply(event: RuntimeEvent): boolean {
      const core = event.event
      if (core.type !== 'run-service') return false
      const key = JSON.stringify([event.hostId, event.hostId, core.agentSessionId ?? null, core.run.runId])
      if (!entries.has(key)) return false
      update(key, core.nativeService)
      return true
    },
    read(session: SessionSnapshot): AgentMuxNativeService | null {
      return entries.get(targetKey(session))?.service ?? null
    },
    healthVersion(session?: SessionSnapshot): number {
      return session ? entries.get(targetKey(session))?.version ?? 0 : 0
    },
    globalVersion: (): number => version,
    subscribe(session: SessionSnapshot | undefined, listener: Listener): () => void {
      if (!session) return () => {}
      const key = targetKey(session)
      let subscribers = listeners.get(key)
      if (!subscribers) listeners.set(key, subscribers = new Set())
      subscribers.add(listener)
      return () => {
        subscribers.delete(listener)
        if (!subscribers.size) listeners.delete(key)
      }
    },
    subscribeAll(listener: Listener): () => void {
      globalListeners.add(listener)
      return () => { globalListeners.delete(listener) }
    },
    clear(): void {
      for (const key of entries.keys()) { entries.delete(key); notify(key) }
    }
  }
}

export const runServiceProjection = createRunServiceProjection()

export function useRunService(session: SessionSnapshot | undefined): AgentMuxNativeService | null {
  const key = session ? targetKey(session) : null
  const subscribe = useCallback((listener: Listener) => runServiceProjection.subscribe(session, listener), [key])
  const snapshot = useCallback(() => runServiceProjection.healthVersion(session), [key])
  useSyncExternalStore(subscribe, snapshot)
  return session ? runServiceProjection.read(session) : null
}

export function useRunServiceHealthChanges(): void {
  useSyncExternalStore(runServiceProjection.subscribeAll, runServiceProjection.globalVersion)
}
