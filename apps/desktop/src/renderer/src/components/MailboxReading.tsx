import type { MouseEvent, ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { parseAgentMuxMessagePrefix } from '@agentmux/core/agent-message-render'

const ThemeObjectInboxIcon = semanticIconComponent('object.inbox')


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

export function MailboxRecordRow({ recordKey, label, text, metadata, avatar, onOpen }: {
  recordKey: string; label: string; text: string | undefined; metadata: ReactNode; avatar?: ReactNode
  onOpen: (key: string, event: MouseEvent<HTMLButtonElement>) => void
}) {
  const preview = mailboxPreview(text)
  return <button type="button" className="composer-mailbox__row" data-record-key={recordKey}
    aria-label={`Read ${label}: ${preview}`} onClick={event => onOpen(recordKey, event)}>
    <span className="composer-mailbox__row-head">{avatar}<strong>{label}</strong><span className="composer-mailbox__metadata">{metadata}</span></span>
    <span className="composer-mailbox__preview">{preview}</span>
  </button>
}

export function MailboxEmpty({ title, hint }: { title: string; hint?: string }) {
  return <div className="composer-mailbox__empty"><ThemeObjectInboxIcon size={22} aria-hidden="true" /><strong>{title}</strong>{hint ? <p>{hint}</p> : null}</div>
}
