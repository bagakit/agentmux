import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { AgentMuxEvidence } from './types.js'

const fail = (): never => { throw new AgentMuxError('Invalid output Gap observation.', 'CONTROL_PROTOCOL_ERROR') }
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  return rpcRecord(value, fields, 'CONTROL_PROTOCOL_ERROR')
}
function count(value: unknown, nullable = false): void {
  if (nullable && value === null) return
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail()
}
function string(value: unknown): void { if (typeof value !== 'string' || !value || /[\0\r\n]/u.test(value)) fail() }
function bool(value: unknown): void { if (typeof value !== 'boolean') fail() }

/** Validate the original Gap DTO at the receiving RPC edge; never synthesize missing owner facts. */
export function parseOutputGapEvidence(value: unknown): AgentMuxEvidence {
  const evidence = record(value, ['source', 'observedAt', 'run', 'outputGap', 'outputByteRange', 'hookReceiptId', 'acpAdapterId', 'acpSessionId'])
  if (!['terminal-output', 'run-process', 'native-hook', 'acp', 'user', 'agentmux'].includes(String(evidence.source))) fail()
  count(evidence.observedAt)
  const run = evidence.run === undefined ? undefined : record(evidence.run, ['runId'])
  if (run) string(run.runId)
  if (evidence.outputGap === undefined) return evidence as AgentMuxEvidence
  if (!run || evidence.source !== 'terminal-output') fail()
  const gap = rpcRecord(evidence.outputGap, undefined, 'CONTROL_PROTOCOL_ERROR')
  count(gap.latestOutputBytes)
  if (gap.kind === 'replay') {
    record(gap, ['kind', 'latestOutputBytes', 'requestedAfterByte', 'firstAvailableByte'])
    count(gap.requestedAfterByte); count(gap.firstAvailableByte)
    return evidence as AgentMuxEvidence
  }
  if (gap.kind !== 'live-stream') fail()
  record(gap, ['kind', 'latestOutputBytes', 'publishedThroughByte', 'representation', 'causes', 'observation'])
  count(gap.publishedThroughByte, true)
  if (gap.representation !== null && gap.representation !== 'raw' && gap.representation !== 'terminal') fail()
  const fields = ['liveEventPressure', 'subscriberLag', 'sourceDiscontinuity', 'terminalCatchup', 'geometryLag', 'clientViewPressure', 'unknown'] as const
  const causes = record(gap.causes, fields)
  for (const field of fields) bool(causes[field])
  if (!fields.some(field => causes[field] === true)) fail()
  const o = record(gap.observation, ['attachmentId', 'runtime', 'runId', 'origins', 'firstObservedAtUnixMs',
    'lastObservedAtUnixMs', 'deliveredAtUnixMs', 'receivedOutputHeadByte', 'deliveredThroughByte', 'requestedAfterByte',
    'recoveryAfterByte', 'missingOutputBytes', 'queue', 'localPressure'])
  string(o.attachmentId); string(o.runId)
  if (o.runId !== run!.runId) fail()
  if (o.runtime !== null) {
    const runtime = record(o.runtime, ['runtimeId', 'daemonInstanceId'])
    string(runtime.runtimeId); string(runtime.daemonInstanceId)
  }
  const origins = record(o.origins, ['daemon', 'client'])
  bool(origins.daemon); bool(origins.client)
  if (origins.daemon !== true && origins.client !== true) fail()
  for (const field of ['firstObservedAtUnixMs', 'lastObservedAtUnixMs', 'requestedAfterByte', 'recoveryAfterByte']) count(o[field])
  for (const field of ['deliveredAtUnixMs', 'receivedOutputHeadByte', 'deliveredThroughByte', 'missingOutputBytes']) count(o[field], true)
  if (origins.daemon === true && o.missingOutputBytes !== null) fail()
  const queueFields = ['payloadBudgetBytes', 'envelopeBudgetBytes', 'retainedPayloadBytes', 'retainedEnvelopeBytes', 'payloadHighWaterBytes', 'envelopeHighWaterBytes']
  const queue = record(o.queue, queueFields)
  for (const field of queueFields) count(queue[field])
  if (o.localPressure !== null) {
    const pressure = record(o.localPressure, ['payloadLimitHit', 'envelopeLimitHit', 'attemptedPayloadBytes', 'attemptedEnvelopeBytes', 'droppedOutputBytes', 'countersSaturated'])
    for (const field of ['payloadLimitHit', 'envelopeLimitHit', 'countersSaturated']) bool(pressure[field])
    count(pressure.attemptedPayloadBytes); count(pressure.attemptedEnvelopeBytes); count(pressure.droppedOutputBytes, true)
    if (pressure.countersSaturated === true && pressure.droppedOutputBytes !== null) fail()
  }
  return evidence as AgentMuxEvidence
}
