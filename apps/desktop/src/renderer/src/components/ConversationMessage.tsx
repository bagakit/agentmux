import type { AgentProviderId, AgentTimelineItemStatus } from '@agentmux/core'
import { Copy } from 'lucide-react'
import { useRef, useState } from 'react'
import { formatClock, formatOffset } from '../lib/activity-ruler'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import type { ConversationSpeaker } from '../lib/conversation-speaker'
import { AgentMarkdown, type LinkClickModifiers, type OpenWorkspaceFile } from './AgentMarkdown'
import type { ReadPastedImage } from './ConversationImage'
import { ConversationSpeakerAvatar } from './ConversationSpeakerAvatar'
import { SemanticIcon } from './semantic-icons'

export type ConversationMessageProps = {
  messageId?: string
  speaker: ConversationSpeaker
  name?: string
  providerId?: AgentProviderId
  content: string
  status: AgentTimelineItemStatus
  createdAt: number
  origin: number
  workspaceRoot?: string
  openWorkspaceFile?: OpenWorkspaceFile
  readPastedImage?: ReadPastedImage
  openHttpLink?: (url: string, event: LinkClickModifiers) => void
  onContinue?: () => void
  onAnnotate?: (annotation: ConversationAnnotation) => void
}

export type ConversationAnnotation = {
  messageId: string
  quote: string
  start: number
  end: number
  note: string
}

/** A readable message, shared by the live Activity feed and Gallery. The host owns identity
 * resolution, timeline ordering, file destinations and continuation; this component owns display. */
export function ConversationMessage({
  speaker, name, providerId, content, status, createdAt, origin, workspaceRoot = '', messageId = '',
  openWorkspaceFile, readPastedImage, openHttpLink, onContinue, onAnnotate
}: ConversationMessageProps) {
  const displayName = name ?? (speaker.role === 'human' ? 'You' : 'Assistant')
  const bodyRef = useRef<HTMLDivElement>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [selection, setSelection] = useState<{ quote: string; start: number; end: number } | null>(null)
  const [note, setNote] = useState('')
  function captureSelection(): void {
    const current = window.getSelection()
    if (!current || current.isCollapsed || !bodyRef.current || !current.rangeCount) return
    const range = current.getRangeAt(0)
    if (!bodyRef.current.contains(range.commonAncestorContainer)) return
    const quote = current.toString().trim()
    if (!quote) return
    const start = content.indexOf(quote)
    setSelection({ quote, start: Math.max(0, start), end: Math.max(0, start) + quote.length })
  }
  async function copyMessage(): Promise<void> {
    const accepted = await copyTextToClipboard(content, () => setCopyState('failed'))
    setCopyState(accepted ? 'copied' : 'failed')
    if (accepted) window.setTimeout(() => setCopyState('idle'), 1600)
  }
  function submitAnnotation(): void {
    if (!selection || !note.trim() || !onAnnotate) return
    onAnnotate({ messageId, quote: selection.quote, start: selection.start, end: selection.end, note: note.trim() })
    setNote('')
    setSelection(null)
    window.getSelection()?.removeAllRanges()
  }
  return (
    <div className="log-turn" data-speaker-role={speaker.role} data-status={status}>
      <span className="log-turn__node" aria-hidden="true">
        <ConversationSpeakerAvatar
          speaker={speaker}
          name={displayName}
          size={20}
          {...(providerId === undefined ? {} : { providerId })}
        />
      </span>
      <div className="log-turn__head">
        <span className="log-turn__who">{displayName}</span>
        {status === 'streaming' ? (
          <span className="log-row__chip" role="status"><SemanticIcon name="working" size={12} />Streaming</span>
        ) : null}
        {status === 'failed' ? (
          <span className="log-row__chip log-row__chip--failed" role="status"><SemanticIcon name="failed" size={12} />Failed</span>
        ) : null}
        <span className="log-turn__time" title={`${formatClock(createdAt)} · ${formatOffset(createdAt, origin)} from start`}>
          {formatClock(createdAt)}
        </span>
        {content ? <span className="log-turn__actions">
          <button type="button" className="log-turn__action" onClick={() => { void copyMessage() }} title="Copy message" aria-label={copyState === 'copied' ? 'Message copied' : 'Copy message'}>
            <Copy size={13} />{copyState === 'copied' ? <span>Copied</span> : null}
          </button>
        </span> : null}
      </div>
      {content ? (
        <div ref={bodyRef} className="log-turn__body" onMouseUp={captureSelection} onKeyUp={captureSelection}>
          <AgentMarkdown
            content={content}
            workspaceRoot={workspaceRoot}
            {...(openWorkspaceFile ? { openWorkspaceFile } : {})}
            {...(readPastedImage ? { readPastedImage } : {})}
            {...(openHttpLink ? { openHttpLink } : {})}
          />
        </div>
      ) : null}
      {selection && onAnnotate ? <div className="log-turn__annotation" role="dialog" aria-label="Annotate selected text">
        <div className="log-turn__annotation-quote">“{selection.quote}”</div>
        <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Leave a note for this Agent…" autoFocus />
        <div className="log-turn__annotation-actions"><button type="button" className="small-button" onClick={() => setSelection(null)}>Cancel</button><button type="button" className="primary-button" disabled={!note.trim()} onClick={submitAnnotation}>Add note to reply</button></div>
      </div> : null}
      {onContinue ? <button type="button" className="log-turn__continue" onClick={onContinue}>Continue from here</button> : null}
    </div>
  )
}
