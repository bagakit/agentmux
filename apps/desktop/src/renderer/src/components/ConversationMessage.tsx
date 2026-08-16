import type { AgentProviderId, AgentTimelineItemStatus } from '@agentmux/core'
import { formatClock, formatOffset } from '../lib/activity-ruler'
import type { ConversationSpeaker } from '../lib/conversation-speaker'
import { AgentMarkdown, type LinkClickModifiers, type OpenWorkspaceFile } from './AgentMarkdown'
import type { ReadPastedImage } from './ConversationImage'
import { ConversationSpeakerAvatar } from './ConversationSpeakerAvatar'
import { SemanticIcon } from './semantic-icons'

export type ConversationMessageProps = {
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
}

/** A readable message, shared by the live Activity feed and Gallery. The host owns identity
 * resolution, timeline ordering, file destinations and continuation; this component owns display. */
export function ConversationMessage({
  speaker, name, providerId, content, status, createdAt, origin, workspaceRoot = '',
  openWorkspaceFile, readPastedImage, openHttpLink, onContinue
}: ConversationMessageProps) {
  const displayName = name ?? (speaker.role === 'human' ? 'You' : 'Assistant')
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
      </div>
      {content ? (
        <AgentMarkdown
          content={content}
          className="log-turn__body"
          workspaceRoot={workspaceRoot}
          {...(openWorkspaceFile ? { openWorkspaceFile } : {})}
          {...(readPastedImage ? { readPastedImage } : {})}
          {...(openHttpLink ? { openHttpLink } : {})}
        />
      ) : null}
      {onContinue ? <button type="button" className="log-turn__continue" onClick={onContinue}>Continue from here</button> : null}
    </div>
  )
}
