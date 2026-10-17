import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MailboxRecordRow as RecordRow, type MailboxRecordRowProps } from '@agentmux/client-ui/components/MailboxRecordRow'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { parseAgentMuxMessagePrefix } from '@agentmux/core/agent-message-render'

const ThemeObjectInboxIcon = semanticIconComponent('object.inbox')
const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')
const DraftIcon = semanticIconComponent('action.paste')
const CopyIcon = semanticIconComponent('action.copy')
const DoneIcon = semanticIconComponent('status.selected')
const WarningIcon = semanticIconComponent('status.warning')

export function MailboxSourceNotice({ title, message, action, onAction }: { title: string; message: string; action: string; onAction(): void }) {
  return <div className="composer-mailbox__source-notice"><details><summary>{title}</summary><p>{message}</p><p>Existing records are kept. {action} to read this same source again.</p></details>
    <button type="button" className="composer-tool" onClick={onAction} title={action} aria-label={action}><ThemeActionRefreshIcon size={14} aria-hidden="true" /></button></div>
}


/** The list only reads a bounded original prefix. Full content belongs to the selected record. */
export function mailboxPreview(text: string | undefined) {
  const snippet = text?.slice(0, 240) ?? ''
  const body = parseAgentMuxMessagePrefix(snippet)?.body
  return body?.trim() ? body : snippet || 'No text recorded.'
}

export function MailboxTime({ value, complete = false }: { value: number | undefined; complete?: boolean }) {
  const time = value !== undefined && Number.isFinite(value) && value >= 0 ? new Date(value) : undefined
  return time && !Number.isNaN(time.getTime())
    ? <time dateTime={time.toISOString()} title={time.toLocaleString()}>{complete ? time.toLocaleString() : time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
    : <span>Time not recorded</span>
}

export function MailboxRecordRow({ text, bodyPreview, ...props }: Omit<MailboxRecordRowProps, 'preview'> & {
  text: string | undefined
  /** Already bounded by the original message owner; never reinterpret authored body as an outer envelope. */
  bodyPreview?: string
}) {
  const preview = bodyPreview === undefined ? mailboxPreview(text) : bodyPreview || 'No text recorded.'
  return <RecordRow {...props} preview={preview} />
}

export function MailboxEmpty({ title, hint }: { title: string; hint?: string }) {
  return <div className="composer-mailbox__empty"><ThemeObjectInboxIcon size={16} aria-hidden="true" /><strong>{title}</strong>{hint ? <p>{hint}</p> : null}</div>
}

/** Feedback belongs to this mounted record, never to another selection or target. */
function MailboxAsyncAction({ label, title, icon, onRun, value }: { label: string; title: string; icon: ReactNode; value?: string | undefined; onRun(): Promise<string> }) {
  const [feedback, setFeedback] = useState<{ pending: boolean; failed: boolean; text: string } | null>(null)
  const generation = useRef(0), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => { setFeedback(null); return () => { ++generation.current; clearTimeout(timer.current) } }, [value])
  return <><button type="button" className="composer-tool" aria-label={label} title={title} disabled={feedback?.pending}
    aria-busy={feedback?.pending || undefined} onClick={async () => {
      const own = ++generation.current
      clearTimeout(timer.current)
      setFeedback({ pending: true, failed: false, text: '正在读取原正文…' })
      try {
        const text = await onRun()
        if (own === generation.current) {
          setFeedback({ pending: false, failed: false, text })
          timer.current = setTimeout(() => { if (own === generation.current) setFeedback(null) }, 1600)
        }
      } catch (error) {
        if (own === generation.current) setFeedback({ pending: false, failed: true, text: error instanceof Error ? error.message : String(error) })
      }
    }}>{feedback && !feedback.pending ? feedback.failed ? <WarningIcon size={14} /> : <DoneIcon size={14} /> : icon}</button>
    {feedback ? <span className="composer-mailbox__action-feedback" role="status">{feedback.text}</span> : null}</>
}

/** Draft reuse is explicit and never changes the original mail or its delivery state. */
export function MailboxDraftAction({ onFill, value }: { value?: string | undefined; onFill(): Promise<string | void> }) {
  return <MailboxAsyncAction value={value} label="填入草稿" title="将原正文插入光标位置，保留已有草稿与原记录；不会发送"
    icon={<DraftIcon size={14} />} onRun={async () => (await onFill()) ?? '已插入草稿，尚未发送'} />
}

export function MailboxCopyAction({ onCopy, value }: { value?: string | undefined; onCopy(): Promise<boolean> }) {
  return <MailboxAsyncAction value={value} label="复制全文" title="复制原记录的完整正文" icon={<CopyIcon size={14} />} onRun={async () => {
    if (!await onCopy()) throw new Error('复制未完成，原记录保留。')
    return '已复制全文'
  }} />
}
