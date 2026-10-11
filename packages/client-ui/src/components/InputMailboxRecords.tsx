import { useState, type ReactNode } from 'react'
import type { AgentInputMailboxItem } from '@agentmux/core/agent-input-mailbox'
import { ConversationMessage, type ConversationReadingProps } from './ConversationMessage.js'
import { MessageDeliveryFailure } from './MessageDeliveryFailure.js'
import { presentMessageDeliveryFailure } from '../lib/message-delivery-presentation.js'
import { useClientUiPlatform } from '../platform.js'
import { inputMailboxItemKey, type useAgentInputMailbox } from '../lib/use-agent-input-mailbox.js'
import { HUMAN_SPEAKER_ID, UNKNOWN_SPEAKER_ID, speakerOfExternalAuthor, externalSpeakerLabel, type ConversationSpeaker } from '../lib/conversation-speaker.js'

export function inputMailboxPresentation(item: AgentInputMailboxItem): { text: string | null; speaker: ConversationSpeaker; source: string; state: string } {
  const unknown = { role: 'unknown' as const, id: UNKNOWN_SPEAKER_ID }
  if (item.kind === 'controlled') {
    const original = item.intent.source, sender = item.message?.sender
    const speaker = original.kind === 'prompt' ? original.authorHuman === true ? { role: 'human' as const, id: HUMAN_SPEAKER_ID } : unknown
      : sender?.kind === 'external' ? speakerOfExternalAuthor(sender)
      : sender?.kind === 'agent-session' ? { role: 'agent' as const, id: sender.agentSessionId } : unknown
    return { text: original.kind === 'prompt' ? original.prompt : item.message?.body ?? null, speaker,
      source: sender?.kind === 'external' ? sender.actor.application.domain : original.kind === 'prompt' ? original.sourceChannel ?? '原提交' : item.sourceChannel ?? '原消息',
      state: item.receipt ? presentMessageDeliveryFailure({ error: null, inputReceipt: item.receipt }).title : '原输入观察未确认' }
  }
  const message = item.record?.admission?.intent?.message ?? item.record?.launch?.message
  const speaker = message?.authorExternal ? speakerOfExternalAuthor(message.authorExternal)
    : message?.authorAgentSessionId ? { role: 'agent' as const, id: message.authorAgentSessionId }
    : message?.authorHuman === true ? { role: 'human' as const, id: HUMAN_SPEAKER_ID } : unknown
  return { text: message?.userContent ?? item.record?.admission?.intent?.prompt ?? item.record?.launch?.prompt ?? null,
    speaker, source: message?.sourceChannel ?? '原提交', state: item.record ? '原提交已登记' : '原提交观察未确认' }
}

export type InputMailboxDisplayRow = { key: string; time: number; node: ReactNode }

/** A journal reader. Opening, copying and refreshing never dispatch an input or grant control. */
export function InputMailboxRecords({ mailbox, hostId, reading, onCopy, renderLocal, renderRecords, refreshInParent = false }: {
  mailbox: ReturnType<typeof useAgentInputMailbox>; hostId: string; reading?: ConversationReadingProps | undefined
  onCopy?: ((text: string) => Promise<boolean>) | undefined
  /** The containing surface already owns one refresh action for this reader. */
  refreshInParent?: boolean
  renderRecords?(rows: readonly InputMailboxDisplayRow[]): ReactNode
  renderLocal?(item: AgentInputMailboxItem): ReactNode
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const platform = useClientUiPlatform()
  const failures = new Map(mailbox.failures.map(item => [inputMailboxItemKey(hostId,item),item]))
  const retainedPrior = mailbox.items.some(item => {
    const failed = failures.get(inputMailboxItemKey(hostId,item))
    return failed && failed !== item
  })
  const records = mailbox.items.map(item => {
      const key = inputMailboxItemKey(hostId,item), view = inputMailboxPresentation(item), local = selected === key ? renderLocal?.(item) : null
      const failed = failures.get(key)
      return { key, time: item.recordedAt, node: <li key={key} data-input-mailbox-key={key} data-input-mailbox-kind={item.kind}>
        <div className="input-history__meta"><span data-mailbox-author>{view.speaker.role === 'external' ? externalSpeakerLabel(view.speaker) : view.speaker.role === 'agent' ? view.speaker.id : view.speaker.role === 'human' ? 'Human' : 'Author unknown'}</span>{view.speaker.role === 'external' && view.source === view.speaker.external?.actor.application.domain ? null : <span>{view.source}</span>}<span>{failed && failed !== item ? '此前已读 · ' : ''}{view.state}</span><time>{new Date(item.recordedAt).toLocaleString()}</time></div>
        <p className="input-history__excerpt">{view.text?.slice(0,320) ?? '原正文未随本条观察返回'}</p>
        <details open={selected === key} onToggle={event => { if (event.currentTarget.open) setSelected(key); else if (selected === key) setSelected(null) }}><summary>查看原输入</summary>
          {selected === key ? <>
          {view.text !== null ? <ConversationMessage {...reading} compact recordedIdentity detailsOnlyMetadata
            messageId={key} speaker={view.speaker} content={view.text} createdAt={item.recordedAt} {...(onCopy ? { onCopy } : {})} /> : null}
          {item.kind === 'controlled' ? <MessageDeliveryFailure compact error={item.failure ?? null}
            {...(item.receipt ? { inputReceipt: item.receipt } : {})} copyText={onCopy ?? (text => platform.copyText(text, () => {}))} /> : null}
          {item.kind === 'submission' && item.failure ? <p role="status">{item.failure.message}</p> : null}
          {local ? <details><summary>此设备的保留操作</summary>{local}</details> : null}
          {failed ? <details><summary>本次读取未确认</summary><pre>{JSON.stringify(failed,null,2)}</pre></details> : null}
          <details><summary>原输入身份与回执</summary><pre>{JSON.stringify(item,null,2)}</pre></details>
          </> : null}
        </details>
      </li> }
    })
  return <section className="input-history input-mailbox" aria-label="发送信箱" data-input-mailbox-scope={mailbox.scope}>
    <div className="input-history__actions"><strong>发送记录</strong>{refreshInParent ? null : <button type="button" disabled={mailbox.loading} onClick={() => void mailbox.refresh()}>刷新发送记录</button>}</div>
    <p className="input-history__coverage" role="status">{mailbox.loading ? '正在读取已登记输入…' : '已登记输入 · 更早历史未确认'}</p>
    {mailbox.error ? <p className="input-history__notice" role="status">{mailbox.error}</p> : null}
    {mailbox.failures.length ? <p className="input-history__notice" role="status">{retainedPrior ? '当前观察未确认；此前已读记录保留。' : '部分输入当前观察未确认。'}</p> : null}
    {renderRecords ? renderRecords(records) : records.length ? <ol className="input-history__records" aria-label="已登记的发送记录">{records.map(record => record.node)}</ol> : !mailbox.loading && mailbox.page ? <p className="input-history__notice">本次读取未返回已登记输入；未登记的原输入仍未确认。</p> : null}
    {mailbox.hasMore ? <button type="button" disabled={mailbox.loading} onClick={() => void mailbox.loadEarlier()}>读取更早的发送记录</button> : null}
  </section>
}
