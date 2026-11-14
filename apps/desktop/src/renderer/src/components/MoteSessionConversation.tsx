import { useCallback, useMemo, useState } from 'react'
import { useConversationView } from '@agentmux/client-ui/use-conversation-view'
import { describeConversationWindow } from '@agentmux/client-ui/conversation-records'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { InputMailboxRecords } from '@agentmux/client-ui/components/InputMailboxRecords'
import { useAgentInputMailbox } from '@agentmux/client-ui/use-agent-input-mailbox'
import { api } from '../lib/api'
import { OriginalInputWaitingControl } from './OriginalInputWaitingControl'

/** One exact original Session. Reading never creates, recovers or retargets it. */
export function MoteSessionConversation({ hostId, agentSessionId, identity, active }: {
  hostId: string; agentSessionId: string; identity: string; active: boolean
}) {
  const reference = useMemo(() => ({ hostId, agentSessionId }), [hostId, agentSessionId])
  const view = useConversationView(api.conversation, reference, active, { identity })
  const reading = useMemo(() => view.reading ? describeConversationWindow(view.reading) : null, [view.reading])
  const [receiptsOpen, setReceiptsOpen] = useState(false)
  return <section className="mote-session-conversation" aria-label="原对话" data-mote-session-conversation={JSON.stringify(reference)}>
    {view.error || view.observationError ? <p role="status" className="mote-conversation__issue">{(view.error ?? view.observationError)?.message} 原对话与已读内容保留。</p> : null}
    {reading ? <ConversationView sessionId={agentSessionId} executionHostId={hostId} records={reading.records} originalRecords={reading.originalRecords}
      page={reading.historyPage ?? null} coverage={reading.timeline.coverage} active={active} readProcessDetail={view.readProcessDetail} detailsOnlyMetadata sourceLabelsInDetails />
      : <p className="mote-conversation__muted">{view.loading ? '读取原对话…' : view.error ? '原来源暂不可读，可重读同一会话。' : '此读取范围尚无对话记录。'}</p>}
    <div className="mote-chat-actions">{view.hasMore ? <button type="button" className="small-button" disabled={view.loading} onClick={() => void view.earlier()}>更早的消息</button> : null}
      <button type="button" className="small-button" disabled={view.loading} onClick={() => void view.refresh()}>重读原对话</button></div>
    <details><summary>原会话来源</summary><code>{hostId} / {agentSessionId}</code></details>
    <details onToggle={event => setReceiptsOpen(event.currentTarget.open)}><summary>输入回执</summary><MoteSessionInputs hostId={hostId} agentSessionId={agentSessionId} active={active && receiptsOpen} /></details>
  </section>
}

function MoteSessionInputs({ hostId, agentSessionId, active }: { hostId: string; agentSessionId: string; active: boolean }) {
  const read = useCallback<Parameters<typeof useAgentInputMailbox>[0]['read']>(input => api.sessions.inputMailbox({ hostId, agentSessionId }, input), [hostId, agentSessionId])
  const mailbox = useAgentInputMailbox({ hostId, agentSessionId, enabled: active, read })
  return <section className="mote-chat-inputs" aria-label="原输入与回执"><InputMailboxRecords mailbox={mailbox} hostId={hostId} compact renderRelated={item => item.kind === 'controlled' && item.receipt ? <OriginalInputWaitingControl hostId={hostId} receipt={item.receipt} onRefresh={mailbox.refresh} /> : null} /></section>
}
