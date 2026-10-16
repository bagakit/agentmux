import type { ConversationSourceRecord } from '@agentmux/core/conversation'
import type { ReactNode } from 'react'
import { describeConversationInputSource } from '../lib/conversation-input-source.js'
import { ConversationMessageDisclosure } from './ConversationMessageDisclosure.js'
import { conversationMessageSourceKey } from '../lib/conversation-message-location.js'

/** Bound work to the preview; the original reader retains the complete content. */
export const conversationSubmissionPreview = (text: string, limit = 160) => text.slice(0, limit).replace(/\s+/gu, ' ').trim()

/** The same original submission facts in a native card or an independent send row. */
export function ConversationSubmissionSummary({ record, renderClock, nativeRecorded = false }: {
  record: ConversationSourceRecord; renderClock(time: number): string; nativeRecorded?: boolean
}) {
  if (record.original.kind !== 'captured') return null
  const item = record.original.item
  return <span className="conversation-submission-summary" data-status={item.status} title="原提交记录的时间与状态，不是原生接纳时间">
    <span>消息发送</span><span><time>{renderClock(item.createdAt)}</time></span>
    <span>{item.status === 'complete' ? nativeRecorded ? '已进入对话' : '提交已记录' : item.status === 'failed' ? '提交失败' : '提交未确认'}</span>
  </span>
}

export function ConversationSubmissionFacts({ record }: { record: ConversationSourceRecord }) {
  if (record.original.kind !== 'captured') return null
  const item = record.original.item
  const origin = describeConversationInputSource({ kind: 'captured', submissionId: item.id,
    ...(item.sourceChannel ? { channel: item.sourceChannel } : {}), ...(item.sourceDevice ? { device: item.sourceDevice } : {}) })
  return <dl className="conversation-input-details__facts">
    <dt>发送来源</dt><dd>{origin.caption}</dd>
    <dt>原提交</dt><dd><code>{item.id}</code></dd>
    <dt>原记录引用</dt><dd><code>{record.reference ? JSON.stringify(record.reference) : '未知'}</code></dd>
    <dt>原记录版本</dt><dd><code>{record.revision}</code></dd>
    {item.inputRef ? <><dt>原输入</dt><dd><code>{JSON.stringify(item.inputRef)}</code></dd></> : null}
    <dt>原记录状态</dt><dd>{item.status}</dd>
    <dt>时间口径</dt><dd>原提交记录时间，不是原生接纳或执行完成时间。</dd>
  </dl>
}

/** Original facts from one already accepted Core event; this component never associates inputs. */
export function ConversationSubmissionMetadata({ records, renderClock, nativeReadable, renderOriginal }: {
  records: readonly ConversationSourceRecord[]; renderClock(time: number): string
  nativeReadable: boolean
  renderOriginal?(record: ConversationSourceRecord): ReactNode
}) {
  return <div className="conversation-submissions">{records.map(record => {
    if (record.original.kind !== 'captured') return null
    const item = record.original.item
    return <div key={record.id} className="conversation-submission" data-submission-record={record.id} data-status={item.status} data-native-readable={nativeReadable}
      data-message-source-key={conversationMessageSourceKey(item.agentSessionId, { kind: 'captured', recordId: item.id })} tabIndex={-1}>
      <ConversationMessageDisclosure preview={conversationSubmissionPreview(item.content ?? '', 64)} reveal={false}
        summary={<ConversationSubmissionSummary record={record} renderClock={renderClock} nativeRecorded={nativeReadable} />}>
        <ConversationSubmissionFacts record={record} />
        {renderOriginal ? <OriginalSubmission record={record} render={renderOriginal} /> : null}
      </ConversationMessageDisclosure>
    </div>
  })}</div>
}

/** The disclosure mounts the same original reader only when its content is requested. */
function OriginalSubmission({ record, render }: { record: ConversationSourceRecord; render(record: ConversationSourceRecord): ReactNode }) {
  return render(record)
}
