import type { MouseEvent, ReactNode } from 'react'

/** The list only reads a bounded original prefix. Full content belongs to the selected record. */
export function mailboxPreview(text: string | undefined) { return text?.slice(0, 240) || 'No text recorded.' }

export function MailboxTime({ value, complete = false }: { value: number | undefined; complete?: boolean }) {
  const time = value !== undefined && Number.isFinite(value) && value >= 0 ? new Date(value) : undefined
  return time && !Number.isNaN(time.getTime())
    ? <time dateTime={time.toISOString()} title={time.toLocaleString()}>{complete ? time.toLocaleString() : time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
    : <span>Time not recorded</span>
}

export function MailboxRecordRow({ recordKey, label, text, metadata, onOpen }: {
  recordKey: string; label: string; text: string | undefined; metadata: ReactNode
  onOpen: (key: string, event: MouseEvent<HTMLButtonElement>) => void
}) {
  return <button type="button" className="composer-mailbox__row" data-record-key={recordKey}
    aria-label={`Read ${label}: ${mailboxPreview(text)}`} onClick={event => onOpen(recordKey, event)}>
    <strong>{label}</strong><span className="composer-mailbox__preview">{mailboxPreview(text)}</span>
    <span className="composer-mailbox__metadata">{metadata}<span>Read full message</span></span>
  </button>
}
