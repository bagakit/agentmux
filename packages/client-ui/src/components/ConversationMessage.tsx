import { ConversationProgressiveBody } from './ConversationProgressiveBody.js'
import type { AgentProviderId, AgentSessionHistoryContentPart, AgentSessionHistoryCollaboration, AgentSessionHistoryMessagePhase, AgentSessionHistoryQuestionAnswer, AgentSessionUserMessage, AgentSessionUserMessageSource, AgentTimelineItemStatus } from '@agentmux/core'
import { AMUX_PROTOCOL_DEFINITIONS, parseAgentMuxMessagePrefix } from '@agentmux/core/agent-message-render'
import type { ConversationItemRef, ConversationSourceRecord } from '@agentmux/core/conversation'
import { sessionHistoryTextForReading } from '@agentmux/core/session-user-messages'
import { readSessionHistoryTextResource } from '@agentmux/core/session-history-content'
import { SemanticIcon } from '../theme/icons.js'
import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { formatClock, formatOffset } from '../lib/conversation-time.js'
import { useContentCopyAction, ContentCopyIntentContext } from '../lib/use-content-copy-action.js'
import { useClientUiPlatform, useMarkdownCopyText } from '../platform.js'
import { externalSpeakerLabel, conversationAgentReference, speakerForDisplay, type ConversationSpeaker, type DescribeSpeaker } from '../lib/conversation-speaker.js'
import { describeConversationInputSource } from '../lib/conversation-input-source.js'
import { ConversationInputDetails } from './ConversationInputDetails.js'
import type { LinkClickModifiers, OpenWorkspaceFile } from './AgentMarkdown.js'
import type { ReadPastedImage } from './ConversationImage.js'
import { ConversationResourceImage, type ConversationHistoryResourceReader, type ConversationNativeResourceRecord } from './ConversationResourceImage.js'
import { ConversationResourceText } from './ConversationResourceText.js'
import { ConversationA2AReferences } from './ConversationA2AReferences.js'
import { ConversationNotificationDetails } from './ConversationNotificationDetails.js'
import { ConversationInputText } from './ConversationInputText.js'
import { ConversationResourceFile } from './ConversationResourceFile.js'
import { ConversationToolTrace } from './ConversationToolTrace.js'
import { ConversationReasoningTrace } from './ConversationReasoningTrace.js'
import type { ConversationAnnotationSelection } from '../lib/conversation-annotation.js'
import { conversationMessageSourceKey } from '../lib/conversation-message-location.js'
import { conversationFiles } from '../lib/conversation-files.js'
import { ConversationFiles } from './ConversationFiles.js'
import { ConversationQuestionReply } from './ConversationQuestionReply.js'
import { conversationReplyPreview } from '../lib/conversation-reply-preview.js'
import { ConversationToolPayload } from './ConversationToolPayload.js'
import { ConversationSpeechCard, SubagentReportCard, SystemRecordCard } from './ConversationMessageCard.js'
import { ConversationMessageDisclosure } from './ConversationMessageDisclosure.js'
import { ChannelProfileAvatar } from './ChannelProfileAvatar.js'
import type { ConversationTraceDisclosure } from '../lib/conversation-trace-disclosure.js'

import { ConversationSubmissionMetadata } from './ConversationSubmissionMetadata.js'
import { ConversationSourceLabels } from './ConversationSourceLabels.js'
import type { ConversationSources } from '../lib/conversation-sources.js'

export type ConversationContentBoundary = 'wire' | 'body'

export type ConversationMessageProps = {
  active?: boolean
  showInputSource?: boolean
  /** Original record title: system disclosure heading or compact Provider speech context. */
  recordTitle?: string
  /** A compact record face, without changing ordinary conversation defaults. */
  compact?: boolean
  /** Presentation continuity for an exact same-author progress group; not a record association. */
  continuation?: boolean
  /** An already-open original disclosure owns the full body, including long human input. */
  expandedContent?: boolean
  /** Keep secondary identity/context facts in the existing Info disclosure. */
  /** Compact clients keep full provenance in the existing details disclosure. Unread sources stay visible. */
  sourceLabelsInDetails?: boolean
  detailsOnlyMetadata?: boolean
  /** A Provider-recorded public message phase; never inferred from the text. */
  messagePhase?: AgentSessionHistoryMessagePhase
  /** Native actors remain source-scoped; the parent avatar is presentation only. */
  nativeCollaboration?: Extract<AgentSessionHistoryCollaboration, { kind: 'message' }>
  recordedIdentity?: boolean
  messageDetails?: ReactNode
  /** The owning conversation supplies the same original reader for an exact submission contribution. */
  renderSubmissionOriginal?(record: ConversationSourceRecord): ReactNode
  /** Independent host actions; the shared reader remains the only message body. */
  messageActions?: ReactNode
  located?: boolean
  /** Original text for records with structured parts; never reconstructed by the host. */
  copyText?: string
  /** A client retains its feedback owner and returns the actual clipboard result. */
  onCopy?: (text: string) => Promise<boolean>
  /** The containing original-record reader supplies its complete Copy action and feedback. */
  copyInParent?: boolean
  messageId?: string
  speaker?: ConversationSpeaker
  /** Read-only identity/role from the one Core timeline; never grants control. */
  conversationEvent?: Pick<import('@agentmux/core/conversation').ConversationEvent, 'id' | 'revision' | 'role' | 'author'>
  /** Recorded source labels from the accepted Core inventory and relations. */
  sources?: ConversationSources | undefined
  /** Current conversation identity, supplied by its host; never inferred from a name. */
  conversationSessionId?: string
  /** Location metadata for any original speech, independent of user input semantics. */
  itemRef?: ConversationItemRef
  inputSource?: AgentSessionUserMessageSource
  publicContent?: AgentSessionUserMessage['publicContent']
  /** Original Core observation and producer, independent of the recorded message author. */
  inputContext?: AgentSessionUserMessage['inputContext']
  inputContextSource?: AgentSessionUserMessage['inputContextSource']
  /** Current receiving session Host, independent of this message's sender. */
  executionHostId?: string
  describeSpeaker?: DescribeSpeaker
  name?: string
  providerId?: AgentProviderId
  content: string | readonly AgentSessionHistoryContentPart[]
  /** Original input wire may carry an envelope; an already decoded journal body must not be unwrapped again. */
  contentBoundary?: ConversationContentBoundary
  /** Original Core notice identity, supplied only by the qualified platform record. */
  a2aNotificationId?: string | undefined
  notificationRecords?: readonly ConversationSourceRecord[] | undefined
  locatedSourceKey?: string | null | undefined
  /** Recorded Provider reply semantics; clients never parse message text for these facts. */
  questionAnswers?: readonly AgentSessionHistoryQuestionAnswer[]
  /** Non-blocking notice from the Provider's recorded reading projection. */
  questionDiagnostic?: { code: string; message: string }
  status?: AgentTimelineItemStatus | 'unverified'
  createdAt?: number
  /** Host-selected clock display; the recorded instant remains unchanged. */
  timeFormatter?: (timestamp: number) => string
  origin?: number
  workspaceRoot?: string
  homeDir?: string
  openWorkspaceFile?: OpenWorkspaceFile
  readPastedImage?: ReadPastedImage
  readHistoryResource?: ConversationHistoryResourceReader
  nativeResourceRecord?: ConversationNativeResourceRecord
  openHttpLink?: (url: string, event: LinkClickModifiers) => void
  onContinue?: () => void
  onSelectAnnotation?: (selection: ConversationAnnotationSelection) => void
  expandedTraces?: ReadonlySet<string>
  onToggleTrace?: (traceId: string, open: boolean) => void
  /** One host-owned transient disclosure scope for this exact loaded source. */
  traceDisclosure?: ConversationTraceDisclosure
}

export type ConversationReadingProps = Pick<ConversationMessageProps,
  'workspaceRoot' | 'homeDir' | 'openWorkspaceFile' | 'readPastedImage' | 'openHttpLink' | 'describeSpeaker'>

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

function ConversationCollaborationOriginal({ parts, identity, hasResources }: {
  parts: readonly AgentSessionHistoryContentPart[]
  identity: object
  hasResources: boolean
}) {
  return <details className="log-turn__collaboration-original">
    <summary>{hasResources ? '原始记录与资源引用' : '原始记录'}</summary>
    {hasResources ? <p>此处保留已加载记录与资源引用。使用消息的复制按钮可按需读取并复制完整原文。</p> : null}
    <ConversationToolPayload text={parts.map(partText).join('\n\n')} identity={identity} sourceIdentity={identity} copyLabel={hasResources ? "Copy recorded parts and references" : "Copy original record"} />
  </details>
}

/** A readable message, shared by Activity, native history and Gallery. The host owns identity
 * resolution, timeline ordering, file destinations and continuation; this component owns display. */
export function ConversationMessage({
  active = true, compact = false, continuation = false, expandedContent = false, detailsOnlyMetadata = false, sourceLabelsInDetails = false, recordTitle, messagePhase, recordedIdentity = false, nativeCollaboration, messageDetails, renderSubmissionOriginal, messageActions, located = false, copyText, onCopy, copyInParent = false,
  speaker: recordedSpeaker, conversationEvent, sources, conversationSessionId, itemRef, inputSource, publicContent, inputContext, inputContextSource, showInputSource = true, executionHostId, describeSpeaker, name, providerId, content, contentBoundary = 'wire', a2aNotificationId, notificationRecords, locatedSourceKey, questionAnswers, questionDiagnostic, status, createdAt, timeFormatter, origin, workspaceRoot = '', homeDir = '', messageId = '',
  openWorkspaceFile, readPastedImage, readHistoryResource, nativeResourceRecord, openHttpLink, onContinue, onSelectAnnotation, expandedTraces: controlledTraces, onToggleTrace: controlledToggle, traceDisclosure
}: ConversationMessageProps) {
  const platform = useClientUiPlatform()
  const renderClock = timeFormatter ?? formatClock
  const isStringContent = typeof content === 'string'
  const parts: readonly AgentSessionHistoryContentPart[] = isStringContent
    ? [{ kind: 'text', text: content }]
    : content
  const recordSourceKey = conversationMessageSourceKey(itemRef?.agentSessionId ?? conversationSessionId, itemRef?.source ?? inputSource)
    ?? JSON.stringify([conversationSessionId, nativeResourceRecord?.source.providerId, nativeResourceRecord?.source.nativeSessionId, nativeResourceRecord?.recordId, nativeResourceRecord?.turnId])
  const readingIdentity = useMemo(() => ({}), [messageId, recordSourceKey])
  // Eligibility is an original author fact; display's unknown -> You mapping is insufficient.
  const humanText = recordedSpeaker?.role === 'human' ? parts.filter(part => part.kind === 'text').map(part => part.text).join('\n\n') : ''
  const discloseHuman = !expandedContent && (humanText.length > 1200 || humanText.split('\n').length > 12)
  const discloseBody = (body: ReactNode) => discloseHuman
    ? <ConversationMessageDisclosure key={JSON.stringify([messageId, recordSourceKey, humanText])} preview={humanText.slice(0, 160).trimEnd()} reveal={located}>{body}</ConversationMessageDisclosure>
    : body
  const collaborationPreview = useMemo(() => nativeCollaboration ? conversationReplyPreview(parts.flatMap(part => part.kind === 'text'
    ? [sessionHistoryTextForReading(part)] : []).join('\n\n')).slice(0, 180) : '', [content, Boolean(nativeCollaboration)])
  const collaborationHasResources = nativeCollaboration ? parts.some(part => part.kind === 'resource') : false
  const collaborationOriginal = nativeCollaboration ? <ConversationCollaborationOriginal parts={parts} identity={readingIdentity} hasResources={collaborationHasResources} /> : null
  const hasQuestionAnswers = Boolean(questionAnswers?.length)
  const firstTextIndex = parts.findIndex(part => part.kind === 'text')
  const contextPartIndex = parts.findIndex(part => part.kind === 'text' || part.kind === 'resource' && part.resourceType === 'text')
  const hasContent = hasQuestionAnswers || parts.some(partHasRenderableContent)
  const hasCopyContent = copyText === undefined ? parts.some((part) => partText(part).length > 0) : copyText.length > 0
  const isTraceOnly = !hasQuestionAnswers && parts.length > 0 && parts.every((part) =>
    part.kind === 'text' ? part.text.trim().length === 0 : !(part.kind === 'resource' && part.resourceType === 'text' && part.content?.kind === 'text'))
  const speaker = recordedSpeaker ? recordedIdentity ? recordedSpeaker : speakerForDisplay(recordedSpeaker) : undefined
  const isPeerAgent = speaker?.role === 'agent' && speaker.id.length > 0 &&
    conversationSessionId !== undefined && conversationSessionId.length > 0 && speaker.id !== conversationSessionId
  const inputOrigin = speaker?.role === 'external' && speaker.external
    ? { caption: `External channel · ${speaker.external.actor.application.domain}`, title: `Original external conversation: ${speaker.external.externalConversationId}` }
    : inputSource ? describeConversationInputSource(inputSource) : undefined
  const isSystemContext = speaker?.role === 'system'
  const rawSystemSummary = isSystemContext ? parts.find(part => part.kind === 'text')?.text.slice(0, 240).replace(/\s+/gu, ' ').trim() : undefined
  const isIncoming = speaker?.role === 'human' || speaker?.role === 'external' || isPeerAgent
  const inputMarkdown = isIncoming || recordedIdentity && speaker?.role === 'unknown'
  const files = useMemo(() => (speaker?.role === 'agent' || conversationEvent?.role === 'observation') && !isPeerAgent && !compact && messagePhase !== 'progress' && status === 'complete' && openWorkspaceFile
    ? conversationFiles(parts, workspaceRoot, homeDir) : [],
  [speaker?.role, conversationEvent?.role, isPeerAgent, compact, messagePhase, status, openWorkspaceFile, content, workspaceRoot, homeDir])
  const firstText = parts[0]?.kind === 'text' ? sessionHistoryTextForReading(parts[0]) : undefined
  const prefix = useMemo(() => {
    if (contentBoundary !== 'wire' || hasQuestionAnswers || firstText === undefined) return null
    const parsed = parseAgentMuxMessagePrefix(firstText)
    return a2aNotificationId && parsed?.kind !== 'references' ? null : parsed
  }, [contentBoundary, hasQuestionAnswers, a2aNotificationId, firstText])
  const a2aReferenceScope = a2aNotificationId ? itemRef : undefined
  const primaryNotice = isSystemContext && a2aNotificationId && prefix?.kind === 'references' ? prefix : null
  const systemSummary = prefix?.kind === 'references' ? `${prefix.references.length} A2A Inbox reference${prefix.references.length === 1 ? '' : 's'}`
    : prefix?.protocol ? `${prefix.protocol.id ? AMUX_PROTOCOL_DEFINITIONS[prefix.protocol.id].title : 'Protocol declaration'} · ${prefix.protocol.tag}`
    : prefix?.declaredMessageId !== undefined ? AMUX_PROTOCOL_DEFINITIONS.a2a.title : rawSystemSummary
  const isDeclaredSender = prefix !== null && prefix.sourceLabel.length > 0 && recordedSpeaker?.role === 'unknown'
  const agentReference = conversationAgentReference(recordedSpeaker, prefix)
  const recordedUnknown = recordedIdentity && recordedSpeaker?.role === 'unknown'
  const described = speaker?.role === 'external' ? describeSpeaker?.(speaker)
    : agentReference && !recordedUnknown ? describeSpeaker?.(agentReference.speaker) : undefined
  const referenceName = described?.name && described.name !== agentReference?.speaker.id ? described.name : undefined
  const senderName = referenceName ?? (agentReference?.declared ? prefix?.packet?.name : name && name !== agentReference?.speaker.id ? name : undefined) ?? 'Agent'
  const avatarSpeaker = recordedUnknown ? recordedSpeaker : agentReference?.speaker ?? (isDeclaredSender ? recordedSpeaker : speaker)
  const displayProvider = recordedUnknown ? undefined : agentReference
    ? described?.providerId ?? (!agentReference.declared && agentReference.speaker.id === conversationSessionId ? providerId : undefined)
    : providerId
  const displayName = recordedSpeaker?.role === 'unknown'
    ? recordedIdentity ? conversationEvent?.role === 'observation' ? '作者未记录' : 'Author unknown' : 'You'
    : speaker?.role === 'external' ? described?.name ?? externalSpeakerLabel(speaker)
    : described?.name ?? name ?? (speaker?.role === 'human' ? 'You' : isPeerAgent ? speaker.id : isSystemContext ? 'AgentMux' : speaker ? 'Assistant' : 'Activity')
  const canAnnotate = onSelectAnnotation !== undefined && messageId.length > 0
  const bodyRef = useRef<HTMLDivElement>(null)
  const platformCopy = useMarkdownCopyText()
  const messageWriter = useMemo(() => onCopy ? (text: string) => onCopy(text) : platformCopy, [onCopy, platformCopy])
  const copyIdentity = useMemo(() => ({}), [readingIdentity, content, copyText, readHistoryResource, nativeResourceRecord?.recordId,
    nativeResourceRecord?.source.providerId, nativeResourceRecord?.source.nativeSessionId, nativeResourceRecord?.turnId])
  const messageCopy = useContentCopyAction(copyIdentity, messageWriter, active, 1600)
  const idCopyIdentity = useMemo(() => ({}), [readingIdentity, agentReference?.speaker.id])
  const idCopy = useContentCopyAction(idCopyIdentity, platformCopy, active, 1600)
  const copyState = messageCopy.state, idCopyState = idCopy.state
  const copyReadError = messageCopy.error instanceof Error ? messageCopy.error.message : undefined

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
    await messageCopy.copy(async signal => {
      // Explicit whole-message Copy retains every original part, including deferred bodies.
      const complete: AgentSessionHistoryContentPart[] = []
      for (const [index, part] of parts.entries()) {
        signal.throwIfAborted()
        if (part.kind !== 'resource' || part.resourceType !== 'text') complete.push(part)
        else {
          if (!readHistoryResource || !nativeResourceRecord) throw new Error('Complete recorded content is not available. Retry from the original history.')
          complete.push(await readSessionHistoryTextResource(part, index, nativeResourceRecord, readHistoryResource, signal))
        }
      }
      signal.throwIfAborted()
      return complete.some((part, index) => part !== parts[index])
        ? complete.map(partText).filter(t => t.length > 0).join('\n')
        : copyText ?? complete.map(partText).filter(t => t.length > 0).join('\n')
    })
  }

  const partKeys = useMemo(() => {
    const occurrences = new Map<string, number>()
    return parts.map(part => {
      if (isStringContent) return 'text'
      const callId = part.kind === 'tool-call' || part.kind === 'tool-result' ? part.callId ?? null : null
      const occurrenceKey = JSON.stringify([part.kind, callId])
      const occurrence = occurrences.get(occurrenceKey) ?? 0
      occurrences.set(occurrenceKey, occurrence + 1)
      return JSON.stringify([part.kind, callId, occurrence])
    })
  }, [content])
  const traceIds = useMemo(() => parts.flatMap((part, index) => part.kind === 'reasoning' || part.kind === 'tool-call' || part.kind === 'tool-result'
    ? [traceDisclosureKey(messageId, partKeys[index]!)] : []), [content, messageId, partKeys])
  const traceIdsKey = JSON.stringify(traceIds)
  useLayoutEffect(() => { traceDisclosure?.register(readingIdentity, traceIds) }, [traceDisclosure?.register, readingIdentity, traceIdsKey])
  useLayoutEffect(() => () => traceDisclosure?.register(readingIdentity, null), [traceDisclosure?.register, readingIdentity])
  const expandedTraces = controlledTraces ?? traceDisclosure?.expandedTraces
  const onToggleTrace = controlledToggle ?? traceDisclosure?.onToggleTrace

  const showOrigin = Boolean(inputOrigin && !isSystemContext && !(sources?.submissions?.length && inputSource?.kind === 'native') && (speaker?.role === 'external' || showInputSource || inputSource?.kind === 'captured' && inputSource.device))
  const hasMetadata = Boolean(described?.project || isDeclaredSender || showOrigin || located ||
    prefix && prefix.sourceLabel.length > 0 && !isDeclaredSender || prefix?.packet && (!isDeclaredSender || !agentReference))

  const senderIdentity = agentReference ? <span className="log-turn__sender-id" data-copy-state={idCopyState}>
              <code>{agentReference.speaker.id}</code>
              <button type="button" className="log-turn__id-copy" title={idCopyState === 'copied' ? 'Agent ID copied' : idCopyState === 'failed' ? 'Copy Agent ID failed; retry' : 'Copy Agent ID'}
                aria-label={idCopyState === 'copied' ? 'Agent ID copied' : 'Copy Agent ID'}
                onClick={() => { messageCopy.cancelPreparation(); void idCopy.copy(agentReference.speaker.id) }}>
                {idCopyState === 'copied' ? <SemanticIcon name="action.confirm" size={12} aria-hidden="true" /> : <SemanticIcon name="action.copy" size={12} aria-hidden="true" />}
              </button>
              {idCopyState === 'failed' ? <span className="log-turn__id-copy-error" role="alert">Copy failed · retry</span> : null}
            </span> : null
  const metadata = hasMetadata || sources && !detailsOnlyMetadata ? <div className="log-turn__meta">
        {sources?.submissions ? <ConversationSubmissionMetadata records={sources.submissions} renderClock={renderClock} nativeReadable={hasContent} {...(renderSubmissionOriginal ? { renderOriginal: renderSubmissionOriginal } : {})} /> : null}
        {!detailsOnlyMetadata && (!sourceLabelsInDetails || sources?.main?.unread) ? <ConversationSourceLabels sources={sources?.main} observation={sources?.collectedReply} /> : null}
        {described?.project ? <span className="log-turn__context" title={`${described.project.name}${described.project.branch ? ` · ${described.project.branch}` : ''} · Current project`}>{described.project.name}{described.project.branch ? <span> · {described.project.branch}</span> : null}</span> : null}
        {isDeclaredSender ? <span className="log-turn__sender-kind" title="Source written in the message header; recorded authorship is unchanged">Declared source</span> : null}
        {showOrigin && inputOrigin ? <span className="log-turn__input-source" title={inputOrigin.title}>
          <SemanticIcon name="action.reply" size={11} aria-hidden="true" /><span>{inputOrigin.caption}</span></span> : null}
        {located ? <span className="log-turn__location" role="status">已定位此消息</span> : null}
        {prefix && prefix.sourceLabel.length > 0 && !isDeclaredSender ? <span className="log-turn__declared-source">Message header: {prefix.sourceLabel}</span> : null}
        {prefix?.packet && (!isDeclaredSender || !agentReference) ? <span className="log-turn__packet-declaration" title={`Declared profile: ${prefix.packet.profile} · Declared time: ${prefix.packet.time}; recorded authorship and time are unchanged`}>From {prefix.packet.name}</span> : null}
      </div> : null

  const metadataInDetails = detailsOnlyMetadata || continuation || Boolean(nativeCollaboration && !sources?.submissions?.length && !located)
  const card = {
    avatar: nativeCollaboration ? null : described?.channelProfile?.profile?.avatarUrl ? <ChannelProfileAvatar url={described.channelProfile.profile.avatarUrl}>{platform.renderMessageAvatar({ speaker: avatarSpeaker!, name: displayName })}</ChannelProfileAvatar>
      : avatarSpeaker ? described?.avatar ?? platform.renderMessageAvatar({ speaker: avatarSpeaker, name: recordedUnknown ? displayName : agentReference ? senderName : isDeclaredSender ? prefix.sourceLabel : displayName, project: described?.project, providerId: displayProvider }) : platform.renderIcon('neutral', 12),
    badges: <>
      {isPeerAgent && !detailsOnlyMetadata ? <span className="log-turn__sender-kind">Agent</span> : null}
      {recordTitle && !isSystemContext && !nativeCollaboration ? <span className="log-turn__sender-kind">{recordTitle}</span> : null}
      {hasQuestionAnswers ? <span className="log-turn__sender-kind">问题答复</span> : null}
      {status === 'streaming' ? <span className="log-row__chip" role="status"><SemanticIcon name="status.streaming" size={12} />Streaming</span> : null}
      {status === 'failed' ? <span className="log-row__chip log-row__chip--failed" role="status">{platform.renderIcon('failed', 12)}Failed</span> : null}
      {status === 'unverified' ? <span className="log-row__chip log-row__chip--unverified" role="status">{platform.renderIcon('neutral', 12)}Unverified</span> : null}
    </>,
    time: createdAt === undefined ? null : <span className="log-turn__time" title={origin === undefined
      ? renderClock(createdAt) : `${renderClock(createdAt)} · ${formatOffset(createdAt, origin)} from start`}>
      {renderClock(createdAt)}
    </span>,
    actions: hasCopyContent && !copyInParent || messageActions ? <span className="log-turn__actions" data-copy-state={copyState}>
      {messageActions}
      {hasCopyContent && !copyInParent ? <button type="button" className="log-turn__action" onClick={() => { void copyMessage() }} title="Copy message" aria-label={copyState === 'copied' ? 'Message copied' : 'Copy message'}>
        <SemanticIcon name={copyState === 'copied' ? 'action.confirm' : 'action.copy'} size={13} />
      </button> : null}
    </span> : null,
    feedback: copyState === 'failed' ? <span className="log-turn__copy-error" role="alert">{copyReadError ?? 'Copy failed'} · Retry Copy</span> : null,
    details: isIncoming || speaker?.role === 'agent' || isSystemContext || messageDetails || recordedIdentity || detailsOnlyMetadata || sourceLabelsInDetails && sources || nativeCollaboration
      ? <ConversationInputDetails messageId={messageId} source={inputSource} publicContent={publicContent} executionHostId={executionHostId} speaker={recordedSpeaker}
        declaredAgentSessionId={prefix?.declaredAgentSessionId} sourceDeclaration={isDeclaredSender ? prefix.sourceLabel : undefined} describeSpeaker={describeSpeaker} recordedIdentity={recordedIdentity}>
        {detailsOnlyMetadata ? senderIdentity : null}{metadataInDetails ? metadata : null}{sourceLabelsInDetails && sources ? <ConversationSourceLabels sources={sources.main} observation={sources.collectedReply} /> : null}{messageDetails}{collaborationOriginal}
      </ConversationInputDetails> : null,
    metadata: <>{!metadataInDetails ? metadata : null}
      {sources && detailsOnlyMetadata && !nativeCollaboration && (!sourceLabelsInDetails || sources.main?.unread) ? <div className="log-turn__meta"><ConversationSourceLabels sources={sources.main} observation={sources.collectedReply} /></div> : null}
    </>,
    renderBody
  }

  return (
    <ContentCopyIntentContext.Provider value={messageCopy.cancelPreparation}><div
      className={primaryNotice ? "conversation-a2a-notice" : "log-turn"}
      data-compact={compact || undefined}
      data-native-collaboration={nativeCollaboration ? true : undefined}
      data-conversation-event-id={conversationEvent?.id}
      data-conversation-event-revision={conversationEvent?.revision}
      data-conversation-role={conversationEvent?.role}
      data-conversation-author={conversationEvent ? JSON.stringify(conversationEvent.author) : undefined}
      data-message-phase={messagePhase}
      data-message-continuation={continuation || undefined}
      data-recorded-identity={recordedIdentity || undefined}
      data-message-id={messageId || undefined}
      data-a2a-notification-id={a2aNotificationId}
      data-message-source-key={conversationMessageSourceKey(itemRef?.agentSessionId ?? conversationSessionId, itemRef?.source ?? inputSource)}
      data-conversation-item-ref={itemRef ? JSON.stringify(itemRef) : undefined}
      data-message-located={located || undefined}
      tabIndex={-1}
      data-speaker-role={speaker?.role}
      data-speaker-relation={isPeerAgent ? 'other-agent' : undefined}
      data-message-direction={isIncoming ? 'incoming' : 'outgoing'}
      data-declared-source={prefix?.sourceLabel}
      data-status={status}
      data-trace-only={isTraceOnly ? 'true' : undefined}
      data-message-bubble={messagePhase !== 'progress' && !compact && !isTraceOnly && (speaker?.role === 'agent' || speaker?.role === 'human' || speaker?.role === 'external') ? 'true' : undefined}
    >
      {primaryNotice ? <>
        <div ref={bodyRef} className="conversation-a2a-notice__messages" onMouseUp={canAnnotate ? captureSelection : undefined} onKeyUp={canAnnotate ? captureSelection : undefined}>
        <ConversationA2AReferences references={primaryNotice.references} scope={a2aReferenceScope} active={active}
          {...(describeSpeaker ? { describeSpeaker } : {})} workspaceRoot={workspaceRoot} homeDir={homeDir}
          {...(openWorkspaceFile ? { openWorkspaceFile } : {})} {...(readPastedImage ? { readPastedImage } : {})}
          {...(openHttpLink ? { openHttpLink } : {})} timeFormatter={renderClock} />
        {parts.length > 1 ? renderBody() : null}
        </div>
        {status === 'streaming' || status === 'failed' || status === 'unverified' ? <div className="conversation-a2a-originals__pending" role="status">通知 · {card.badges}</div> : null}
      </> : nativeCollaboration ? <SubagentReportCard {...card} identity={readingIdentity} collaboration={nativeCollaboration} located={located}
        preview={collaborationPreview} hasResources={collaborationHasResources} emptyText={!collaborationPreview && parts.every(part => part.kind === 'text')} />
        : isSystemContext ? <SystemRecordCard {...card} identity={readingIdentity} title={recordTitle || '系统记录'} summary={systemSummary} hasContent={hasContent} />
        : <ConversationSpeechCard {...card} sender={<>
          <span className="log-turn__who">{recordedUnknown ? displayName : agentReference ? senderName : isDeclaredSender ? prefix.packet?.name ?? prefix.sourceLabel : displayName}</span>
          {!detailsOnlyMetadata ? senderIdentity : null}
        </>} />}
      {a2aNotificationId ? <ConversationNotificationDetails key={JSON.stringify([recordSourceKey, a2aNotificationId])} notificationId={a2aNotificationId} protocol={firstText}
        records={notificationRecords} locatedSourceKey={locatedSourceKey}>
        {primaryNotice ? <>{createdAt === undefined ? null : <p>通知记录时间 · {renderClock(createdAt)}</p>}{metadata}{messageDetails}{card.actions}{card.feedback}</> : null}
      </ConversationNotificationDetails> : null}
      {questionDiagnostic ? <p className="agent-interaction__error" role="status" data-question-reply-diagnostic={questionDiagnostic.code}>{questionDiagnostic.message}</p> : null}
      {onContinue ? <button type="button" className="log-turn__continue" onClick={onContinue}>Continue from here</button> : null}
    </div></ContentCopyIntentContext.Provider>
  )
  function renderBody(contentId?: string): ReactNode {
    return hasContent ? discloseBody(
        <div ref={primaryNotice ? undefined : bodyRef} id={contentId} className="log-turn__body"
          onMouseUp={canAnnotate && !primaryNotice ? captureSelection : undefined} onKeyUp={canAnnotate && !primaryNotice ? captureSelection : undefined}>
          {hasQuestionAnswers && firstTextIndex < 0 ? <ConversationQuestionReply visible={active} reveal={located} answers={questionAnswers!}
            inputMode={inputMarkdown} workspaceRoot={workspaceRoot} homeDir={homeDir}
            {...(openWorkspaceFile ? { openWorkspaceFile } : {})} {...(readPastedImage ? { readPastedImage } : {})} {...(openHttpLink ? { openHttpLink } : {})} /> : null}
          {parts.map((part, index) => {
            if (primaryNotice && index === 0) return null
            const key = partKeys[index]!
            return part.kind === 'text' && hasQuestionAnswers && index === firstTextIndex ? <ConversationQuestionReply visible={active} reveal={located} key={key}
              answers={questionAnswers!} originalText={part.text} inputMode={inputMarkdown} workspaceRoot={workspaceRoot} homeDir={homeDir}
              {...(openWorkspaceFile ? { openWorkspaceFile } : {})} {...(readPastedImage ? { readPastedImage } : {})} {...(openHttpLink ? { openHttpLink } : {})} />
            : part.kind === 'text' ? <div key={key} className="log-turn__text" tabIndex={-1}>
              <ConversationInputText visible={active} reveal={located} text={sessionHistoryTextForReading(part)} prefix={index === 0 ? prefix : null}
                embedIdentity={messageId && (conversationSessionId || itemRef || nativeResourceRecord) ? JSON.stringify([executionHostId, conversationSessionId, recordSourceKey, messageId, index]) : undefined}
                a2aReferenceScope={a2aReferenceScope} describeSpeaker={describeSpeaker}
                inputContext={index === contextPartIndex ? inputContext : undefined} inputContextSource={inputContextSource}
                inputMode={inputMarkdown} workspaceRoot={workspaceRoot} homeDir={homeDir}
                {...(openWorkspaceFile ? { openWorkspaceFile } : {})}
                {...(readPastedImage ? { readPastedImage } : {})}
                {...(openHttpLink ? { openHttpLink } : {})}
              /></div> : part.kind === 'tool-call' || part.kind === 'tool-result' ? (
              <ConversationToolTrace sources={sources?.parts[index]} key={key} part={part} workspaceRoot={workspaceRoot}
                copyIdentity={readingIdentity}
                traceId={traceDisclosureKey(messageId, key)}
                {...(expandedTraces ? { expanded: expandedTraces.has(traceDisclosureKey(messageId, key)) } : {})}
                {...(onToggleTrace ? { onToggle: (open) => onToggleTrace(traceDisclosureKey(messageId, key), open) } : {})} />
            ) : part.kind === 'reasoning' ? (
              <ConversationReasoningTrace
                active={active}
                key={key}
                part={part}
                sources={sources?.parts[index]}
                copyIdentity={readingIdentity}
                workspaceRoot={workspaceRoot}
                homeDir={homeDir}
                traceId={traceDisclosureKey(messageId, key)}
                {...(expandedTraces ? { expanded: expandedTraces.has(traceDisclosureKey(messageId, key)) } : {})}
                {...(onToggleTrace ? { onToggle: (open) => onToggleTrace(traceDisclosureKey(messageId, key), open) } : {})}
                {...(openWorkspaceFile ? { openWorkspaceFile } : {})}
                {...(readPastedImage ? { readPastedImage } : {})}
                {...(openHttpLink ? { openHttpLink } : {})}
              />
            ) : part.resourceType === 'text' && readHistoryResource && nativeResourceRecord ? (
              <ConversationResourceText sources={sources?.parts[index]} active={active} key={key} part={part} partIndex={index} record={nativeResourceRecord} readResource={readHistoryResource} workspaceRoot={workspaceRoot} homeDir={homeDir} inputMode={inputMarkdown} contentBoundary={hasQuestionAnswers ? 'body' : contentBoundary} {...(a2aNotificationId ? { a2aNotificationId } : {})}
                embedIdentity={messageId ? JSON.stringify([executionHostId, conversationSessionId, recordSourceKey, messageId, index]) : undefined}
                a2aReferenceScope={a2aReferenceScope} describeSpeaker={describeSpeaker}
                inputContext={index === contextPartIndex ? inputContext : undefined} inputContextSource={inputContextSource}
                {...(openWorkspaceFile ? { openWorkspaceFile } : {})} {...(readPastedImage ? { readPastedImage } : {})} {...(openHttpLink ? { openHttpLink } : {})} />
            ) : part.resourceType === 'image' && readHistoryResource && nativeResourceRecord ? (
              <ConversationProgressiveBody key={key} heavy reveal={located}><ConversationResourceImage active={active} part={part} partIndex={index} record={nativeResourceRecord} readResource={readHistoryResource} /></ConversationProgressiveBody>
            ) : part.resourceType === 'file' ? (
              <ConversationResourceFile active={active} key={key} part={part} partIndex={index} record={nativeResourceRecord} readResource={readHistoryResource} />
            ) : <div key={key} className="log-turn__resource">
              <span>{part.label ?? `${part.resourceType} resource`}</span>
              <code>{part.reference}</code>
              <small>Resource reference; preview is not available here.</small>
            </div>
          })}
          {files.length > 0 && openWorkspaceFile ? <ConversationFiles files={files} openFile={openWorkspaceFile} /> : null}
        </div>
      ) : null
  }
}
