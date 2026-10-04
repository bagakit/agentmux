import type { AgentProviderId } from '@agentmux/core'
import type { ConversationSenderDetails, ConversationSpeaker } from '@agentmux/client-ui/conversation-speaker'
import { ConversationSpeakerAvatar } from './ConversationSpeakerAvatar'
import { ProjectIcon } from './ProjectIcon'
import type { MoteConversationIdentity } from '../lib/mote-conversation-identity'

/** The message avatar composes existing project and Agent identities; the axis stays a small marker. */
export function ConversationMessageAvatar({ speaker, name, providerId, project, mote, size = 32 }: {
  speaker: ConversationSpeaker
  name: string
  providerId?: AgentProviderId | undefined
  project?: ConversationSenderDetails['project'] | undefined
  mote?: MoteConversationIdentity | undefined
  size?: number
}) {
  if (speaker.role === 'agent' && mote) return <span className="conversation-message-avatar conversation-message-avatar--mote" data-mote-author={mote.topicId} title={mote.name} style={{ width: size, height: size }}>
    <ConversationSpeakerAvatar speaker={speaker} name={name} mote={mote} size={size} />
  </span>
  if (speaker.role !== 'agent' || !project) return <ConversationSpeakerAvatar
    speaker={speaker} name={name} size={speaker.role === 'agent' ? size : Math.min(20, size)}
    {...(providerId === undefined ? {} : { providerId })} />
  return <span className="conversation-message-avatar" data-project-workspace-id={project.workspaceId}
    title={`${name} · ${project.name} · Current project`} style={{ width: size, height: size }}>
    <ProjectIcon workspaceId={project.workspaceId} name={project.name} />
    <span className="conversation-message-avatar__badge"><ConversationSpeakerAvatar
      speaker={speaker} name={name} size={Math.max(8, Math.round(size / 2))} {...(providerId === undefined ? {} : { providerId })} /></span>
  </span>
}
