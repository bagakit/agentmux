import type { AgentMuxAttachmentGapObservation, AgentMuxOutputGapCauses } from '../../src/types.js'
import type { AttachmentGapEvent } from '@ctxmux/sdk'

/** Explicit synthetic transport facts; never presented as a real Runtime trigger. */
export function gapFacts(runId: string, origin: 'unknown' | 'daemon' | 'client' | 'mixed' = 'unknown') {
  const daemon = origin !== 'client', client = origin === 'client' || origin === 'mixed'
  const causes: AgentMuxOutputGapCauses = { liveEventPressure: false, subscriberLag: false,
    sourceDiscontinuity: origin === 'daemon' || origin === 'mixed', terminalCatchup: false,
    geometryLag: false, clientViewPressure: client, unknown: origin === 'unknown' }
  const observation: AgentMuxAttachmentGapObservation = {
    attachmentId: 'private-attachment', runtime: { runtimeId: 'private-runtime', daemonInstanceId: 'private-native' }, runId,
    origins: { daemon, client }, firstObservedAtUnixMs: 100, lastObservedAtUnixMs: 110, deliveredAtUnixMs: 120,
    receivedOutputHeadByte: 23, deliveredThroughByte: 4, requestedAfterByte: 2, recoveryAfterByte: 4,
    missingOutputBytes: daemon ? null : 19,
    queue: { payloadBudgetBytes: 32, envelopeBudgetBytes: 4096, retainedPayloadBytes: 4,
      retainedEnvelopeBytes: 123, payloadHighWaterBytes: 8, envelopeHighWaterBytes: 256 },
    localPressure: client ? { payloadLimitHit: true, envelopeLimitHit: false, attemptedPayloadBytes: 19,
      attemptedEnvelopeBytes: 191, droppedOutputBytes: 19, countersSaturated: false } : null
  }
  return { causes, observation }
}
export function sdkGap(runId: string, origin: 'unknown' | 'daemon' | 'client' | 'mixed' = 'unknown'): AttachmentGapEvent {
  const { causes: c, observation } = gapFacts(runId, origin)
  return { type: 'gap', latest_output_bytes: 27, observation, causes: {
    live_event_pressure: c.liveEventPressure, subscriber_lag: c.subscriberLag, source_discontinuity: c.sourceDiscontinuity,
    terminal_catchup: c.terminalCatchup, geometry_lag: c.geometryLag, client_view_pressure: c.clientViewPressure, unknown: c.unknown
  } }
}
