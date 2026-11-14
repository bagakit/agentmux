import type { ConversationSourceRecord } from '@agentmux/core/conversation'
import type { ReactNode } from 'react'
import { describeConversationInputSource } from '../lib/conversation-input-source.js'
import { ConversationMessageDisclosure } from './ConversationMessageDisclosure.js'
import { conversationMessageSourceKey } from '../lib/conversation-message-location.js'
import type { AgentInputSubmissionObservation } from '@agentmux/core'
import { useClientUiPlatform } from '../platform.js'
import { resolveConversationConfirmedSendReceipt, resolveConversationShowSendReceipts } from '../lib/conversation-send-receipts.js'
import { SemanticIcon } from '../theme/icons.js'
import { ConversationRetainedDetails } from './ConversationRetainedDetails.js'
import { useVisibleWork } from '../lib/use-visible-work.js'

const inputStatus: Record<AgentInputSubmissionObservation['status'], string> = {
  waiting: '已保存 · 等待 Agent', stopped: '已保存 · 已停止送达', 'terminal-confirmed': '已送入终端 · Agent 接收未确认',
  admitted: 'Agent 已接收', 'launch-carried': '恢复启动已携带消息 · Agent 接收未确认', 'not-applied': '未送达 Agent', unknown: '已保存 · 送达 Agent 未确认'
}
const inputAttention: Record<AgentInputSubmissionObservation['status'], string | null> = {
  waiting: '等待 Agent', stopped: '已停止送达', 'terminal-confirmed': 'Agent 接收待核实',
  admitted: null, 'launch-carried': 'Agent 接收待核实', 'not-applied': '未送达 Agent', unknown: '送达待核实'
}

/** Bound work to the preview; the original reader retains the complete content. */
export const conversationSubmissionPreview = (text: string, limit = 160) => text.slice(0, limit).replace(/\s+/gu, ' ').trim()

/** Presentation over one original receipt and an already accepted Core membership only. */
export function conversationSendReceiptState(record: ConversationSourceRecord, nativeAccepted = false) {
  const item = record.original.kind === 'captured' ? record.original.item : undefined
  const status = item?.inputSubmission?.status
  const confirmed = status === 'admitted' || nativeAccepted
  const attention = item?.status === 'failed' || item?.externalInput?.state === 'refused' || !confirmed
    || status === 'waiting' || status === 'unknown' || status === 'stopped' || status === 'not-applied'
    || item?.inputSubmission?.observation === 'rejoin-needed'
  const pending = !confirmed && item?.status !== 'failed' && status === 'waiting' && item?.inputSubmission?.observation === 'owned'
  return { confirmed, attention, pending }
}

/** One disclosure around the same original reader; never a copied body or a second history. */
export function ConversationSendReceipt({ record, nativeAccepted = false, nativeReadable = false, original = false, active = true,
  renderClock, reveal = false, open, onOpenChange, children }: {
  record: ConversationSourceRecord
  nativeAccepted?: boolean
  nativeReadable?: boolean
  original?: boolean
  active?: boolean
  renderClock(time: number): string
  reveal?: boolean
  open?: boolean
  onOpenChange?(open: boolean): void
  children: ReactNode
}) {
  const platform = useClientUiPlatform()
  if (record.original.kind !== 'captured') return children
  const item = record.original.item
  const state = conversationSendReceiptState(record, nativeAccepted)
  const show = resolveConversationShowSendReceipts(platform.conversationShowSendReceipts)
  const confirmedMode = resolveConversationConfirmedSendReceipt(platform.conversationConfirmedSendReceipt)
  // A sole readable input always keeps its own full-text disclosure, even under Hide.
  const hide = !state.attention && nativeReadable && (!show || state.confirmed && confirmedMode === 'hide')
  const compact = !original && (!show || state.confirmed && confirmedMode !== 'keep')
  return <div className="conversation-send-receipt" data-receipt-mode={compact ? 'compact' : 'keep'} data-receipt-confirmed={state.confirmed} data-receipt-attention={state.attention} data-receipt-active={active && show}
    data-message-source-key={conversationMessageSourceKey(item.agentSessionId, { kind: 'captured', recordId: item.id })} tabIndex={-1}>
    <ConversationMessageDisclosure preview={conversationSubmissionPreview(item.content ?? '', 96)} reveal={reveal}
      hidden={hide} expanded={!compact} {...(!compact ? { open: true } : open === undefined ? {} : { open })} {...(onOpenChange ? { onOpenChange } : {})}
      summary={<span className="conversation-send-receipt__summary"><SemanticIcon name={state.confirmed ? 'action.confirm' : 'action.send'} size={12} aria-hidden="true" />
        <span>{state.confirmed ? item.inputSubmission?.status === 'admitted' ? 'Agent 已接收' : '原生记录已对应' : '消息输入'}</span><time>{renderClock(item.createdAt)}</time>
        {state.attention ? <ConversationSubmissionSummary record={record} renderClock={renderClock} showTime={false} attentionOnly /> : null}</span>}>
      {children}
    </ConversationMessageDisclosure>
  </div>
}

/** The same original submission facts in a native card or an independent send row. */
export function ConversationSubmissionSummary({ record, renderClock, showTime = true, attentionOnly = false, active = false }: {
  record: ConversationSourceRecord; renderClock(time: number): string; showTime?: boolean; attentionOnly?: boolean | undefined; active?: boolean
}) {
  if (record.original.kind !== 'captured') return null
  const item = record.original.item
  const pending = active && conversationSendReceiptState(record).pending
  const activity = pending ? <PendingSubmissionActivity /> : null
  const refused = item.externalInput?.state === 'refused'
  if (attentionOnly) {
    const attention = refused ? item.externalInput?.code === 'INGRESS_ACTOR_NOT_AUTHORIZED' ? '未提交 · 成员未获输入权限'
      : item.externalInput?.code === 'INGRESS_INPUT_OUTSIDE_SCOPE' ? '未提交 · 不在触发范围' : '请求被拒绝'
      : item.inputSubmission ? inputAttention[item.inputSubmission.status] : item.inputRef ? '接收待核实' : null
    return attention || item.status === 'failed' ? <span className="conversation-submission-summary" role="status" data-status={item.status}
      data-input-status={item.inputSubmission?.status} title="原输入状态；在消息详情中查看完整记录与回执">{activity}{item.status === 'failed' ? <span>原记录失败{attention ? ' · ' : ''}</span> : null}{attention}</span> : null
  }
  const summary = item.inputSubmission ? inputStatus[item.inputSubmission.status] : item.inputRef ? '原输入状态未确认'
    : refused ? item.externalInput?.code === 'INGRESS_ACTOR_NOT_AUTHORIZED' ? '对话已收录 · 未提交 Agent：成员未获输入权限'
      : item.externalInput?.code === 'INGRESS_INPUT_OUTSIDE_SCOPE' ? '对话已收录 · 未提交 Agent：未符合触发范围' : '对话已收录 · 本次请求被拒绝'
    : '对话已收录'
  return <span className="conversation-submission-summary" data-status={item.status} title={item.inputRef ? '原输入阶段，不表示群消息已交付或 Agent 任务已完成' : '原对话收录记录，不表示已提交给 Agent'}>
    {activity}<span>{item.inputRef ? '消息输入' : '对话记录'}</span>{showTime ? <span><time>{renderClock(item.createdAt)}</time></span> : null}
    <span>{summary}</span>
  </span>
}

/** Only an original pending receipt acquires viewport and owner-document work. */
function PendingSubmissionActivity() {
  const { ref, visible } = useVisibleWork<HTMLSpanElement>()
  return <span ref={ref} className="conversation-send-receipt__activity" role="status" aria-label="正在等待 Agent 接收">
    <SemanticIcon name="status.loading" animation={visible ? 'spin' : 'none'} size={12} aria-hidden="true" />
  </span>
}

export function ConversationSubmissionFacts({ record }: { record: ConversationSourceRecord }) {
  if (record.original.kind !== 'captured') return null
  const item = record.original.item
  const origin = describeConversationInputSource({ kind: 'captured', submissionId: item.id,
    ...(item.sourceChannel ? { channel: item.sourceChannel } : {}), ...(item.sourceDevice ? { device: item.sourceDevice } : {}) })
  return <dl className="conversation-input-details__facts">
    <dt>发送来源</dt><dd>{origin.caption}</dd>
    <dt>{item.inputRef ? '原提交' : '原记录'}</dt><dd><code>{item.id}</code></dd>
    <dt>原记录引用</dt><dd><code>{record.reference ? JSON.stringify(record.reference) : '未知'}</code></dd>
    <dt>原记录版本</dt><dd><code>{record.revision}</code></dd>
    {item.inputRef ? <><dt>原输入</dt><dd><code>{JSON.stringify(item.inputRef)}</code></dd></> : null}
    {item.inputRef && !item.inputSubmission ? <><dt>原输入状态</dt><dd>未确认</dd></> : null}
    <dt>原记录状态</dt><dd>{item.status}</dd>
    {item.externalInput ? <><dt>原群消息处理</dt><dd>{item.externalInput.state}{item.externalInput.code ? ' · ' + item.externalInput.code : ''}</dd>
      <dt>原收件</dt><dd><code>{item.externalInput.ingressId}</code></dd>
      {item.externalInput.state === 'refused' ? <><dt>核对路径</dt><dd>{item.externalInput.code === 'INGRESS_ACTOR_NOT_AUTHORIZED'
        ? '在当前 Agent 的 Connections 打开此群的 Member access，核对准确成员权限。查看或修改权限不会重发这条旧消息。'
        : '在当前 Agent 的 Connections 打开此群，查看原收件回执与共享范围。查看不会重新提交这条消息。'}</dd></> : null}</> : null}
    {item.inputSubmission ? <><dt>处理状态</dt><dd><code>{item.inputSubmission.status}</code> · {inputStatus[item.inputSubmission.status]}</dd>
      <dt>输入观察</dt><dd>{item.inputSubmission.observation === 'rejoin-needed' ? '需重新接入原输入观察' : item.inputSubmission.observation === 'owned' ? '原 Core 正在观察' : '原输入回执已记录'}</dd></> : null}
    <dt>时间口径</dt><dd>{item.inputRef ? '原提交记录时间，不是原生接纳或执行完成时间。' : '原记录时间，不是已提交、原生接纳或执行完成时间。'}</dd>
  </dl>
}

/** Original facts from one already accepted Core event; this component never associates inputs. */
export function ConversationSubmissionMetadata({ records, renderClock, nativeReadable, renderOriginal, expandedRecords, onOpenChange, locatedSourceKey }: {
  records: readonly ConversationSourceRecord[]; renderClock(time: number): string
  nativeReadable: boolean
  renderOriginal?(record: ConversationSourceRecord): ReactNode
  expandedRecords?: ReadonlySet<string>
  onOpenChange?(recordId: string, open: boolean): void
  locatedSourceKey?: string
}) {
  return <div className="conversation-submissions">{records.map(record => {
    if (record.original.kind !== 'captured') return null
    const item = record.original.item
    const sourceKey = conversationMessageSourceKey(item.agentSessionId, { kind: 'captured', recordId: item.id })
    return <div key={record.id} className="conversation-submission" data-submission-record={record.id} data-status={item.status} data-native-readable={nativeReadable}
      data-message-source-key={sourceKey} tabIndex={-1}>
      {item.inputRef ? <ConversationSendReceipt record={record} renderClock={renderClock} nativeAccepted nativeReadable={nativeReadable} reveal={Boolean(locatedSourceKey && locatedSourceKey === sourceKey)}
        {...(expandedRecords?.has(record.id) ? { open: true } : {})} onOpenChange={open => onOpenChange?.(record.id, open)}>
        {renderOriginal ? <OriginalSubmission record={record} render={renderOriginal} /> : <SubmissionFactsDisclosure record={record} />}
      </ConversationSendReceipt> : <ConversationMessageDisclosure preview={conversationSubmissionPreview(item.content ?? '', 64)} reveal={Boolean(locatedSourceKey && locatedSourceKey === sourceKey)}
        {...(expandedRecords ? { open: expandedRecords.has(record.id) } : {})} onOpenChange={open => onOpenChange?.(record.id, open)}
        summary={<ConversationSubmissionSummary record={record} renderClock={renderClock} />}>
        <ConversationSubmissionFacts record={record} />{renderOriginal ? <OriginalSubmission record={record} render={renderOriginal} /> : null}
      </ConversationMessageDisclosure>}
    </div>
  })}</div>
}

/** The disclosure mounts the same original reader only when its content is requested. */
function OriginalSubmission({ record, render }: { record: ConversationSourceRecord; render(record: ConversationSourceRecord): ReactNode }) {
  return render(record) ?? <SubmissionFactsDisclosure record={record} />
}

function SubmissionFactsDisclosure({ record }: { record: ConversationSourceRecord }) {
  return <ConversationRetainedDetails summary="原发送记录与回执">{() => <ConversationSubmissionFacts record={record} />}</ConversationRetainedDetails>
}
