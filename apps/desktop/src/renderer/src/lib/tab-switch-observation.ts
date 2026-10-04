import type { RendererTabSwitchCost, RendererTabSwitchTarget, RendererTabSwitchTerminal } from '@agentmux/core/control'

const key = (target: RendererTabSwitchTarget) => JSON.stringify([target.presentationId, target.displayWorkspaceId, target.groupId, target.tabId, target.regionId])
/** A local frame and an open input gate are observations, never paint or input acknowledgements. */
export function createTabSwitchObservation(now = () => performance.now(), wall = Date.now,
  requestFrame = (callback: FrameRequestCallback) => requestAnimationFrame(callback),
  cancelFrame = (id: number) => cancelAnimationFrame(id)) {
  const records: RendererTabSwitchCost[] = []
  const placements = new Map<string, Set<() => boolean>>()
  const terminals = new Map<string, Set<() => RendererTabSwitchTerminal | null>>()
  let serial = 0, active: { record: RendererTabSwitchCost; key: string; start: number } | null = null
  let frame: number | null = null, frameGeneration = 0
  const cancel = () => { frameGeneration++; if (frame !== null) cancelFrame(frame); frame = null }
  const elapsed = () => Math.max(0, now() - active!.start)
  const matches = (target: RendererTabSwitchTarget) => active && active.record.target.tabId === target.tabId &&
    active.record.target.regionId === target.regionId && active.record.target.groupId === target.groupId &&
    active.record.target.displayWorkspaceId === target.displayWorkspaceId && active.record.target.presentationId === target.presentationId
  function readOne<T>(readers: Map<string, Set<() => T>>, target: string): T | undefined {
    const matches = readers.get(target)
    // An ambiguous occurrence is unknown; another retained View cannot sign for it.
    if (matches?.size !== 1) return undefined
    try { return matches.values().next().value!() } catch { return undefined }
  }
  function originalTerminal(facts: RendererTabSwitchTerminal): boolean {
    const previous = active?.record.terminal
    if (previous && (previous.sessionId !== facts.sessionId || previous.runId !== facts.runId)) {
      active!.record.state = 'superseded'; cancel(); active = null; return false
    }
    return true
  }
  function observe(): void {
    if (!active || active.record.state === 'superseded' || active.record.mode !== 'terminal') return
    const record = active.record
    const facts = readOne(terminals, active.key)
    if (facts && !originalTerminal(facts)) return
    if (readOne(placements, active.key) === true) record.placedMs ??= elapsed()
    if (facts) {
      record.terminal = { ...facts }
      if (facts.visible && facts.revealed) record.terminalMs ??= elapsed()
      if (facts.visible && facts.revealed && facts.acceptsInput) record.inputReadyMs ??= elapsed()
    }
    if (record.frameMs !== null && (record.inputReadyMs !== null || facts?.readOnly)) { active = null; return }
    if (record.selectedMs === null || record.placedMs === null || record.terminalMs === null || record.frameMs !== null || frame !== null) return
    const generation = record.id, epoch = frameGeneration
    frame = requestFrame(() => {
      if (epoch !== frameGeneration || !active || active.record.id !== generation || active.record.state !== 'pending') return
      frame = requestFrame(() => {
        if (epoch !== frameGeneration || !active || active.record.id !== generation || active.record.state !== 'pending') return
        frame = null
        const current = readOne(terminals, active.key)
        if (current && !originalTerminal(current)) return
        if (!current?.visible || !current.revealed || readOne(placements, active.key) !== true) return
        record.terminal = { ...current }; record.frameMs = elapsed(); record.state = 'observed'
        if (current.acceptsInput) record.inputReadyMs ??= elapsed()
        if (current.acceptsInput || current.readOnly) active = null
      })
    })
  }
  function register<T>(readers: Map<string, Set<() => T>>, target: RendererTabSwitchTarget, read: () => T) {
    const address = key(target), owners = readers.get(address) ?? new Set<() => T>()
    owners.add(read); readers.set(address, owners)
    if (active?.key === address) observe()
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true; owners.delete(read)
      if (owners.size === 0) readers.delete(address)
      if (active?.key === address) cancel()
    }
  }
  return {
    begin(target: RendererTabSwitchTarget, mode: RendererTabSwitchCost['mode'], eventTimestamp: number | null) {
      cancel()
      if (active?.record.state === 'pending') active.record.state = 'superseded'
      const start = now()
      const inputDelayMs = eventTimestamp !== null && Number.isFinite(eventTimestamp) && eventTimestamp > 0 && eventTimestamp <= start
        ? start - eventTimestamp : null
      const record: RendererTabSwitchCost = { id: ++serial, target: { ...target }, handlerAt: wall(), inputDelayMs,
        selectedMs: null, placedMs: null, terminalMs: null, frameMs: null, inputReadyMs: null, state: 'pending', mode, terminal: null }
      if (records.length === 16) records.shift()
      records.push(record); active = { record, key: key(target), start }
      // The selected mode is a fact at this click. Activity is not a failed Terminal load.
      if (mode === 'activity' || mode === 'other') record.state = 'observed'
      observe()
      return record.id
    },
    selected(target: RendererTabSwitchTarget) {
      if (!active || !matches(target)) return
      active.record.selectedMs ??= elapsed()
      if (active.record.mode === 'activity' || active.record.mode === 'other') { active = null; return }
      observe()
    },
    observe(target: RendererTabSwitchTarget) { if (matches(target)) observe() },
    registerPlacement(target: RendererTabSwitchTarget, read: () => boolean) { return register(placements, target, read) },
    registerTerminal(target: RendererTabSwitchTarget, read: () => RendererTabSwitchTerminal | null) { return register(terminals, target, read) },
    omitted(): number { return serial - records.length },
    snapshot(): RendererTabSwitchCost[] { return records.map(record => ({ ...record, target: { ...record.target }, terminal: record.terminal ? { ...record.terminal } : null })) }
  }
}
export const tabSwitchObservation = createTabSwitchObservation()
