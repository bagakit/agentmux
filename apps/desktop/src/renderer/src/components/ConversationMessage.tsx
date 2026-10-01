import type { AgentProviderId, AgentSessionHistoryContentPart, AgentSessionUserMessageSource, AgentTimelineItemStatus } from '@agentmux/core'
import { parseAgentMuxMessagePrefix } from '@agentmux/core/agent-message-render'
import { ChevronRight, Copy } from 'lucide-react'
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import { formatClock, formatOffset } from '../lib/activity-ruler'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { speakerForDisplay, type ConversationSpeaker, type DescribeSpeaker } from '../lib/conversation-speaker'
import { ConversationInputDetails } from './ConversationInputDetails'
import { AgentMarkdown, type LinkClickModifiers, type OpenWorkspaceFile } from './AgentMarkdown'
import type { ReadPastedImage } from './ConversationImage'
import { ConversationMessageAvatar } from './ConversationMessageAvatar'
import { ConversationToolTrace } from './ConversationToolTrace'
import { ConversationReasoningTrace } from './ConversationReasoningTrace'
import type { ConversationAnnotationSelection } from './ConversationAnnotationNote'
import { SemanticIcon } from './semantic-icons'

const MemoizedAgentMarkdown = memo(AgentMarkdown)

export type ConversationMessageProps = {
  messageId?: string
  speaker?: ConversationSpeaker
  /** Current conversation identity, supplied by its host; never inferred from a name. */
  conversationSessionId?: string
  inputSource?: AgentSessionUserMessageSource
  describeSpeaker?: DescribeSpeaker
  name?: string
  providerId?: AgentProviderId
  content: string | readonly AgentSessionHistoryContentPart[]
  status?: AgentTimelineItemStatus | 'unverified'
  createdAt?: number
  /** Host-selected clock display; the recorded instant remains unchanged. */
  timeFormatter?: (timestamp: number) => string
  origin?: number
  workspaceRoot?: string
  homeDir?: string
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
  speaker: recordedSpeaker, conversationSessionId, inputSource, describeSpeaker, name, providerId, content, status, createdAt, timeFormatter, origin, workspaceRoot = '', homeDir = '', messageId = '',
  openWorkspaceFile, readPastedImage, openHttpLink, onContinue, onSelectAnnotation, expandedTraces, onToggleTrace
}: ConversationMessageProps) {
  const renderClock = timeFormatter ?? formatClock
  const isStringContent = typeof content === 'string'
  const parts: readonly AgentSessionHistoryContentPart[] = isStringContent
    ? [{ kind: 'text', text: content }]
    : content
  const hasContent = parts.some(partHasRenderableContent)
  const hasCopyContent = parts.some((part) => partText(part).length > 0)
  const isTraceOnly = parts.length > 0 && parts.every((part) => part.kind !== 'text' || part.text.trim().length === 0)
  const speaker = recordedSpeaker ? speakerForDisplay(recordedSpeaker) : undefined
  const isPeerAgent = speaker?.role === 'agent' && speaker.id.length > 0 &&
    conversationSessionId !== undefined && conversationSessionId.length > 0 && speaker.id !== conversationSessionId
  const isSystemContext = speaker?.role === 'system'
  const isIncoming = speaker?.role === 'human' || isPeerAgent
  const prefix = useMemo(() => isIncoming && parts[0]?.kind === 'text' ? parseAgentMuxMessagePrefix(parts[0].text) : null,
    [isIncoming, parts[0]?.kind, parts[0]?.kind === 'text' ? parts[0].text : undefined])
  const isDeclaredSender = prefix !== null && !prefix.declaredContexts && recordedSpeaker?.role === 'unknown'
  const [systemContextOpen, setSystemContextOpen] = useState(false)
  const systemContentId = useId()
  const described = speaker?.role === 'agent' ? describeSpeaker?.(speaker) : undefined
  const displayProvider = described?.providerId ?? providerId
  const displayName = recordedSpeaker?.role === 'unknown'
    ? 'You'
    : described?.name ?? name ?? (speaker?.role === 'human' ? 'You' : isPeerAgent ? speaker.id : isSystemContext ? 'AgentMux' : speaker ? 'Assistant' : 'Activity')
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

  useEffect(() => { setSystemContextOpen(false) }, [messageId])

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
      data-speaker-relation={isPeerAgent ? 'other-agent' : undefined}
      data-message-direction={isIncoming ? 'incoming' : 'outgoing'}
      data-declared-source={prefix?.sourceLabel}
      data-status={status}
      data-trace-only={isTraceOnly ? 'true' : undefined}
      data-message-bubble={!isTraceOnly && (speaker?.role === 'agent' || speaker?.role === 'human') ? 'true' : undefined}
    >
      <span className="log-turn__node" aria-hidden="true">
        {speaker ? <ConversationMessageAvatar
          speaker={speaker}
          name={displayName}
          project={described?.project}
          providerId={displayProvider}
          mote={described?.mote}
        /> : <SemanticIcon name="neutral" size={12} />}
      </span>
      <div className="log-turn__head">
        <span className="log-turn__who">{isDeclaredSender ? <><span className="log-turn__source-caption">Message from </span>{prefix.sourceLabel}</> : displayName}</span>
        {described?.project ? <span className="log-turn__context" title={`${described.project.name}${described.project.branch ? ` · ${described.project.branch}` : ''} · Current project`}>{described.project.name}{described.project.branch ? <span> · {described.project.branch}</span> : null}</span> : null}
        {isDeclaredSender ? <span className="log-turn__sender-kind" title="Source written in the message header; recorded authorship is unchanged">Declared source</span> : null}
        {isPeerAgent || isSystemContext ? <span className="log-turn__sender-kind">{isSystemContext ? 'System' : 'Agent'}</span> : null}
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
          ? renderClock(createdAt) : `${renderClock(createdAt)} · ${formatOffset(createdAt, origin)} from start`}>
          {renderClock(createdAt)}
        </span>}
        {hasCopyContent ? <span className="log-turn__actions" data-copy-state={copyState}>
          {copyState === 'failed' ? (
            <span className="log-turn__copy-error" role="alert">Copy failed</span>
          ) : null}
          <button type="button" className="log-turn__action" onClick={() => { void copyMessage() }} title="Copy message" aria-label={copyState === 'copied' ? 'Message copied' : 'Copy message'}>
            <Copy size={13} />{copyState === 'copied' ? <span>Copied</span> : null}{copyState === 'failed' ? <span>Retry</span> : null}
          </button>
        </span> : null}
        {isIncoming || speaker?.role === 'agent' ? <ConversationInputDetails messageId={messageId} source={inputSource} speaker={recordedSpeaker}
          declaredAgentSessionId={prefix?.declaredAgentSessionId} describeSpeaker={describeSpeaker} /> : null}
        {prefix && !prefix.declaredContexts && !isDeclaredSender ? <span className="log-turn__declared-source">Message header: {prefix.sourceLabel}</span> : null}
        {prefix?.packet ? <span className="log-turn__packet-declaration" title={`Declared profile: ${prefix.packet.profile} · Declared time: ${prefix.packet.time}; recorded authorship and time are unchanged`}>From {prefix.packet.name}</span> : null}
      </div>
      {isSystemContext && hasContent ? <button type="button" className="log-turn__system-toggle"
        aria-expanded={systemContextOpen} aria-controls={systemContentId}
        onClick={() => setSystemContextOpen(open => !open)}><ChevronRight size={12} aria-hidden="true" />Runtime context</button> : null}
      {hasContent && (!isSystemContext || systemContextOpen) ? (
        <div ref={bodyRef} id={isSystemContext ? systemContentId : undefined} className="log-turn__body"
          onMouseUp={canAnnotate ? captureSelection : undefined} onKeyUp={canAnnotate ? captureSelection : undefined}>
          {parts.map((part, index) => {
            const key = partKey(part)
            return part.kind === 'text' ? <div key={key} className="log-turn__text" tabIndex={-1}>
              {index === 0 ? prefix?.declaredContexts?.map((context, contextIndex) => <details key={contextIndex} className="log-turn__declared-context">
                <summary><ChevronRight size={12} aria-hidden="true" />Declared context{prefix.declaredContexts!.length > 1 ? ` ${contextIndex + 1}` : ''}</summary>
                <pre>{context.raw}</pre>
              </details>) : null}
              {index === 0 && prefix?.declaredContexts && prefix.body.length === 0 ? null : index === 0 && prefix?.packet ? prefix.packet.parts.map((packetPart, packetIndex) => packetPart.kind === 'text'
              ? <MemoizedAgentMarkdown key={packetIndex} className="log-turn__packet-text" content={packetPart.text} workspaceRoot={workspaceRoot} homeDir={homeDir}
                {...(openWorkspaceFile ? { openWorkspaceFile } : {})} {...(readPastedImage ? { readPastedImage } : {})} {...(openHttpLink ? { openHttpLink } : {})} />
              : <blockquote key={packetIndex} className="log-turn__citation"><span className="log-turn__citation-from">{packetPart.from}</span>
                {packetPart.reference ? <code className="log-turn__citation-ref">{packetPart.reference}</code> : null}
                <MemoizedAgentMarkdown className="log-turn__packet-text" content={packetPart.text} workspaceRoot={workspaceRoot} homeDir={homeDir}
                  {...(openWorkspaceFile ? { openWorkspaceFile } : {})} {...(readPastedImage ? { readPastedImage } : {})} {...(openHttpLink ? { openHttpLink } : {})} /></blockquote>) : <MemoizedAgentMarkdown
              content={index === 0 && prefix
                ? prefix.declaredContexts ? prefix.body.replace(/^(?:\r?\n){1,2}/u, '') : prefix.body
                : part.text}
              workspaceRoot={workspaceRoot}
              homeDir={homeDir}
              {...(openWorkspaceFile ? { openWorkspaceFile } : {})}
              {...(readPastedImage ? { readPastedImage } : {})}
              {...(openHttpLink ? { openHttpLink } : {})}
            />}</div> : part.kind === 'tool-call' || part.kind === 'tool-result' ? (
              <ConversationToolTrace key={key} part={part} workspaceRoot={workspaceRoot}
                traceId={traceDisclosureKey(messageId, key)}
                {...(expandedTraces ? { expanded: expandedTraces.has(traceDisclosureKey(messageId, key)) } : {})}
                {...(onToggleTrace ? { onToggle: (open) => onToggleTrace(traceDisclosureKey(messageId, key), open) } : {})} />
            ) : part.kind === 'reasoning' ? (
              <ConversationReasoningTrace
                key={key}
                part={part}
                workspaceRoot={workspaceRoot}
                homeDir={homeDir}
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
