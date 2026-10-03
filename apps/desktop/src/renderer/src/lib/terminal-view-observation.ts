import type { AgentMuxTerminalViewObservation } from '@agentmux/core/control'

type TerminalViewIdentity = { regionId: string; sessionId: string; runId: string }
type ObservationReader = (identity: TerminalViewIdentity) => AgentMuxTerminalViewObservation | undefined
export type TerminalInputGeometry = {
  readOverlapTop(element: HTMLElement, popup: DOMRect): number | undefined
  subscribe(element: HTMLElement, onChange: () => void): () => void
}
type Reader = { observation: ObservationReader; inputGeometry?: TerminalInputGeometry }
type Region = { reader?: Reader; consumers: Set<() => void> }

// This client owns callbacks only. Buffer, mode and input facts remain in the mounted terminal.
const readers = new Map<string, Region>()
function regionOwner(regionId: string): Region {
  let region = readers.get(regionId)
  if (!region) { region = { consumers: new Set() }; readers.set(regionId, region) }
  return region
}
function notifyConsumers(region: Region) {
  for (const changed of region.consumers) {
    try { changed() } catch { /* A presentation observer cannot interrupt terminal registration. */ }
  }
}
function releaseEmptyRegion(regionId: string, region: Region) {
  if (!region.reader && !region.consumers.size && readers.get(regionId) === region) readers.delete(regionId)
}

export function registerTerminalViewObservation(
  identity: TerminalViewIdentity,
  read: () => AgentMuxTerminalViewObservation | undefined,
  inputGeometry?: TerminalInputGeometry
): () => void {
  const { regionId, sessionId, runId } = identity
  const region = regionOwner(regionId)
  const observation: ObservationReader = (target) => {
    if (target.sessionId !== sessionId || target.runId !== runId) return undefined
    const observed = read()
    return observed?.runId === runId ? observed : undefined
  }
  const reader: Reader = { observation, ...(inputGeometry ? { inputGeometry: {
    readOverlapTop: (element, popup) => read()?.runId === runId ? inputGeometry.readOverlapTop(element, popup) : undefined,
    subscribe: (element, onChange) => read()?.runId === runId
      ? inputGeometry.subscribe(element, () => { if (region.reader === reader && read()?.runId === runId) onChange() })
      : () => {}
  } } : {}) }
  region.reader = reader
  notifyConsumers(region)
  return () => {
    if (region.reader !== reader) return
    delete region.reader
    notifyConsumers(region)
    releaseEmptyRegion(regionId, region)
  }
}

export function readTerminalViewObservation(identity: TerminalViewIdentity): AgentMuxTerminalViewObservation | undefined {
  try {
    return readers.get(identity.regionId)?.reader?.observation(identity)
  } catch {
    // An unavailable client projection is unknown; it cannot diagnose or interrupt the Run.
    return undefined
  }
}

/** Presentation only: one mounted Region and its actual terminal element, never all Sessions. */
export function readTerminalInputOverlapTop(regionId: string, element: HTMLElement, popup: DOMRect): number | undefined {
  const region = readers.get(regionId), reader = region?.reader
  try {
    const top = reader?.inputGeometry?.readOverlapTop(element, popup)
    return region?.reader === reader ? top : undefined
  } catch { return undefined }
}

export function observeTerminalInputGeometry(regionId: string, element: HTMLElement, onChange: () => void): () => void {
  const region = regionOwner(regionId)
  let stop = () => {}
  const rebind = () => {
    stop()
    try { stop = region.reader?.inputGeometry?.subscribe(element, onChange) ?? (() => {}) }
    catch { stop = () => {} }
    onChange()
  }
  region.consumers.add(rebind)
  rebind()
  return () => { region.consumers.delete(rebind); stop(); releaseEmptyRegion(regionId, region) }
}
