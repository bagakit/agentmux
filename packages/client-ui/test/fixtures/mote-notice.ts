import type { AgentTimelineItem, MoteInputInspection, MoteInputObservation } from '@agentmux/core'
import { moteInputNoticeWire } from '@agentmux/core/mote-input-notice'

/** Synthetic recorded evidence for product capture. It starts no Session, message or native work. */
export function moteNoticeCaptureFixture({ recipient, member, source, phase = 'result' }: {
  recipient: string; member: string; source: MoteInputObservation['source']; phase?: 'input' | 'result'
}): { observation: MoteInputObservation; inspection: MoteInputInspection; item: AgentTimelineItem } {
  const recordedAt = Date.now() - 5 * 60 * 60 * 1_000
  const observation: MoteInputObservation = { id: 'preview-mote-member-decision', revision: 2, source,
    binding: { source, primary: { hostId: 'local', agentSessionId: recipient }, moteRevision: 'preview-mote-revision', spatialRevision: 1 },
    sourceStatus: 'confirmed', issue: null, input: phase === 'input' ? 'terminal-confirmed' : 'admitted',
    origin: { kind: 'prompt', key: { kind: 'prompt', agentSessionId: member, expectedRun: { runId: 'preview-member-run' }, submissionId: 'preview-member-input' } },
    notices: { [phase]: 'preview-mote-notification' },
    ...(phase === 'result' ? { result: { kind: 'native-turn' as const, status: 'completed' as const, records: [{
      record: { hostId: 'local', agentSessionId: member, source: { kind: 'native' as const, providerId: 'codex', nativeSessionId: 'preview-member-native', recordId: 'preview-member-reply' } }, revision: 'preview-reply-revision'
    }] } } : {}) }
  const inspection: MoteInputInspection = { observation, inputText: '按已确认的范围继续；保留原数据，并把最新结果交回主 Agent 汇总。', notices: {} }
  const item: AgentTimelineItem = { id: 'preview-mote-notification-record', agentSessionId: recipient, kind: 'system_message', source: 'agentmux',
    status: 'complete', title: 'AgentMux context', content: moteInputNoticeWire(observation, phase), a2aNotificationId: 'preview-mote-notification',
    inputRef: { kind: 'prompt', agentSessionId: recipient, expectedRun: { runId: 'preview-primary-run' }, submissionId: 'preview-mote-notification' },
    createdAt: recordedAt, updatedAt: recordedAt }
  return { observation, inspection, item }
}
