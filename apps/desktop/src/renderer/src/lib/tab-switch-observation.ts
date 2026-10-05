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
  const elapsed = () => active!.record.elapsedMs = Math.max(active!.record.elapsedMs, 0, now() - active!.start)
  const finish = (state: 'observed' | 'superseded') => {
    if (!active) return
    elapsed(); active.record.state = state; active.record.pendingStage = null
    cancel(); active = null
  }
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
      finish('superseded'); return false
    }
    return true
  }
  function observe(): void {
    if (!active || active.record.state !== 'pending' || active.record.mode !== 'terminal') return
    const record = active.record
    const facts = readOne(terminals, active.key)
    if (facts && !originalTerminal(facts)) return
    const placed = readOne(placements, active.key) === true
    if (placed) record.placedMs ??= elapsed()
    if (facts) {
      record.terminal = { ...facts }
      if (facts.visible && facts.revealed) record.terminalMs ??= elapsed()
      if (facts.visible && facts.revealed && facts.acceptsInput) record.inputReadyMs ??= elapsed()
    }
    record.pendingStage = record.selectedMs === null ? 'selection' : !placed ? 'placement' :
      !facts?.visible || !facts.revealed ? 'terminal' : record.frameMs === null ? 'frame' : 'input-gate'
    if (record.frameMs !== null && placed && facts?.visible && facts.revealed && (facts.acceptsInput || facts.readOnly)) { finish('observed'); return }
    if (record.selectedMs === null || !placed || !facts?.visible || !facts.revealed || record.frameMs !== null || frame !== null) return
    const generation = record.id, epoch = frameGeneration
    frame = requestFrame(() => {
      if (epoch !== frameGeneration || !active || active.record.id !== generation || active.record.state !== 'pending') return
      frame = requestFrame(() => {
        if (epoch !== frameGeneration || !active || active.record.id !== generation || active.record.state !== 'pending') return
        frame = null
        const current = readOne(terminals, active.key)
        if (current && !originalTerminal(current)) return
        const placed = readOne(placements, active.key) === true
        if (!placed || !current?.visible || !current.revealed) {
          record.pendingStage = !placed ? 'placement' : 'terminal'; return
        }
        record.terminal = { ...current }; record.frameMs = elapsed(); record.pendingStage = 'input-gate'
        if (current.acceptsInput) record.inputReadyMs ??= elapsed()
        if (current.acceptsInput || current.readOnly) finish('observed')
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
      if (active?.key === address) {
        if (owners.size === 0) finish('superseded')
        else { cancel(); observe() }
      }
    }
  }
  return {
    begin(target: RendererTabSwitchTarget, mode: RendererTabSwitchCost['mode'], eventTimestamp: number | null) {
      finish('superseded'); cancel()
      const start = now()
      const inputDelayMs = eventTimestamp !== null && Number.isFinite(eventTimestamp) && eventTimestamp > 0 && eventTimestamp <= start
        ? start - eventTimestamp : null
      const record: RendererTabSwitchCost = { id: ++serial, target: { ...target }, handlerAt: wall(), inputDelayMs,
        selectedMs: null, placedMs: null, terminalMs: null, frameMs: null, inputReadyMs: null,
        elapsedMs: 0, pendingStage: 'selection', state: 'pending', mode, terminal: null }
      if (records.length === 16) records.shift()
      records.push(record); active = { record, key: key(target), start }
      observe()
      return record.id
    },
    selected(target: RendererTabSwitchTarget) {
      if (!active || !matches(target)) return
      active.record.selectedMs ??= elapsed()
      // The selected mode is a fact at this click. Activity is not a failed Terminal load.
      if (active.record.mode === 'activity' || active.record.mode === 'other') { finish('observed'); return }
      active.record.pendingStage = 'terminal'
      observe()
    },
    observe(target: RendererTabSwitchTarget) { if (matches(target)) observe() },
    registerPlacement(target: RendererTabSwitchTarget, read: () => boolean) { return register(placements, target, read) },
    registerTerminal(target: RendererTabSwitchTarget, read: () => RendererTabSwitchTerminal | null) { return register(terminals, target, read) },
    omitted(): number { return serial - records.length },
    snapshot(): RendererTabSwitchCost[] {
      if (active) elapsed()
      return records.map(record => ({ ...record, target: { ...record.target }, terminal: record.terminal ? { ...record.terminal } : null }))
    }
  }
}
export const tabSwitchObservation = createTabSwitchObservation()
