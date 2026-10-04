import type { AgentMuxTerminalViewObservation } from '@agentmux/core/control'

type TerminalViewIdentity = { regionId: string; sessionId: string; runId: string }
type Reader = (identity: TerminalViewIdentity) => AgentMuxTerminalViewObservation | undefined

// This client owns callbacks only. Buffer, mode and input facts remain in the mounted terminal.
const readers = new Map<string, Reader>()

export function registerTerminalViewObservation(
  identity: TerminalViewIdentity,
  read: () => AgentMuxTerminalViewObservation | undefined
): () => void {
  const { regionId, sessionId, runId } = identity
  const reader: Reader = (target) => {
    if (target.sessionId !== sessionId || target.runId !== runId) return undefined
    const observed = read()
    return observed?.runId === runId ? observed : undefined
  }
  readers.set(regionId, reader)
  return () => {
    if (readers.get(regionId) === reader) readers.delete(regionId)
  }
}

export function readTerminalViewObservation(identity: TerminalViewIdentity): AgentMuxTerminalViewObservation | undefined {
  try {
    return readers.get(identity.regionId)?.(identity)
  } catch {
    // An unavailable client projection is unknown; it cannot diagnose or interrupt the Run.
    return undefined
  }
}
