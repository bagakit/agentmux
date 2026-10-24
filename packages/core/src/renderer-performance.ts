import type { InputPerformanceSnapshot } from './performance-diagnostics.js'
import type { AgentMuxDesktopSurface } from './desktop-focus-control.js'
import type { AgentMuxClientEvent } from './types.js'

/** Bounded renderer flight recorder. Durations are wall time, never CPU or input ACK. */
export type RendererWorkTiming = { count: number; totalMs: number; maxMs: number }
/** Fixed protocol discriminants only: caller text must be aggregated as unknown. */
export const RENDERER_SESSION_EVENT_TYPES = {
  'agent-message-changed': true, 'agent-message-observation': true, 'dispatch-changed': true,
  'agent-input': true, 'agent-input-recorded': true, 'control-endpoint-state': true,
  'attachment-state': true, 'run-service': true, 'terminal-snapshot': true, 'terminal-resized': true,
  'terminal-output': true, 'process-state': true, 'agent-status': true, 'agent-timeline': true,
  interaction: true, 'agent-session': true, 'agent-lifecycle-observed': true, 'run-removed': true, 'agent-error': true,
  'connection-state': true, unknown: true
} as const satisfies Record<AgentMuxClientEvent['type'] | 'unknown', true>
export type RendererSessionEventType = keyof typeof RENDERER_SESSION_EVENT_TYPES
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
/** This terminal instance's lifetime writes. Callback wait overlaps other work; it is not CPU. */
export type RendererTerminalWriteCost = {
  started: number; completed: number; bytes: number; stringCodeUnits: number
  callbackWall: RendererWorkTiming
}
export type RendererTerminalCost = {
  hostId: string; sessionId: string; runId: string; regionId: string | null; instanceId: number
  writes: Record<RendererTerminalWriteContext['cause'], RendererTerminalWriteCost>
  renderCallbacks: number
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
  /** Wall-clock recorder begin; the handler's precise start uses the local monotonic clock below. */
  handlerAt: number
  /** Same-Window trusted event timestamp, otherwise unknown. Never compare across processes. */
  eventAtMonoMs: number | null
  handlerStartMonoMs: number
  /** Synchronous action tail; may follow selected/superseded elapsedMs. Returned includes normal refusal. */
  actionEndedMs: number | null
  actionResult: 'returned' | 'threw' | null
  selectedSource: 'already-selected-handler' | 'layout-effect' | null
  inputDelayMs: number | null; selectedMs: number | null; placedMs: number | null; terminalMs: number | null
  /** First observed open input gate for this selection, not input response or acknowledgement. */
  inputReadyMs: number | null
  /** A local Renderer frame observation, not compositor presentation or input acknowledgement. */
  frameMs: number | null
  state: 'pending' | 'observed' | 'superseded'; mode: 'unknown' | 'terminal' | 'activity' | 'other'
  terminal: RendererTabSwitchTerminal | null
}
/** Exact footer activation. This record observes presentation; it grants no input capability. */
export type RendererSurfaceSwitchCost = {
  id: number; source: 'footer-click'; from: AgentMuxDesktopSurface; to: AgentMuxDesktopSurface
  handlerAt: number; handlerStartMonoMs: number; eventAtMonoMs: number | null; inputDelayMs: number | null
  /** Synchronous action tail; returned includes a normal refusal and does not prove selection. */
  actionEndedMs: number | null; actionResult: 'returned' | 'threw' | null
  /** Root App layout commit, or the same target already committed before this handler. */
  selectedMs: number | null; selectedSource: 'layout-effect' | 'already-committed-handler' | null
  /** Two local rAF callbacks after selection, not compositor presentation, complete readable content or input ACK. */
  frameMs: number | null
  /** Monotonic elapsed from this handler; freezes when this occurrence ends. */
  elapsedMs: number; pendingStage: 'selection' | 'presentation' | 'frame' | null
  state: 'pending' | 'observed' | 'superseded'
}
export const RENDERER_TIMING_KINDS = ['session-event', 'terminal-write', 'long-task', 'input-delay', 'terminal-interaction', 'terminal-cleanup'] as const
export type RendererTimingKind = typeof RENDERER_TIMING_KINDS[number]
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
  cleanup: RendererTerminalCleanupContext | null
  /** Detached occurrence/start identity for Session work or terminal input; never inferred from later focus. */
  source: RendererWorkSource | null
}
export type RendererWorkSource = {
  hostId: string; sessionId: string | null; runId: string | null; regionId: string | null; instanceId: number | null
}
/** Synchronous call observation only; returned does not acknowledge asynchronous resource release. */
export type RendererTerminalCleanupContext = {
  hostId: string; sessionId: string; runId: string; regionId: string | null; instanceId: number
  operation: 'webgl-dispose' | 'xterm-dispose'; outcome: 'returned' | 'threw'
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
  /** Lifetime inclusive synchronous applyEvent work, including subscribers; excludes later scheduled work. */
  sessionEvents: RendererWorkTiming & { byType: Record<RendererSessionEventType, RendererWorkTiming> }
  terminalWrites: { visible: RendererWorkTiming; hidden: RendererWorkTiming; stringCodeUnits: number; bytes: number }
  inputDelay: { state: 'observing' | 'unsupported' | 'stopped' | 'unavailable'; reason: string | null; durationThresholdMs: 16; timing: RendererWorkTiming }
  longTasks: { state: 'observing' | 'unsupported' | 'stopped' | 'unavailable'; reason: string | null; timing: RendererWorkTiming }
  terminals: RendererTerminalCost[]; omittedTerminals: number; unavailableTerminals: number
  /** At most 16 recent exact-occurrence observations. Missing stages stay null. */
  tabSwitches: RendererTabSwitchCost[]
  tabSwitchesOmitted: number
  /** At most 16 original footer occurrences; non-footer navigation is not attributed to this source. */
  surfaceSwitches: RendererSurfaceSwitchCost[]
  surfaceSwitchesOmitted: number
  /** Latest four and current/previous epoch peaks per kind, deduplicated by id; <=36 detached records. */
  slowEvents: RendererSlowEvent[]
  slowEventsOmitted: Record<RendererTimingKind, number>
  timingEpochs: RendererTimingEpochs
  observerCost: { snapshots: RendererWorkTiming; performanceCallbacks: RendererWorkTiming }
}
