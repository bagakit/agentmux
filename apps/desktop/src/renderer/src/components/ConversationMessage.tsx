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
import { ConversationReasoningTrace } from './ConversationReasoningTrace'
import type { ConversationAnnotationSelection } from './ConversationAnnotationNote'
import { SemanticIcon } from './semantic-icons'

const MemoizedAgentMarkdown = memo(AgentMarkdown)

export type ConversationMessageProps = {
  messageId?: string
  speaker?: ConversationSpeaker
  name?: string
  providerId?: AgentProviderId
  content: string | readonly AgentSessionHistoryContentPart[]
  status?: AgentTimelineItemStatus | 'unverified'
  createdAt?: number
  origin?: number
  workspaceRoot?: string
  openWorkspaceFile?: OpenWorkspaceFile
  readPastedImage?: ReadPastedImage
  openHttpLink?: (url: string, event: LinkClickModifiers) => void
  onContinue?: () => void
  onSelectAnnotation?: (selection: ConversationAnnotationSelection) => void
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
  if (part.kind === 'text') return part.text
  if (part.kind === 'reasoning') return part.redacted ? '' : part.text
  if (part.kind === 'tool-call') return `${part.name}\n${part.input}`
  if (part.kind === 'tool-result') return `${part.name ?? 'Tool result'}\n${part.output}`
  return part.label === undefined ? part.reference : `${part.label}\n${part.reference}`
}

function partHasRenderableContent(part: AgentSessionHistoryContentPart): boolean {
  if (part.kind === 'reasoning' || part.kind === 'tool-call' || part.kind === 'tool-result' || part.kind === 'resource') {
    return true
  }
  return part.text.length > 0
}

/** A readable message, shared by Activity, native history and Gallery. The host owns identity
 * resolution, timeline ordering, file destinations and continuation; this component owns display. */
export function ConversationMessage({
  speaker, name, providerId, content, status, createdAt, origin, workspaceRoot = '', messageId = '',
  openWorkspaceFile, readPastedImage, openHttpLink, onContinue, onSelectAnnotation, expandedTraces, onToggleTrace
}: ConversationMessageProps) {
  const isStringContent = typeof content === 'string'
  const parts: readonly AgentSessionHistoryContentPart[] = isStringContent
    ? [{ kind: 'text', text: content }]
    : content
  const hasContent = parts.some(partHasRenderableContent)
  const hasCopyContent = parts.some((part) => partText(part).length > 0)
  const isTraceOnly = parts.length > 0 && parts.every((part) => part.kind !== 'text' || part.text.trim().length === 0)
  const isUnknownInput = speaker?.role === 'unknown'
  const rawDisplayName = name ?? (speaker?.role === 'human' ? 'You' : isUnknownInput ? 'Input' : speaker ? 'Assistant' : 'Activity')
  const displayName = isUnknownInput && (rawDisplayName === 'You' || rawDisplayName === 'Human')
    ? 'Input'
    : rawDisplayName
  const canAnnotate = onSelectAnnotation !== undefined && messageId.length > 0
  const bodyRef = useRef<HTMLDivElement>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const activeCopyActionRef = useRef(0)
  const copyTimerRef = useRef<number | null>(null)

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
    if (!canAnnotate || !onSelectAnnotation) return
    const current = window.getSelection()
    if (!current || current.isCollapsed || !bodyRef.current || !current.rangeCount) return
    const range = current.getRangeAt(0)
    const start = (range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement)?.closest<HTMLElement>('.log-turn__text')
    const end = (range.endContainer.nodeType === Node.ELEMENT_NODE ? range.endContainer as Element : range.endContainer.parentElement)?.closest<HTMLElement>('.log-turn__text')
    // A real rendered text part, never a trace/control or a cross-record range.
    if (!start || start !== end || !bodyRef.current.contains(start)) return
    const quote = range.toString()
    if (!quote.trim()) return
    onSelectAnnotation({ messageId, quote, range: range.cloneRange(), contextElement: start })
  }

  async function copyMessage(): Promise<void> {
    const actionId = ++activeCopyActionRef.current
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current)
      copyTimerRef.current = null
    }
    const text = parts.map(partText).filter((t) => t.length > 0).join('\n')
    if (!text) return
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
    <div
      className="log-turn"
      data-message-id={messageId || undefined}
      data-speaker-role={speaker?.role}
      data-status={status}
      data-trace-only={isTraceOnly ? 'true' : undefined}
    >
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
        {isUnknownInput ? (
          <span className="log-row__chip log-row__chip--unverified" role="note">作者未记录</span>
        ) : null}
        {status === 'streaming' ? (
          <span className="log-row__chip" role="status"><SemanticIcon name="working" size={12} />Streaming</span>
        ) : null}
        {status === 'failed' ? (
          <span className="log-row__chip log-row__chip--failed" role="status"><SemanticIcon name="failed" size={12} />Failed</span>
        ) : null}
        {status === 'unverified' ? (
          <span className="log-row__chip log-row__chip--unverified" role="status"><SemanticIcon name="neutral" size={12} />Unverified</span>
        ) : null}
        {createdAt === undefined ? null : <span className="log-turn__time" title={origin === undefined
          ? formatClock(createdAt) : `${formatClock(createdAt)} · ${formatOffset(createdAt, origin)} from start`}>
          {formatClock(createdAt)}
        </span>}
        {hasCopyContent ? <span className="log-turn__actions" data-copy-state={copyState}>
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
            return part.kind === 'text' ? <div key={key} className="log-turn__text" tabIndex={-1}><MemoizedAgentMarkdown
              content={part.text}
              workspaceRoot={workspaceRoot}
              {...(openWorkspaceFile ? { openWorkspaceFile } : {})}
              {...(readPastedImage ? { readPastedImage } : {})}
              {...(openHttpLink ? { openHttpLink } : {})}
            /></div> : part.kind === 'tool-call' || part.kind === 'tool-result' ? (
              <ConversationToolTrace key={key} part={part} workspaceRoot={workspaceRoot}
                traceId={traceDisclosureKey(messageId, key)}
                {...(expandedTraces ? { expanded: expandedTraces.has(traceDisclosureKey(messageId, key)) } : {})}
                {...(onToggleTrace ? { onToggle: (open) => onToggleTrace(traceDisclosureKey(messageId, key), open) } : {})} />
            ) : part.kind === 'reasoning' ? (
              <ConversationReasoningTrace
                key={key}
                part={part}
                workspaceRoot={workspaceRoot}
                traceId={traceDisclosureKey(messageId, key)}
                {...(expandedTraces ? { expanded: expandedTraces.has(traceDisclosureKey(messageId, key)) } : {})}
                {...(onToggleTrace ? { onToggle: (open) => onToggleTrace(traceDisclosureKey(messageId, key), open) } : {})}
                {...(openWorkspaceFile ? { openWorkspaceFile } : {})}
                {...(readPastedImage ? { readPastedImage } : {})}
                {...(openHttpLink ? { openHttpLink } : {})}
              />
            ) : <div key={key} className="log-turn__resource">
              <span>{part.label ?? `${part.resourceType} resource`}</span>
              <code>{part.reference}</code>
              <small>Resource reference; preview is not available here.</small>
            </div>
          })}
        </div>
      ) : null}
      {onContinue ? <button type="button" className="log-turn__continue" onClick={onContinue}>Continue from here</button> : null}
    </div>
  )
}
