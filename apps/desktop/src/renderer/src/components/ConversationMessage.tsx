import type { AgentProviderId, AgentSessionHistoryContentPart, AgentTimelineItemStatus } from '@agentmux/core'
import { Copy } from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'
import { formatClock, formatOffset } from '../lib/activity-ruler'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import type { ConversationSpeaker } from '../lib/conversation-speaker'
import { AgentMarkdown, type LinkClickModifiers, type OpenWorkspaceFile } from './AgentMarkdown'
import type { ReadPastedImage } from './ConversationImage'
import { ConversationSpeakerAvatar } from './ConversationSpeakerAvatar'
import { ConversationToolTrace } from './ConversationToolTrace'
import { ComposerTextarea } from './ComposerTextarea'
import { SemanticIcon } from './semantic-icons'

const MemoizedAgentMarkdown = memo(AgentMarkdown)

export type ConversationMessageProps = {
  messageId?: string
  speaker?: ConversationSpeaker
  name?: string
  providerId?: AgentProviderId
  content: string | readonly AgentSessionHistoryContentPart[]
  status?: AgentTimelineItemStatus
  createdAt?: number
  origin?: number
  workspaceRoot?: string
  openWorkspaceFile?: OpenWorkspaceFile
  readPastedImage?: ReadPastedImage
  openHttpLink?: (url: string, event: LinkClickModifiers) => void
  onContinue?: () => void
  onAnnotate?: (annotation: ConversationAnnotation) => void
  expandedTraces?: ReadonlySet<string>
  onToggleTrace?: (traceId: string, open: boolean) => void
}

export type ConversationAnnotation = {
  messageId: string
  quote: string
  note: string
}

export function traceDisclosureKey(messageId: string, partKey: string): string {
  return JSON.stringify([messageId, partKey])
}

export function parseTraceDisclosureKey(key: string): [messageId: string, partKey: string] | null {
  try {
    const parsed = JSON.parse(key)
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return [parsed[0], parsed[1]]
    }
  } catch {
    // Unknown disclosure keys do not identify a record.
  }
  return null
}

function partText(part: AgentSessionHistoryContentPart): string {
  if (part.kind === 'text' || part.kind === 'reasoning') return part.text
  if (part.kind === 'tool-call') return `${part.name}\n${part.input}`
  if (part.kind === 'tool-result') return `${part.name ?? 'Tool result'}\n${part.output}`
  return part.label === undefined ? part.reference : `${part.label}\n${part.reference}`
}

/** A readable message, shared by Activity, native history and Gallery. The host owns identity
 * resolution, timeline ordering, file destinations and continuation; this component owns display. */
export function ConversationMessage({
  speaker, name, providerId, content, status, createdAt, origin, workspaceRoot = '', messageId = '',
  openWorkspaceFile, readPastedImage, openHttpLink, onContinue, onAnnotate, expandedTraces, onToggleTrace
}: ConversationMessageProps) {
  const isStringContent = typeof content === 'string'
  const parts: readonly AgentSessionHistoryContentPart[] = isStringContent
    ? [{ kind: 'text', text: content }]
    : content
  const hasContent = parts.some((part) => partText(part).length > 0)
  const displayName = name ?? (speaker?.role === 'human' ? 'You' : speaker ? 'Assistant' : 'Activity')
  // Native parts have no annotation offset contract. Live string annotations retain their original
  // quote and note; read-only callers do not collect selection state.
  const canAnnotate = onAnnotate !== undefined && typeof content === 'string'
  const bodyRef = useRef<HTMLDivElement>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const activeCopyActionRef = useRef(0)
  const copyTimerRef = useRef<number | null>(null)
  const [selection, setSelection] = useState<{ quote: string } | null>(null)
  const [note, setNote] = useState('')

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
        copyTimerRef.current = null
      }
      ++activeCopyActionRef.current
    }
  }, [])

  function captureSelection(): void {
    if (!canAnnotate || typeof content !== 'string') return
    const current = window.getSelection()
    if (!current || current.isCollapsed || !bodyRef.current || !current.rangeCount) return
    const range = current.getRangeAt(0)
    if (!bodyRef.current.contains(range.commonAncestorContainer)) return
    const quote = current.toString().trim()
    if (!quote) return
    setSelection({ quote })
  }

  async function copyMessage(): Promise<void> {
    const actionId = ++activeCopyActionRef.current
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current)
      copyTimerRef.current = null
    }
    const text = parts.map(partText).join('\n')
    const accepted = await copyTextToClipboard(text, () => {
      if (activeCopyActionRef.current === actionId) {
        setCopyState('failed')
      }
    })
    if (activeCopyActionRef.current !== actionId) return
    if (accepted) {
      setCopyState('copied')
      copyTimerRef.current = window.setTimeout(() => {
        if (activeCopyActionRef.current === actionId) {
          setCopyState('idle')
          copyTimerRef.current = null
        }
      }, 1600)
    } else {
      setCopyState('failed')
    }
  }

  function submitAnnotation(): void {
    if (!selection || !note.trim() || !onAnnotate) return
    onAnnotate({ messageId, quote: selection.quote, note: note.trim() })
    setNote('')
    setSelection(null)
    window.getSelection()?.removeAllRanges()
  }

  const occurrenceCounts = new Map<string, number>()
  function partKey(part: AgentSessionHistoryContentPart): string {
    if (isStringContent) return 'text'
    const callId = (part.kind === 'tool-call' || part.kind === 'tool-result') ? (part.callId ?? null) : null
    const occKey = JSON.stringify([part.kind, callId])
    const occ = occurrenceCounts.get(occKey) ?? 0
    occurrenceCounts.set(occKey, occ + 1)
    return JSON.stringify([part.kind, callId, occ])
  }

  return (
    <div className="log-turn" data-speaker-role={speaker?.role} data-status={status}>
      <span className="log-turn__node" aria-hidden="true">
        {speaker ? <ConversationSpeakerAvatar
          speaker={speaker}
          name={displayName}
          size={20}
          {...(providerId === undefined ? {} : { providerId })}
        /> : <SemanticIcon name="neutral" size={12} />}
      </span>
      <div className="log-turn__head">
        <span className="log-turn__who">{displayName}</span>
        {status === 'streaming' ? (
          <span className="log-row__chip" role="status"><SemanticIcon name="working" size={12} />Streaming</span>
        ) : null}
        {status === 'failed' ? (
          <span className="log-row__chip log-row__chip--failed" role="status"><SemanticIcon name="failed" size={12} />Failed</span>
        ) : null}
        {createdAt === undefined ? null : <span className="log-turn__time" title={origin === undefined
          ? formatClock(createdAt) : `${formatClock(createdAt)} · ${formatOffset(createdAt, origin)} from start`}>
          {formatClock(createdAt)}
        </span>}
        {hasContent ? <span className="log-turn__actions" data-copy-state={copyState}>
          {copyState === 'failed' ? (
            <span className="log-turn__copy-error" role="alert">Copy failed</span>
          ) : null}
          <button type="button" className="log-turn__action" onClick={() => { void copyMessage() }} title="Copy message" aria-label={copyState === 'copied' ? 'Message copied' : 'Copy message'}>
            <Copy size={13} />{copyState === 'copied' ? <span>Copied</span> : null}{copyState === 'failed' ? <span>Retry</span> : null}
          </button>
        </span> : null}
      </div>
      {hasContent ? (
        <div ref={bodyRef} className="log-turn__body"
          onMouseUp={canAnnotate ? captureSelection : undefined} onKeyUp={canAnnotate ? captureSelection : undefined}>
          {parts.map((part) => {
            const key = partKey(part)
            return part.kind === 'text' ? <MemoizedAgentMarkdown
              key={key}
              content={part.text}
              workspaceRoot={workspaceRoot}
              {...(openWorkspaceFile ? { openWorkspaceFile } : {})}
              {...(readPastedImage ? { readPastedImage } : {})}
              {...(openHttpLink ? { openHttpLink } : {})}
            /> : part.kind === 'tool-call' || part.kind === 'tool-result' ? (
              <ConversationToolTrace key={key} part={part} workspaceRoot={workspaceRoot}
                traceId={traceDisclosureKey(messageId, key)}
                {...(expandedTraces ? { expanded: expandedTraces.has(traceDisclosureKey(messageId, key)) } : {})}
                {...(onToggleTrace ? { onToggle: (open) => onToggleTrace(traceDisclosureKey(messageId, key), open) } : {})} />
            ) : part.kind === 'reasoning' ? (
              <details key={key} className="log-turn__trace" data-trace-kind={part.kind}
                data-trace-id={traceDisclosureKey(messageId, key)}
                open={expandedTraces ? expandedTraces.has(traceDisclosureKey(messageId, key)) : undefined}
                onToggle={onToggleTrace ? (event) => onToggleTrace(traceDisclosureKey(messageId, key), event.currentTarget.open) : undefined}>
                <summary>Reasoning</summary>
                <pre>{part.text}</pre>
              </details>
            ) : <div key={key} className="log-turn__resource">
              <span>{part.label ?? `${part.resourceType} resource`}</span>
              <code>{part.reference}</code>
              <small>Resource reference; preview is not available here.</small>
            </div>
          })}
        </div>
      ) : null}
      {selection && onAnnotate ? <div className="log-turn__annotation" role="dialog" aria-label="Annotate selected text">
        <div className="log-turn__annotation-quote">“{selection.quote}”</div>
        <ComposerTextarea value={note} onValueChange={setNote} placeholder="Leave a note for this Agent…" autoFocus />
        <div className="log-turn__annotation-actions"><button type="button" className="small-button" onClick={() => setSelection(null)}>Cancel</button><button type="button" className="primary-button" disabled={!note.trim()} onClick={submitAnnotation}>Add note to reply</button></div>
      </div> : null}
      {onContinue ? <button type="button" className="log-turn__continue" onClick={onContinue}>Continue from here</button> : null}
    </div>
  )
}
