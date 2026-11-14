import { useMemo, useState } from 'react'
import type { AgentTimelineItem } from '@agentmux/core'
import { ClientUiProvider, useClientUiPlatform } from '@agentmux/client-ui/platform'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { projectConversationReading } from '@agentmux/client-ui/conversation-records'
import { CONVERSATION_CONFIRMED_SEND_RECEIPTS, type ConversationConfirmedSendReceipt } from '@agentmux/client-ui/conversation-send-receipts'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { SurfaceModeSwitch } from './SurfaceModeSwitch'
import './conversation-receipt-gallery.css'

type ReceiptPhase = 'waiting' | 'terminal-confirmed' | 'admitted'
const sessionId = 'gallery-receipt', hostId = 'gallery-host', submissionId = 'gallery-original-input'
const timestamp = Date.UTC(2026, 0, 1, 1, 41)
const content = '请检查这次改动，并保留原输入与真实回执。'
const phases = [
  { value: 'waiting', label: '等待接收' },
  { value: 'terminal-confirmed', label: '送入终端 · 待核实' },
  { value: 'admitted', label: 'Agent 已接收' },
] as const
const descriptions: Record<ReceiptPhase, string> = {
  waiting: '原输入正在等待 Agent；此示例保留原文与等待反馈。',
  'terminal-confirmed': '已确认送入终端，尚未确认 Agent 接收；默认收为可展开的一行。',
  admitted: '原输入已确认被 Agent 接收；这不表示任务已完成。',
}
const preferenceLabels: Record<ConversationConfirmedSendReceipt, string> = { keep: '保持卡片', compact: '安静一行（默认）', hide: '隐藏正常回执' }

/** Local illustrative records, rendered by the original shared reader without sending or saving. */
export function ConversationReceiptGallery() {
  const host = useClientUiPlatform()
  const [phase, setPhase] = useState<ReceiptPhase>('waiting')
  const [showReceipts, setShowReceipts] = useState(true)
  const [confirmedReceipt, setConfirmedReceipt] = useState<ConversationConfirmedSendReceipt>('compact')
  const platform = useMemo(() => ({ ...host, conversationShowSendReceipts: showReceipts, conversationConfirmedSendReceipt: confirmedReceipt }), [host, showReceipts, confirmedReceipt])
  const revision = phases.findIndex(option => option.value === phase) + 1
  const item: AgentTimelineItem = { id: submissionId, agentSessionId: sessionId, kind: 'user_message', source: 'user', status: 'complete',
    createdAt: timestamp, updatedAt: timestamp + revision, title: 'Original illustrative input', content, publicContent: 'confirmed', authorHuman: true,
    inputRef: { kind: 'prompt', agentSessionId: sessionId, expectedRun: { runId: 'gallery-only' }, submissionId },
    inputSubmission: { status: phase, observation: phase === 'waiting' ? 'owned' : 'closed' } }
  const reading = projectConversationReading({ agentSessionId: sessionId, executionHostId: hostId,
    coverage: [{ source: { kind: 'captured' }, origin: 'beginning', earlier: 'complete', current: 'complete-through-cut', readExtent: { through: 'gallery-only' }, gaps: [] }],
    timeline: { agentSessionId: sessionId, sourceHostId: hostId, revision, items: [item] } })
  return <section id="send-receipts" className="wf-gallery__section receipt-gallery" aria-labelledby="receipt-gallery-title" data-gallery-receipt-phase={phase}>
    <header className="receipt-gallery__heading">
      <h2 id="receipt-gallery-title"><SemanticIcon name="action.send" size={17} />发送回执对照</h2>
      <p>同一条原输入，依次查看等待、待核实和已接收。静态示例，不发送消息或保存设置。</p>
    </header>
    <SurfaceModeSwitch value={phase} options={phases} onChange={setPhase} active ariaLabel="发送回执阶段" />
    <p className="receipt-gallery__explanation" role="status">{descriptions[phase]}</p>
    <div className="receipt-gallery__preferences">
      <label><input type="checkbox" checked={showReceipts} onChange={event => setShowReceipts(event.target.checked)} />显示发送回执</label>
      <label>确认后<select aria-label="确认后回执呈现" value={confirmedReceipt} disabled={!showReceipts}
        onChange={event => setConfirmedReceipt(event.target.value as ConversationConfirmedSendReceipt)}>
        {CONVERSATION_CONFIRMED_SEND_RECEIPTS.map(value => <option key={value} value={value}>{preferenceLabels[value]}</option>)}
      </select></label>
    </div>
    <div className="receipt-gallery__conversation" aria-label="同一原输入的共享对话示例"><ClientUiProvider platform={platform}>
      <ConversationView sessionId={sessionId} executionHostId={hostId} records={reading.records} originalRecords={reading.originalRecords}
        coverage={reading.timeline.coverage} active detailsOnlyMetadata sourceLabelsInDetails coverageSummary="示例来源" describeSpeaker={() => ({ name: 'You' })} />
    </ClientUiProvider></div>
    <p className="receipt-gallery__boundary">本例没有原生对应关系。唯一原文、待核实或需处理的记录仍可展开，不会因显示偏好被丢弃。</p>
  </section>
}
