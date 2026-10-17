import type { AgentMuxDesktopSurface, RendererSurfaceSwitchCost } from '@agentmux/core/control'

/** Constant-size presentation observations only; no DOM reads, polling or control decisions. */
export function createSurfaceSwitchObservation(now = () => performance.now(), wall = Date.now,
  requestFrame = (callback: FrameRequestCallback) => requestAnimationFrame(callback),
  cancelFrame = (id: number) => cancelAnimationFrame(id),
  documentVisible = () => typeof document !== 'undefined' && document.visibilityState === 'visible') {
  const records: RendererSurfaceSwitchCost[] = []
  let serial = 0, active: RendererSurfaceSwitchCost | null = null
  // These are the root App's last committed observations, not a second navigation owner.
  let presentation: { surface: AgentMuxDesktopSurface; visible: boolean } | null = null
  let frame: number | null = null, generation = 0
  const cancel = () => { generation++; if (frame !== null) cancelFrame(frame); frame = null }
  const elapsed = (record: RendererSurfaceSwitchCost) => record.elapsedMs = Math.max(record.elapsedMs, 0, now() - record.handlerStartMonoMs)
  const finish = (state: 'observed' | 'superseded') => {
    if (!active) return
    elapsed(active); active.state = state; active.pendingStage = null
    cancel(); active = null
  }
  const presented = () => presentation?.surface === active?.to && presentation?.visible === true && documentVisible()
  function observe(): void {
    if (!active) return
    if (active.selectedMs === null) { active.pendingStage = 'selection'; return }
    if (!presented()) { cancel(); active.pendingStage = 'presentation'; return }
    active.pendingStage = 'frame'
    if (frame !== null) return
    const record = active, epoch = generation
    const current = () => epoch === generation && active === record && record.state === 'pending'
    frame = requestFrame(() => {
      if (!current()) return
      if (!presented()) { frame = null; record.pendingStage = 'presentation'; return }
      frame = requestFrame(() => {
        if (!current()) return
        frame = null
        if (!presented()) { record.pendingStage = 'presentation'; return }
        record.frameMs = elapsed(record); finish('observed')
      })
    })
  }
  return {
    begin(from: AgentMuxDesktopSurface, to: AgentMuxDesktopSurface, eventTimestamp: number | null, start = now()) {
      finish('superseded')
      const eventAtMonoMs = eventTimestamp !== null && Number.isFinite(eventTimestamp) && eventTimestamp > 0 && eventTimestamp <= start ? eventTimestamp : null
      const record: RendererSurfaceSwitchCost = { id: ++serial, source: 'footer-click', from, to,
        handlerAt: wall(), handlerStartMonoMs: start, eventAtMonoMs, inputDelayMs: eventAtMonoMs === null ? null : start - eventAtMonoMs,
        actionEndedMs: null, actionResult: null, selectedMs: null, selectedSource: null, frameMs: null,
        elapsedMs: 0, pendingStage: 'selection', state: 'pending' }
      if (records.length === 16) records.shift()
      records.push(record); active = record
      if (from === to && presentation?.surface === to) {
        record.selectedMs = elapsed(record); record.selectedSource = 'already-committed-handler'
      }
      observe()
      return record.id
    },
    actionEnded(id: number, result: NonNullable<RendererSurfaceSwitchCost['actionResult']>) {
      const record = records.find(record => record.id === id)
      if (!record || record.actionEndedMs !== null) return
      record.actionEndedMs = Math.max(0, now() - record.handlerStartMonoMs); record.actionResult = result
    },
    committed(surface: AgentMuxDesktopSurface, visible: boolean) {
      presentation = { surface, visible }
      if (!active) return
      if (active.to !== surface) {
        // An intermediate commit of the source cannot confirm the requested destination.
        if (active.selectedMs !== null || surface !== active.from) finish('superseded')
        return
      }
      if (active.selectedMs === null) { active.selectedMs = elapsed(active); active.selectedSource = 'layout-effect' }
      observe()
    },
    observe,
    ownerDeparted() { presentation = null; finish('superseded') },
    omitted: () => serial - records.length,
    snapshot(): RendererSurfaceSwitchCost[] {
      if (active) elapsed(active)
      return records.map(record => ({ ...record }))
    }
  }
}
export const surfaceSwitchObservation = createSurfaceSwitchObservation()
