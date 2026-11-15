import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { AgentMuxEvidence, AgentMuxNativeService } from '@agentmux/core'
import type { RuntimeEvent, TerminalSessionSnapshot } from '../../../shared/contracts'

type Listener = () => void
type Entry = { service: AgentMuxNativeService | null; evidence: AgentMuxEvidence | null; health: string; version: number }
type RunServiceSession = Pick<TerminalSessionSnapshot, 'hostId' | 'nativeService'> & (
  Pick<Extract<TerminalSessionSnapshot, { kind: 'agent' }>, 'kind' | 'control'> |
  Pick<Extract<TerminalSessionSnapshot, { kind: 'terminal' }>, 'kind' | 'control'>
)
function targetKey(session: RunServiceSession): string {
  return JSON.stringify([session.hostId, session.control.hostId, session.kind === 'agent' ? session.control.agentSessionId : null, session.control.run.runId])
}
function serviceHealth(service: AgentMuxNativeService | null): string {
  return JSON.stringify([service?.owner, service?.output, service?.input.phase, service?.terminalFault])
}

/** Read-only projection of Core facts. Progress advances the full revision without waking UI consumers.
 * Membership is reconciled only when the ordinary Session collection changes, never per service event. */
export function createRunServiceProjection() {
  const entries = new Map<string, Entry>()
  let collectionKeys = new Set<string>()
  const listeners = new Map<string, Set<Listener>>()
  const globalListeners = new Set<Listener>()
  let version = 0
  const notify = (key: string): void => {
    ++version
    for (const listener of listeners.get(key) ?? []) listener()
    for (const listener of globalListeners) listener()
  }
  const update = (key: string, service: AgentMuxNativeService | null, evidence: AgentMuxEvidence | null = null): void => {
    const previous = entries.get(key)
    if (previous && (!service || (previous.service && service.revision <= previous.service.revision))) return
    const health = serviceHealth(service)
    const changed = !previous || previous.health !== health
    entries.set(key, { service, evidence, health, version: changed ? version + 1 : previous.version })
    if (changed) notify(key)
  }
  const healthVersion = (key: string | null): number => key === null ? 0 : entries.get(key)?.version ?? 0
  const subscribe = (key: string | null, seed: AgentMuxNativeService | null, listener: Listener): (() => void) => {
    if (key === null) return () => {}
    let subscribers = listeners.get(key)
    if (!subscribers) listeners.set(key, subscribers = new Set())
    subscribers.add(listener)
    // A mounted terminal can belong to a host tool rather than a workbench Tab.
    // Its explicit reader retains the same Core service projection, without a fake Session entry.
    update(key, seed)
    return () => {
      subscribers.delete(listener)
      if (!subscribers.size) {
        listeners.delete(key)
        if (!collectionKeys.has(key)) { entries.delete(key); notify(key) }
      }
    }
  }
  return {
    observeSnapshot(session: RunServiceSession): void {
      if (session.hostId !== session.control.hostId) return
      const key = targetKey(session)
      if (entries.has(key)) update(key, session.nativeService ?? null)
    },
    reconcile(sessions: readonly TerminalSessionSnapshot[]): void {
      const retained = new Set<string>()
      for (const session of sessions) {
        if (session.hostId !== session.control.hostId) continue
        const key = targetKey(session)
        retained.add(key)
        update(key, session.nativeService ?? null)
      }
      collectionKeys = retained
      for (const key of entries.keys()) if (!retained.has(key) && !listeners.has(key)) {
        entries.delete(key)
        notify(key)
      }
    },
    apply(event: RuntimeEvent): boolean {
      const core = event.event
      if (core.type !== 'run-service') return false
      const key = JSON.stringify([event.hostId, event.hostId, core.agentSessionId ?? null, core.run.runId])
      if (!entries.has(key)) return false
      update(key, core.nativeService, core.evidence)
      return true
    },
    read(session: RunServiceSession): AgentMuxNativeService | null {
      return entries.get(targetKey(session))?.service ?? null
    },
    evidence(session: TerminalSessionSnapshot): AgentMuxEvidence | null {
      return entries.get(targetKey(session))?.evidence ?? null
    },
    healthVersion(session?: TerminalSessionSnapshot): number {
      return healthVersion(session ? targetKey(session) : null)
    },
    globalVersion: (): number => version,
    subscribe(session: TerminalSessionSnapshot | undefined, listener: Listener): () => void {
      return subscribe(session && session.hostId === session.control.hostId ? targetKey(session) : null, session?.nativeService ?? null, listener)
    },
    reader(session: RunServiceSession | undefined) {
      const key = session ? targetKey(session) : null
      // Stable hook callbacks retain only this exact key and its original seed.
      // A callback handed to the previous Run must never target a later Run.
      return {
        subscribe: subscribe.bind(null, session && session.hostId === session.control.hostId ? key : null, session?.nativeService ?? null),
        snapshot: healthVersion.bind(null, key)
      }
    },
    subscribeAll(listener: Listener): () => void {
      globalListeners.add(listener)
      return () => { globalListeners.delete(listener) }
    },
    clear(): void {
      collectionKeys.clear()
      for (const key of entries.keys()) { entries.delete(key); notify(key) }
    }
  }
}

export const runServiceProjection = createRunServiceProjection()

export type RunServiceProjection = ReturnType<typeof createRunServiceProjection>

export function useRunService(session: RunServiceSession | undefined, projection: RunServiceProjection = runServiceProjection): AgentMuxNativeService | null {
  const key = session ? targetKey(session) : null
  const reader = useMemo(() => projection.reader(session), [key, projection])
  useSyncExternalStore(reader.subscribe, reader.snapshot)
  useEffect(() => { if (session) projection.observeSnapshot(session) }, [key, session?.nativeService, projection])
  return session ? projection.read(session) : null
}

export function useRunServiceHealthChanges(): number {
  return useSyncExternalStore(runServiceProjection.subscribeAll, runServiceProjection.globalVersion)
}
