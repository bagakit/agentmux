import { DeliveryLogDetails } from '@agentmux/client-ui/components/DeliveryLogDetails'
import { messageDeliveryDiagnostics } from '../lib/message-delivery-diagnostics'
import { MailboxLocationContext } from './MailboxLocationContext'
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { ComposerQueuedMessageEditor, type EditQueuedMessage } from './ComposerQueuedMessageEditor'
import { ArrowUp, ArrowDown, Pencil, Archive, ArchiveRestore, Copy, Check, TriangleAlert } from 'lucide-react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { ConversationMessage, type ConversationReadingProps } from '@agentmux/client-ui/components/ConversationMessage'
import { ConversationSpeakerAvatar } from './ConversationSpeakerAvatar'
import { UNKNOWN_SPEAKER_ID } from '@agentmux/client-ui/conversation-speaker'
import { MailboxRecordRow, MailboxTime } from './MailboxReading'

export type ComposerQueuedMessage = {
  id: string
  text: string
  enqueuedAt?: number
  status: 'queued' | 'restoring' | 'deferred' | 'failed'
  deliverable: boolean
  editable?: boolean
  immediateSend?: boolean
  preparing?: boolean
  sending?: boolean
  unconfirmed?: boolean
  errorCode?: string
  error?: string
  logId?: string
  awaitingExplicitSend?: true
  archived?: true
  confirmed?: boolean
}

/** Labels describe the queue owner's facts, not native CLI rendering or model progress. */
export function queuedMessageState(entry: ComposerQueuedMessage, pendingInteraction = false) {
  if (entry.archived) return { label: entry.confirmed ? '已归档 · 输入已确认' : '已归档', detail: entry.confirmed ? '原输入已由 Core 确认；归档不会撤回输入。可在 History 读取原记录，不能恢复为待发。' : `这条原消息已退出待发队列，不会自动发送。${entry.unconfirmed ? '\n此前是否已输入仍待核实；归档保留原操作，恢复也不会重建或重发。' : ''}${entry.error ? `\n此前记录：${entry.error}` : ''}`, busy: false }
  if (entry.preparing) return { label: entry.status === 'restoring' ? '恢复中' : '准备发送', detail: '正在准备本次发送；原消息和已有投递记录会保留。', busy: true }
  if (entry.sending) return { label: '发送中', detail: '正在提交原消息，等待投递确认。', busy: true }
  if (pendingInteraction) return { label: '等待回答', detail: '先回答 Agent 当前请求；消息与原文会保留。', busy: false }
  if (entry.errorCode === 'AGENT_PROMPT_PREPARATION_FAILED') return { label: '本次准备未完成', detail: `${entry.error ?? '本次发送的准备步骤未完成。'}${entry.unconfirmed ? '\n这条消息此前是否已提交仍待核实；会保留原操作，不会自动重发。' : ''}${entry.awaitingExplicitSend ? '\n重启后等待你明确发送这条原消息。' : ''}`, busy: false }
  if (entry.unconfirmed) return { label: '发送结果待核实', detail: `${entry.error ?? '可能已经输入，但尚未拿到完整确认；请检查原对话和操作，不会自动重发。'}${entry.awaitingExplicitSend ? '\n重启后等待你明确发送这条原消息。' : ''}`, busy: false }
  if (!entry.deliverable) return { label: '原 Run 不可投递', detail: entry.error ?? '绑定的 Run 不可用或已改变，不会投递到其他 Run。', busy: false }
  if (entry.awaitingExplicitSend) return { label: '待手动发送', detail: `重启后等待你明确发送这条原消息。${entry.error ? `\n此前记录：${entry.error}` : ''}`, busy: false }
  if (entry.errorCode === 'AGENT_TURN_END_UNCONFIRMED') return { label: '等待当轮确认', detail: entry.error ?? '上一轮尚未确认结束；消息已保留，可明确发送这条消息。', busy: false }
  if (entry.errorCode === 'AGENT_PROMPT_SUBMISSION_BUSY') return { label: '等待前条提交', detail: entry.error ?? '原 Run 的前条提交尚未完成，消息已保留。', busy: false }
  if (entry.error || entry.status === 'failed') return { label: '待处理', detail: entry.error ?? '投递失败，原文已保留。', busy: false }
  return { label: '排队中', detail: '尚未发送。点击发送只提交这条消息；其他消息继续保留。', busy: false }
}

/** A retained queue record is not a submission receipt or a conversation position. */
export function queuedMessageLocation(entry: ComposerQueuedMessage) {
  if (entry.confirmed) return '原输入已确认，可在 History 读取'
  if (entry.archived) return entry.unconfirmed ? '已归档；此前输入结果待核实' : '已归档；不会自动发送'
  if (entry.preparing) return '准备发送，对话位置暂不可用'
  if (entry.sending) return '正在提交，对话位置等待确认'
  if (entry.unconfirmed) return '发送结果待核实，对话位置暂不可用'
  if (!entry.deliverable || entry.error || entry.status === 'failed') return '暂无已确认的对话位置'
  return '尚未发送，暂无对话位置'
}

export type ArchiveQueuedMessage = (id: string, expectedText: string, archived: boolean) => Promise<void>

function CopyQueuedMessage({ entry, onCopy }: { entry: ComposerQueuedMessage; onCopy(text: string): Promise<boolean> }) {
  const [result, setResult] = useState<{text: string; accepted: boolean} | null>(null)
  const action = useRef(0), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => { ++action.current; clearTimeout(timer.current) }, [])
  const accepted = result?.text === entry.text ? result.accepted : undefined
  return <button type="button" className="composer-tool composer-pending__copy" aria-label="复制这条待发消息" data-copy-state={accepted === undefined ? 'idle' : accepted ? 'copied' : 'failed'}
    title={accepted === undefined ? '复制全文' : accepted ? '已复制' : '复制未确认，请重试'} onClick={async () => {
      const current = ++action.current; clearTimeout(timer.current); let copied = false
      try { copied = (await onCopy(entry.text)) === true } catch { /* Existing clipboard owner reports its cause. */ }
      if (current !== action.current) return
      setResult({text:entry.text,accepted:copied})
      timer.current = setTimeout(() => { if (current === action.current) setResult(null) },1600)
    }}>{accepted ? <Check size={14} /> : accepted === false ? <TriangleAlert size={14} /> : <Copy size={14} />}</button>
}

function QueuedDeliveryLog({ logId, copy }: { logId: string; copy?: ((text: string) => Promise<boolean>) | undefined }) {
  const [log, setLog] = useState(() => messageDeliveryDiagnostics.get(logId))
  useEffect(() => {
    setLog(messageDeliveryDiagnostics.get(logId))
    return messageDeliveryDiagnostics.subscribe(() => setLog(messageDeliveryDiagnostics.get(logId)))
  }, [logId])
  return <DeliveryLogDetails logId={logId} log={log} copyText={copy ?? (async () => false)} />
}

export function ComposerOutbox({ queued, selectedId, onSelect, onCopy, onArchive, onHistory, onMove, onSend, onEdit, sendImmediately = false, reading, sessionId, pendingInteraction = false }: {
  pendingInteraction?: boolean
  reading?: ConversationReadingProps | undefined
  sessionId?: string | undefined
  queued: readonly ComposerQueuedMessage[]
  selectedId: string | null
  onSelect: (id: string, event: MouseEvent<HTMLButtonElement>) => void
  onCopy?: (text: string) => Promise<boolean>
  onArchive?: ArchiveQueuedMessage | undefined
  onHistory?: ((id: string) => void) | undefined
  onMove?: (id: string, direction: 'up' | 'down') => void
  onSend?: (id: string) => void
  onEdit?: EditQueuedMessage
  sendImmediately?: boolean
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [failure, setFailure] = useState<{id:string;text:string;message:string} | null>(null)
  if (!queued.length) return null
  return <section className="composer-outbox" aria-label={queued[0]?.archived ? 'Archived messages' : 'Queued messages'}>
    <h3>{queued[0]?.archived ? 'Archived' : 'Pending'} ({queued.length})</h3>
    <ol className="composer-mailbox__messages">
      {queued.map((entry,index) => {
        const selected = selectedId === entry.id, state = queuedMessageState(entry,pendingInteraction)
        const canSend = !entry.archived && !state.busy && editingId !== entry.id
        const ownFailure = failure?.id === entry.id && failure.text === entry.text ? failure.message : null
        return <li key={entry.id} data-state={entry.status} data-operation-id={entry.id} data-archived={Boolean(entry.archived)}>
          <MailboxRecordRow recordKey={`queue:${entry.id}`} label={state.label}
            avatar={<ConversationSpeakerAvatar speaker={{role:'unknown',id:UNKNOWN_SPEAKER_ID}} name="Author unknown" size={18} />}
            text={entry.text} metadata={<MailboxTime value={entry.enqueuedAt} />}
            onOpen={(_key,event) => { if (!editingId) onSelect(entry.id,event) }} />
          <div className="composer-mailbox__record-actions composer-outbox__actions">
            {!entry.archived && onSend ? <button key="send" type="button" className="composer-tool" disabled={!canSend}
              aria-label={(entry.immediateSend ?? sendImmediately) ? 'Send queued message immediately' : 'Send queued message'} title={canSend ? '只发送这条原消息' : state.detail}
              onClick={() => onSend(entry.id)}><ArrowUp size={14} /></button> : null}
            {onCopy ? <CopyQueuedMessage key="copy" entry={entry} onCopy={onCopy} /> : null}
            {!entry.archived && onEdit ? <button key="edit" type="button" className="composer-tool" aria-label="编辑这条待发消息" title="编辑原消息，保存不会发送"
              disabled={!entry.editable || Boolean(editingId)} onClick={event => { onSelect(entry.id,event); setEditingId(entry.id) }}><Pencil size={14} /></button> : null}
            {selected && !entry.archived && onMove ? <>
              <button key="up" type="button" className="composer-tool" disabled={Boolean(editingId) || state.busy || index===0 || queued[index-1]?.sending || queued[index-1]?.preparing} onClick={() => onMove(entry.id,'up')} title="Move up" aria-label="Move up"><ArrowUp size={14} /></button>
              <button key="down" type="button" className="composer-tool" disabled={Boolean(editingId) || state.busy || index===queued.length-1 || queued[index+1]?.sending || queued[index+1]?.preparing} onClick={() => onMove(entry.id,'down')} title="Move down" aria-label="Move down"><ArrowDown size={14} /></button>
            </> : null}
            {onArchive ? <button key="archive" type="button" className="composer-tool" aria-label={entry.archived ? '恢复为待发' : '归档这条待发消息'}
              title={entry.archived ? entry.confirmed ? '原输入已确认，请查看 History；不能重新投递' : '恢复原条目，等待明确发送' : '归档原条目，保留原文和投递记录；不会撤回已经输入的内容'}
              disabled={state.busy || Boolean(editingId) || Boolean(entry.archived && entry.confirmed)} onClick={async () => {
                setFailure(null)
                try { await onArchive(entry.id,entry.text,!entry.archived) } catch(error) { setFailure({id:entry.id,text:entry.text,message:presentError(error)}) }
              }}>{entry.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}</button> : null}
            {entry.archived && entry.confirmed && onHistory ? <button key="history" type="button" className="composer-tool" onClick={() => onHistory(entry.id)}>History</button> : null}
          </div>
          {ownFailure ? <p role="alert" className="composer-mailbox__risk">{ownFailure}</p> : null}
          {selected ? <MailboxLocationContext sessionId={sessionId} pending>{(_summary,executionDetails) => <article className="composer-outbox__inline" data-record-key={`queue:${entry.id}`}>
            {editingId === entry.id && onEdit ? <ComposerQueuedMessageEditor key={entry.id} entry={entry} onSave={onEdit} onCancel={() => setEditingId(null)} /> : null}
            {state.busy || entry.error || entry.unconfirmed || !entry.deliverable || entry.archived ? <p className={entry.archived && (entry.confirmed || !entry.unconfirmed && !entry.error) ? 'composer-mailbox__record-note' : 'composer-mailbox__risk'} data-kind={state.busy ? 'working' : 'attention'}>{state.detail}</p> : null}
            {entry.logId ? <QueuedDeliveryLog logId={entry.logId} copy={onCopy} /> : null}
            <ConversationMessage {...reading} compact recordedIdentity messageId={`queue:${entry.id}`} speaker={{role:'unknown',id:UNKNOWN_SPEAKER_ID}} content={entry.text}
              {...(entry.enqueuedAt === undefined ? {} : {createdAt:entry.enqueuedAt})} {...(onCopy ? {onCopy} : {})}
              messageDetails={<><dl className="composer-mailbox__record-facts"><dt>Record</dt><dd>{entry.archived ? 'Archived original message' : 'Pending original message'}</dd><dt>Enqueued</dt><dd><MailboxTime value={entry.enqueuedAt} complete /></dd><dt>Delivery</dt><dd>{state.detail}</dd>{entry.errorCode ? <><dt>Code</dt><dd>{entry.errorCode}</dd></> : null}</dl>{executionDetails}</>} />
          </article>}</MailboxLocationContext> : null}
        </li>
      })}
    </ol>
  </section>
}
