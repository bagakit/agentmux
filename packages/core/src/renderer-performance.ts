import type { InputPerformanceSnapshot } from './performance-diagnostics.js'

/** Bounded renderer flight recorder. Durations are wall time, never CPU or input ACK. */
export type RendererWorkTiming = { count: number; totalMs: number; maxMs: number }
export type RendererOverlayObservation = {
  reason: 'initial' | 'demand' | 'mutation' | 'resize' | 'scroll' | 'toggle' | 'font' | 'collect'
  scheduled: boolean; coalesced: boolean; nativeDemandCount: number | null
  candidateCount?: number; geometryReadCount?: number; collectMs?: number
}
export type RendererOverlayCost = {
  triggers: Record<RendererOverlayObservation['reason'], number>
  scheduled: number; coalesced: number; candidates: number; geometryReads: number
  nativeDemandCount: number | null; latestCandidates: number | null; latestGeometryReads: number | null
  collect: RendererWorkTiming
}
export type RendererInputRequestCost = { started: number; completed: number; failed: number; pending: number; wall: RendererWorkTiming }
export type RendererConsumerCost = { checks: number; changes: number; commits: number }
export type RendererVisibilityCost = { visible: RendererConsumerCost; hidden: RendererConsumerCost }
export type RendererTerminalCost = {
  sessionId: string; runId: string; regionId: string | null
  visible: boolean; visibleSinceAt: number | null; readySinceAt: number | null
  revealed: boolean; liveReady: boolean; acceptsInput: boolean; replaying: boolean
  inFlightWrites: number; queuedItems: number; queuedBytes: number; pendingItems: number; pendingBytes: number
  cols: number; rows: number; normalLines: number; alternateLines: number
  interaction: {
    observedSinceAt: number
    keydown: { count: number; unknownDelayCount: number; delay: RendererWorkTiming }
    wheel: { count: number; unknownDelayCount: number; delay: RendererWorkTiming }
    /** User onData/onBinary sessions.write Promise completion; excludes protocol replies and paste. Never PTY ACK, processing or echo. */
    writeRequests: { started: number; completed: number; failed: number; pending: number; wall: RendererWorkTiming; lastStartedAt: number | null; lastSettledAt: number | null }
    lastEvent: { kind: 'keydown' | 'wheel'; observedAt: number; delayMs: number | null; visible: boolean;
      liveReady: boolean; acceptsInput: boolean; readOnly: boolean; buffer: 'normal' | 'alternate'; mouseTrackingMode: string } | null
  }
}
export type RendererTabSwitchTarget = {
  displayWorkspaceId: string; groupId: string; tabId: string; regionId: string; presentationId: string
}
export type RendererTabSwitchTerminal = {
  sessionId: string; runId: string; readySinceAt: number | null
  visible: boolean; revealed: boolean; liveReady: boolean
  /** The current input gate, not an input response or Runtime acknowledgement. */
  acceptsInput: boolean
  readOnly: boolean; replaying: boolean
}
export type RendererTabSwitchCost = {
  id: number; target: RendererTabSwitchTarget
  /** Monotonic elapsed from this handler; freezes when this occurrence ends. */
  elapsedMs: number
  pendingStage: 'selection' | 'placement' | 'terminal' | 'frame' | 'input-gate' | null
  /** Wall-clock handler timestamp. Phase durations below use monotonic elapsed time. */
  handlerAt: number
  inputDelayMs: number | null; selectedMs: number | null; placedMs: number | null; terminalMs: number | null
  /** First observed open input gate for this selection, not input response or acknowledgement. */
  inputReadyMs: number | null
  /** A local Renderer frame observation, not compositor presentation or input acknowledgement. */
  frameMs: number | null
  state: 'pending' | 'observed' | 'superseded'; mode: 'unknown' | 'terminal' | 'activity' | 'other'
  terminal: RendererTabSwitchTerminal | null
}
export type RendererTimingKind = 'session-event' | 'terminal-write' | 'long-task' | 'input-delay' | 'terminal-interaction'
export type RendererTimingEpoch = {
  startMonoMs: number; endMonoMs: number; timings: Record<RendererTimingKind, RendererWorkTiming>
}
export type RendererTimingEpochs = {
  durationMs: 10000; basis: 'monotonic-occurrence-start'
  /** First epoch may have partial coverage; combine with observer support/state. */
  recordingSinceMonoMs: number; observedMonoMs: number
  current: RendererTimingEpoch; previous: RendererTimingEpoch | null
  late: Record<RendererTimingKind, number>; unknown: Record<RendererTimingKind, number>
}
export type RendererSlowEvent = {
  id: number; kind: RendererTimingKind; detail: string; observedAt: number; durationMs: number
  /** Local Renderer Performance API timebase, never comparable across processes. */
  occurredAtMonoMs: number | null; deliveredAtMonoMs: number
  retainedAs: Array<'latest' | 'current-peak' | 'previous-peak'>
  terminal: (RendererTerminalWriteContext & { payload: { unit: 'bytes' | 'string-code-units'; length: number } }) | null
}
/** Captured when a parser write begins, never inferred from focus or completion state. */
export type RendererTerminalWriteContext = {
  hostId: string; sessionId: string; runId: string; regionId: string | null; instanceId: number
  cause: 'live' | 'history' | 'checkpoint'
}
export type RendererPerformanceSnapshot = {
  startedAt: number; observedAt: number
  recording: 'bounded-lifetime'; selectorTiming: 'counts-only'; writeTiming: 'parser-callback-wall'
  consumers: { composer: RendererVisibilityCost; sessionPane: RendererVisibilityCost }
  inputRequests: Record<'user' | 'protocol' | 'paste', RendererInputRequestCost>
  inputRequestDetails: InputPerformanceSnapshot
  overlay: RendererOverlayCost
  sessionEvents: RendererWorkTiming
  terminalWrites: { visible: RendererWorkTiming; hidden: RendererWorkTiming; stringCodeUnits: number; bytes: number }
  inputDelay: { state: 'observing' | 'unsupported' | 'stopped' | 'unavailable'; reason: string | null; durationThresholdMs: 16; timing: RendererWorkTiming }
  longTasks: { state: 'observing' | 'unsupported' | 'stopped' | 'unavailable'; reason: string | null; timing: RendererWorkTiming }
  terminals: RendererTerminalCost[]; omittedTerminals: number; unavailableTerminals: number
  /** At most 16 recent exact-occurrence observations. Missing stages stay null. */
  tabSwitches: RendererTabSwitchCost[]
  tabSwitchesOmitted: number
  /** Latest four and current/previous epoch peaks per kind, deduplicated by id; <=30 detached records. */
  slowEvents: RendererSlowEvent[]
  slowEventsOmitted: Record<RendererTimingKind, number>
  timingEpochs: RendererTimingEpochs
  observerCost: { snapshots: RendererWorkTiming; performanceCallbacks: RendererWorkTiming }
}
