import type { AgentProviderId } from '@agentmux/core'
import type { ConversationSenderDetails, ConversationSpeaker } from '../lib/conversation-speaker'
import { ConversationSpeakerAvatar } from './ConversationSpeakerAvatar'
import { ProjectIcon } from './ProjectIcon'

/** The message avatar composes existing project and Agent identities; the axis stays a small marker. */
export function ConversationMessageAvatar({ speaker, name, providerId, project }: {
  speaker: ConversationSpeaker
  name: string
  providerId?: AgentProviderId | undefined
  project?: ConversationSenderDetails['project'] | undefined
}) {
  if (speaker.role !== 'agent' || !project) return <ConversationSpeakerAvatar
    speaker={speaker} name={name} size={speaker.role === 'agent' ? 32 : 20}
    {...(providerId === undefined ? {} : { providerId })} />
  return <span className="conversation-message-avatar" data-project-workspace-id={project.workspaceId}
    title={`${name} · ${project.name} · Current project`}>
    <ProjectIcon workspaceId={project.workspaceId} name={project.name} />
    <span className="conversation-message-avatar__badge"><ConversationSpeakerAvatar
      speaker={speaker} name={name} size={16} {...(providerId === undefined ? {} : { providerId })} /></span>
  </span>
}
