import { useId, useState, type MouseEvent, type ReactNode } from 'react'
import type { AgentInputMailboxItem } from '@agentmux/core/agent-input-mailbox'
import { sessionInputMailboxAuthor, type SessionInputGroup } from '@agentmux/core/conversation'
import { parseAgentMuxMessagePrefix } from '@agentmux/core/agent-message-render'
import { ConversationMessage, type ConversationContentBoundary, type ConversationMessageProps, type ConversationReadingProps } from './ConversationMessage.js'
import { ChannelProfileAvatar } from './ChannelProfileAvatar.js'
import { InputChannelSummary } from './InputChannelSummary.js'
import { MailboxRecordRow } from './MailboxRecordRow.js'
import { MessageDeliveryFailure } from './MessageDeliveryFailure.js'
import { presentMessageDeliveryFailure } from '../lib/message-delivery-presentation.js'
import { useClientUiPlatform } from '../platform.js'
import { inputMailboxItemKey, type useAgentInputMailbox } from '../lib/use-agent-input-mailbox.js'
import { AGENTMUX_SYSTEM_SPEAKER_ID, speakerOfUserMessage, externalSpeakerLabel, type ConversationSpeaker } from '../lib/conversation-speaker.js'

export function inputMailboxPresentation(item: AgentInputMailboxItem): Pick<ConversationMessageProps, 'inputContext' | 'inputContextSource' | 'copyText'> & { text: string | null; previewText?: string; contentBoundary: ConversationContentBoundary; speaker: ConversationSpeaker; source: string; state: string; a2aNotificationId?: string } {
  const author = sessionInputMailboxAuthor(item)
  const speaker = author.kind === 'system' ? { role: 'system' as const, id: AGENTMUX_SYSTEM_SPEAKER_ID } : speakerOfUserMessage({ author })
  if (item.kind === 'controlled') {
    const original = item.intent.source, sender = item.message?.sender
    const originalWire = original.kind === 'message' ? original.promptWire ?? item.receipt?.admission?.admission?.intent?.prompt : undefined
    const quoted = original.kind === 'message' && item.message?.channelQuote !== undefined
    return { text: original.kind === 'prompt' ? original.prompt : quoted ? originalWire ?? null : item.message?.body ?? null,
      ...(quoted ? { previewText: item.message!.body } : {}), contentBoundary: quoted ? 'wire' : 'body', speaker,
      ...(original.kind === 'prompt' ? { inputContext: original.inputContext, inputContextSource: original.inputContextSource, ...(original.promptWire === undefined ? {} : { copyText: original.promptWire }) } : originalWire === undefined ? {} : { copyText: originalWire }),
      source: sender?.kind === 'external' ? sender.actor.application.domain : original.kind === 'prompt' ? original.sourceChannel ?? '原提交' : item.sourceChannel ?? '原消息',
      state: item.receipt ? presentMessageDeliveryFailure({ error: null, inputReceipt: item.receipt }).title : '原输入观察未确认' }
  }
  const { record } = item, admission = record?.admission
  const message = admission?.intent?.message ?? record?.launch?.message
  // Core performPromptSubmission records the original prompt body here, but a message-key producer records its rendered wire.
  return { text: message?.userContent ?? item.record?.admission?.intent?.prompt ?? item.record?.launch?.prompt ?? null,
    contentBoundary: item.key.kind === 'prompt' && message?.userContent !== undefined ? 'body' : 'wire',
    inputContext: message?.inputContext, inputContextSource: message?.inputContextSource,
    ...(admission?.intent?.prompt !== undefined ? { copyText: admission.intent.prompt } : record?.launch?.prompt !== undefined ? { copyText: record.launch.prompt } : {}),
    speaker, source: message?.sourceChannel ?? '原提交', state: item.record ? '原提交已登记' : '原提交观察未确认',
    ...(author.kind === 'system' ? { a2aNotificationId: message!.a2aNotificationId } : {}) }
}

export type InputMailboxRecordProps = {
  item: AgentInputMailboxItem; hostId: string; failed?: AgentInputMailboxItem | undefined
  reading?: ConversationReadingProps | undefined; onCopy?: ((text: string) => Promise<boolean>) | undefined
  compact?: boolean; expanded?: boolean; externalSelection?: boolean; detailOnly?: boolean
  group?: SessionInputGroup | undefined; local?: ReactNode; related?: ReactNode
  onOpen?(key: string, event: MouseEvent<HTMLButtonElement>): void
  onExpand?(expanded: boolean): void
}

/** One original journal row or its detail; source reads and selection stay with the containing surface. */
export function InputMailboxRecord({ item, hostId, failed, reading, onCopy, compact = false, expanded = false,
  externalSelection = false, detailOnly = false, group, local, related, onOpen, onExpand }: InputMailboxRecordProps) {
  const id = useId(), platform = useClientUiPlatform()
  const key = inputMailboxItemKey(hostId, item), view = inputMailboxPresentation(item)
  if (group) view.speaker = group.author.kind === 'system' ? { role: 'system', id: AGENTMUX_SYSTEM_SPEAKER_ID } : speakerOfUserMessage({ author: group.author })
  const author = view.speaker.role === 'external' ? externalSpeakerLabel(view.speaker) : view.speaker.role === 'agent' ? view.speaker.id : view.speaker.role === 'system' ? 'AgentMux' : view.speaker.role === 'human' ? 'Human' : 'Author unknown'
  const described = compact && view.speaker.role !== 'unknown' ? reading?.describeSpeaker?.(view.speaker, 18) : undefined
  const label = described?.name || author
  const channelContext = <InputChannelSummary speaker={view.speaker} described={described} inputs={[item]} />
  const previewText = view.previewText ?? view.text ?? group?.primary?.content ?? null
  const prefix = compact ? previewText?.slice(0,240) ?? '' : ''
  const preview = compact && view.text !== null && view.contentBoundary === 'wire' ? parseAgentMuxMessagePrefix(prefix)?.body?.trim() || prefix : prefix
  const detailId = `${id}-${encodeURIComponent(key)}`
  const observed = new Date(item.recordedAt)
  const state = failed ? `${failed !== item ? '此前已读 · ' : ''}本次读取未确认`
    : item.kind === 'controlled' ? item.receipt?.status === 'admitted' ? null : view.state
    : item.failure ? '原提交读取未确认' : !item.record ? view.state : null
  const unconfirmed = Boolean(failed || (item.kind === 'controlled' ? !item.receipt || item.receipt.status === 'unknown' : item.failure || !item.record))
  const originalFacts = expanded ? <>
    {failed ? <details><summary>本次读取未确认</summary><pre>{JSON.stringify(failed,null,2)}</pre></details> : null}
    <details><summary>原输入身份与回执</summary><pre>{JSON.stringify(item,null,2)}</pre></details>
  </> : null
  const detail = expanded ? <>
    {view.text !== null ? <ConversationMessage {...reading} compact recordedIdentity detailsOnlyMetadata
      messageId={key} speaker={view.speaker} content={view.text} contentBoundary={view.contentBoundary} a2aNotificationId={view.a2aNotificationId} createdAt={item.recordedAt}
      inputContext={view.inputContext} inputContextSource={view.inputContextSource} {...(view.copyText === undefined ? {} : { copyText: view.copyText })} {...(onCopy ? { onCopy } : {})}
      {...(compact ? { name: label, messageDetails: <><dl className="composer-mailbox__record-facts">
        <dt>Source</dt><dd>{view.source}{channelContext}</dd><dt>Recorded state</dt><dd>{view.state}</dd><dt>Time</dt><dd>{observed.toLocaleString()}</dd>
      </dl>{originalFacts}</> } : {})} /> : null}
    {item.kind === 'controlled' ? <MessageDeliveryFailure compact error={item.failure ?? null}
      {...(item.receipt ? { inputReceipt: item.receipt } : {})} copyText={onCopy ?? (text => platform.copyText(text, () => {}))} /> : null}
    {item.kind === 'submission' && item.failure ? <p role="status">{item.failure.message}</p> : null}
    {local ? <details><summary>此设备的保留操作</summary>{local}</details> : null}
    {related}
    {!compact || view.text === null ? originalFacts : null}
  </> : null
  if (detailOnly) return <article className="composer-mailbox__detail" data-record-key={key}>{detail}</article>
  return <li data-input-mailbox-key={key} data-input-mailbox-kind={item.kind}>
    {compact ? <>
      <MailboxRecordRow recordKey={key} label={label} preview={preview || (view.text === null ? '原正文未随本条观察返回' : 'No text recorded.')}
        context={view.speaker.external ? channelContext : null}
        avatar={<span className="composer-mailbox__record-avatar"><ChannelProfileAvatar key={JSON.stringify([view.speaker.id, described?.channelProfile?.checkedAt])} url={described?.channelProfile?.profile?.avatarUrl} size={18}>
          {described?.avatar ?? platform.renderMessageAvatar({ speaker: view.speaker, name: label, providerId: described?.providerId, project: described?.project })}
        </ChannelProfileAvatar></span>}
        metadata={Number.isNaN(observed.getTime()) ? <span>Time not recorded</span> : <time dateTime={observed.toISOString()} title={observed.toLocaleString()}>{observed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>}
        status={state ? <span className={unconfirmed ? 'composer-mailbox__risk' : undefined}>{state}</span> : null}
        {...(externalSelection ? {} : { expanded, controls: detailId })} onOpen={onOpen!} />
      {externalSelection ? null : <div id={detailId} className="composer-mailbox__detail" hidden={!expanded}>{detail}</div>}
    </> : <>
    <div className="input-history__meta"><span data-mailbox-author>{author}</span>{view.speaker.role === 'external' && view.source === view.speaker.external?.actor.application.domain ? null : <span>{view.source}</span>}<span>{failed && failed !== item ? '此前已读 · ' : ''}{view.state}</span><time>{observed.toLocaleString()}</time></div>
    <p className="input-history__excerpt">{previewText?.slice(0,320) ?? '原正文未随本条观察返回'}</p>
    <details open={expanded} onToggle={event => onExpand?.(event.currentTarget.open)}><summary>查看原输入</summary>
      {detail}
    </details>
    </>}
  </li>
}

export type InputMailboxDisplayRow = { key: string; time: number; node: ReactNode }

/** A journal reader. Opening, copying and refreshing never dispatch an input or grant control. */
export function InputMailboxRecords({ mailbox, hostId, reading, onCopy, renderLocal, renderRelated, inputGroup, renderRecords, refreshInParent = false, coverageInParent = false, compact = false, query = '', selection }: {
  mailbox: ReturnType<typeof useAgentInputMailbox>; hostId: string; reading?: ConversationReadingProps | undefined
  onCopy?: ((text: string) => Promise<boolean>) | undefined
  /** The containing surface already owns one refresh action for this reader. */
  refreshInParent?: boolean
  coverageInParent?: boolean
  /** Filters only loaded original bodies, using the same literal query as input history. */
  query?: string
  /** A containing reader may own detail navigation and return focus. */
  selection?: { key: string | null; onOpen(key: string, event: MouseEvent<HTMLButtonElement>): void }
  /** Use the mailbox record face while retaining this reader's original selection and details. */
  compact?: boolean
  renderRecords?(rows: readonly InputMailboxDisplayRow[], selectedDetail: ReactNode): ReactNode
  renderLocal?(item: AgentInputMailboxItem): ReactNode
  /** Original history contributions already related by Core; no identity inference here. */
  renderRelated?(item: AgentInputMailboxItem): ReactNode
  /** Core owns author consensus and source membership; receipts and actions remain original. */
  inputGroup?(item: AgentInputMailboxItem): SessionInputGroup | undefined
}) {
  const [localSelected, setSelected] = useState<string | null>(null)
  const selected = selection ? selection.key : localSelected
  let selectedDetail: ReactNode = null
  const failures = new Map(mailbox.failures.map(item => [inputMailboxItemKey(hostId,item),item]))
  const records = mailbox.items.filter(item => !query || inputMailboxPresentation(item).text?.includes(query)).map(item => {
    const key = inputMailboxItemKey(hostId, item), expanded = selected === key
    const props: InputMailboxRecordProps = { item, hostId, failed: failures.get(key), reading, onCopy, compact, expanded,
      externalSelection: Boolean(selection),
      onOpen: (key, event) => selection ? selection.onOpen(key, event) : setSelected(current => current === key ? null : key),
      onExpand: open => { if (open) setSelected(key); else if (expanded) setSelected(null) },
      local: expanded ? renderLocal?.(item) : null, related: expanded ? renderRelated?.(item) : null, group: inputGroup?.(item) }
    if (expanded) selectedDetail = <InputMailboxRecord {...props} detailOnly />
    return { key, time: item.recordedAt, node: <InputMailboxRecord key={key} {...props} /> }
  })
  return <InputMailboxFrame mailbox={mailbox} hostId={hostId} selected={Boolean(selected)} compact={compact}
    refreshInParent={refreshInParent} coverageInParent={coverageInParent}>
    {renderRecords ? renderRecords(records, selectedDetail) : records.length ? <ol className="input-history__records" aria-label="已登记的发送记录">{records.map(record => record.node)}</ol> : !mailbox.loading && mailbox.page ? <p className="input-history__notice">本次读取未返回已登记输入；未登记的原输入仍未确认。</p> : null}
  </InputMailboxFrame>
}

/** Coverage and recovery of the original reader, independent of its row composition. */
export function InputMailboxFrame({ mailbox, hostId, selected = false, compact = false,
  refreshInParent = false, coverageInParent = false, children }: {
  mailbox: ReturnType<typeof useAgentInputMailbox>; hostId: string; selected?: boolean; compact?: boolean
  refreshInParent?: boolean; coverageInParent?: boolean; children: ReactNode
}) {
  const failures = new Map(mailbox.failures.map(item => [inputMailboxItemKey(hostId, item), item]))
  const retainedPrior = mailbox.items.some(item => {
    const failed = failures.get(inputMailboxItemKey(hostId,item))
    return failed && failed !== item
  })
  return <section className="input-history input-mailbox" aria-label="发送信箱" data-input-mailbox-scope={mailbox.scope} data-compact={compact || undefined}>
    {!compact || !refreshInParent ? <div className="input-history__actions">{compact ? null : <strong>发送记录</strong>}{refreshInParent ? null : <button type="button" disabled={mailbox.loading} onClick={() => void mailbox.refresh()}>刷新发送记录</button>}</div> : null}
    {coverageInParent ? null : <p className="input-history__coverage" role="status">{mailbox.loading ? '正在读取已登记输入…' : '已登记输入 · 更早历史未确认'}</p>}
    {mailbox.error ? <p className="input-history__notice" role="status">{mailbox.error}</p> : null}
    {mailbox.failures.length ? <p className="input-history__notice" role="status">{retainedPrior ? '当前观察未确认；此前已读记录保留。' : '部分输入当前观察未确认。'}</p> : null}
    {children}
    {!selected && mailbox.hasMore ? <button type="button" disabled={mailbox.loading} onClick={() => void mailbox.loadEarlier()}>读取更早的发送记录</button> : null}
  </section>
}
