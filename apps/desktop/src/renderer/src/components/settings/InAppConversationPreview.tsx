import { useMemo, useState } from 'react'
import type { AgentSessionHistoryItem, AgentSessionHistoryPage, AgentTimelineItem } from '@agentmux/core'
import type { ConversationSourceCoverage } from '@agentmux/core/conversation'
import { ClientUiProvider, useClientUiPlatform } from '@agentmux/client-ui/platform'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { NativeProcessObservation } from '@agentmux/client-ui/components/NativeProcessObservation'
import { projectConversationReading } from '@agentmux/client-ui/conversation-records'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import type { ConversationDetailLevel } from '@agentmux/client-ui/conversation-detail-level'
import type { ConversationConfirmedSendReceipt } from '@agentmux/client-ui/conversation-send-receipts'
import { SurfaceModeSwitch } from '../SurfaceModeSwitch'

const sessionId = 'inapp-illustration', hostId = 'example-host'
const epoch = Date.UTC(2026, 0, 1, 1, 41)
const source = { providerId: 'codex', nativeSessionId: 'inapp-illustration' }
const coverage: ConversationSourceCoverage[] = [{ kind: 'native' as const, ...source }, { kind: 'captured' as const }].map(source => ({ source, origin: 'beginning', readExtent: { through: 'illustration' }, earlier: 'complete', current: 'complete-through-cut', gaps: [] }))
const text = (value: string): AgentSessionHistoryItem['contentParts'] => [{ kind: 'text', text: value }]
const page = (items: AgentSessionHistoryItem[]): AgentSessionHistoryPage => ({ agentSessionId: sessionId, sourceHostId: hostId, source, nextCursor: null, items })
const original = { hostId, agentSessionId: sessionId, source: { kind: 'native' as const, ...source, recordId: 'answer' } }
const readingPage = page([
  { id: 'question', kind: 'user-message', startedAt: epoch, turnId: 'reading', contentParts: text('Review the new conversation layout.') },
  { id: 'tool', kind: 'activity', startedAt: epoch + 1000, turnId: 'reading', title: 'Read project files', contentParts: text('Checked the existing message components.') },
  { id: 'peer', kind: 'activity', startedAt: epoch + 2000, turnId: 'reading', title: 'Reviewer', contentParts: text('The original draft and reading position are preserved.'), collaboration: { kind: 'message', source, sender: 'Reviewer', recipient: 'Agent' } },
  { id: 'system', kind: 'activity', startedAt: epoch + 3000, turnId: 'reading', recordPurpose: 'system-event', title: 'Turn complete', contentParts: text('task_complete · usage recorded') },
  { id: 'answer', kind: 'assistant-message', startedAt: epoch + 4000, messagePhase: 'final', turnId: 'reading', contentParts: text('The conversation stays clear. Details are available when you need them.') }
])
const snapshot: AgentTimelineItem = { id: 'snapshot', agentSessionId: sessionId, kind: 'assistant_message', source: 'native-hook', status: 'complete', createdAt: epoch + 5000, updatedAt: epoch + 5000, title: 'Reply snapshot', content: 'The conversation stays clear. Details are available when you need them.', conversation: { observes: original } }
const reading = projectConversationReading({ agentSessionId: sessionId, executionHostId: hostId, historyPage: readingPage, coverage, timeline: { agentSessionId: sessionId, sourceHostId: hostId, revision: 1, items: [snapshot] } })

function receiptExample(confirmed: boolean) {
  const content = 'Keep the conversation focused on the result.'
  const nativePage = page(confirmed ? [{ id: 'received', kind: 'user-message', startedAt: epoch + 1000, contentParts: text(content) }] : [])
  const send: AgentTimelineItem = { id: 'send', agentSessionId: sessionId, kind: 'user_message', source: 'user', status: 'complete', createdAt: epoch, updatedAt: confirmed ? epoch + 1000 : epoch, title: 'Submitted message', content, publicContent: 'confirmed', authorHuman: true,
    inputRef: { kind: 'prompt', agentSessionId: sessionId, expectedRun: { runId: 'illustration-only' }, submissionId: 'send' },
    inputSubmission: { status: confirmed ? 'admitted' : 'waiting', observation: confirmed ? 'closed' : 'owned' },
    ...(confirmed ? { conversation: { sameEvent: { hostId, agentSessionId: sessionId, source: { kind: 'native', ...source, recordId: 'received' } } } } : {}) }
  return { page: nativePage, ...projectConversationReading({ agentSessionId: sessionId, executionHostId: hostId, historyPage: nativePage, coverage, timeline: { agentSessionId: sessionId, sourceHostId: hostId, revision: confirmed ? 2 : 1, items: [send] } }) }
}
const receipts = { pending: receiptExample(false), confirmed: receiptExample(true) }

/** Static typed examples run through the same reader components, without IO or live Sessions. */
export function InAppConversationPreview({ level, showReceipts, confirmedReceipt, kind, active }: {
  level: ConversationDetailLevel; showReceipts: boolean; confirmedReceipt: ConversationConfirmedSendReceipt; kind: 'reading' | 'receipts'; active: boolean
}) {
  const host = useClientUiPlatform()
  const [phase, setPhase] = useState<'pending' | 'confirmed'>('pending')
  const platform = useMemo(() => ({ ...host, conversationDetailLevel: level, conversationShowSendReceipts: showReceipts, conversationConfirmedSendReceipt: confirmedReceipt,
    renderMessageAvatar: ({ speaker }: Parameters<typeof host.renderMessageAvatar>[0]) => <SemanticIcon name={speaker.role === 'human' ? 'object.user' : 'object.agent'} size={16} />
  }), [host, level, showReceipts, confirmedReceipt])
  const value = kind === 'reading' ? { page: readingPage, ...reading } : receipts[phase]
  return <figure className="inapp-reading-preview" data-inapp-preview={kind}>
    <figcaption><span><SemanticIcon name="action.preview" size={14} />Preview</span><span>Illustrative conversation</span></figcaption>
    {kind === 'receipts' ? <SurfaceModeSwitch value={phase} options={[{ value: 'pending', label: 'Before confirmation' }, { value: 'confirmed', label: 'After confirmation' }]} onChange={setPhase} active={active} ariaLabel="Send receipt example" /> : null}
    <div className="inapp-reading-preview__body"><ClientUiProvider platform={platform}>
      <ConversationView key={kind === 'receipts' ? phase : kind} sessionId={sessionId} executionHostId={hostId} page={value.page} records={value.records} originalRecords={value.originalRecords} coverage={value.timeline.coverage} active={active} detailsOnlyMetadata sourceLabelsInDetails coverageSummary="Example sources"
        describeSpeaker={speaker => ({ name: speaker.role === 'human' ? 'You' : 'Agent' })}
        renderProcess={process => <NativeProcessObservation {...process} compact />} />
    </ClientUiProvider></div>
    <p className="inapp-reading-preview__note">{kind === 'reading' ? 'The same example, with the detail you choose.' : 'A sample receipt — no message is sent.'}</p>
  </figure>
}
