import type { ConversationSourceRecord } from '@agentmux/core/conversation'
import { describeConversationInputSource } from '../lib/conversation-input-source.js'

/** The same original submission facts in a native card or an independent send row. */
export function ConversationSubmissionSummary({ record, renderClock }: {
  record: ConversationSourceRecord; renderClock(time: number): string
}) {
  if (record.original.kind !== 'captured') return null
  const item = record.original.item
  const origin = describeConversationInputSource({ kind: 'captured', submissionId: item.id,
    ...(item.sourceChannel ? { channel: item.sourceChannel } : {}), ...(item.sourceDevice ? { device: item.sourceDevice } : {}) })
  return <span className="conversation-submission-summary" data-status={item.status} title="原提交记录的时间与状态，不是原生接纳时间">
    <span>{item.status === 'complete' ? '提交于' : '记录于'} <time>{renderClock(item.createdAt)}</time></span>
    <span>{origin.caption}</span><span>{item.status === 'complete' ? '提交已记录' : item.status === 'failed' ? '提交失败' : '提交未确认'}</span>
  </span>
}

export function ConversationSubmissionFacts({ record }: { record: ConversationSourceRecord }) {
  if (record.original.kind !== 'captured') return null
  const item = record.original.item
  return <dl className="conversation-input-details__facts">
    <dt>原提交</dt><dd><code>{item.id}</code></dd>
    <dt>原记录引用</dt><dd><code>{record.reference ? JSON.stringify(record.reference) : '未知'}</code></dd>
    <dt>原记录版本</dt><dd><code>{record.revision}</code></dd>
    {item.inputRef ? <><dt>原输入</dt><dd><code>{JSON.stringify(item.inputRef)}</code></dd></> : null}
    <dt>原记录状态</dt><dd>{item.status}</dd>
    <dt>时间口径</dt><dd>原提交记录时间，不是原生接纳或执行完成时间。</dd>
  </dl>
}

/** Original facts from one already accepted Core event; this component never associates inputs. */
export function ConversationSubmissionMetadata({ records, renderClock }: {
  records: readonly ConversationSourceRecord[]; renderClock(time: number): string
}) {
  return <div className="conversation-submissions">{records.map(record => {
    if (record.original.kind !== 'captured') return null
    const item = record.original.item
    return <details key={record.id} className="conversation-submission" data-submission-record={record.id} data-status={item.status}>
      <summary aria-label={`提交记录 ${item.id}`} title="原提交记录的时间与状态，不是原生接纳时间">
        <ConversationSubmissionSummary record={record} renderClock={renderClock} />
      </summary>
      <ConversationSubmissionFacts record={record} />
    </details>
  })}</div>
}
