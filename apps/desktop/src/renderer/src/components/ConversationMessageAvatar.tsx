import type { AgentProviderId } from '@agentmux/core'
import type { ConversationSenderDetails, ConversationSpeaker } from '@agentmux/client-ui/conversation-speaker'
import { useContext } from 'react'
import { ExecutorIdentityContext, ResolvedAgentAvatar } from './AgentAvatar'
import { ConversationSpeakerAvatar } from './ConversationSpeakerAvatar'
import { ProjectIcon } from './ProjectIcon'
import type { MoteConversationIdentity } from '../lib/mote-conversation-identity'
import { useAppStore } from '../store'

/** Original object identity leads; the same read-only Agent face also serves non-message readers. */
export function ConversationMessageAvatar({ speaker, name, providerId, executorId, project, mote, size = 32 }: {
  speaker: ConversationSpeaker
  name: string
  providerId?: AgentProviderId | undefined
  executorId?: string | undefined
  project?: ConversationSenderDetails['project'] | undefined
  mote?: MoteConversationIdentity | undefined
  size?: number
}) {
  const humanAvatar = useAppStore(state => speaker.role === 'human' ? state.config?.profile?.avatar : undefined)
  const { config } = useContext(ExecutorIdentityContext)
  const executor = executorId ? config?.executors[executorId] : undefined
  const provider = providerId ?? executor?.providerId
  const appearance = executor?.avatar ?? (executorId ? config?.appearance.agentAvatars?.[executorId] : undefined)
  function agentFace(edge: number) {
    return executorId && provider ? <ResolvedAgentAvatar label={executor?.label ?? executorId}
      executorId={executorId} providerId={provider} appearance={appearance} size={edge} />
      : <ConversationSpeakerAvatar speaker={speaker} name={name} size={edge} humanAvatar={humanAvatar}
        {...(providerId === undefined ? {} : { providerId })} />
  }
  if (speaker.role !== 'agent') return <ConversationSpeakerAvatar speaker={speaker} name={name}
    size={Math.min(20, size)} humanAvatar={humanAvatar} />
  if (!mote && !project) return agentFace(size)
  return <span className={`conversation-message-avatar${mote ? ' conversation-message-avatar--mote' : ''}`}
    data-mote-author={mote?.topicId} data-project-workspace-id={mote ? undefined : project?.workspaceId}
    title={mote ? mote.name : `${name} · ${project!.name} · Current project`} style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size / 2)) }}>
    {mote ? <ConversationSpeakerAvatar speaker={speaker} name={name} mote={mote} size={size} />
      : <ProjectIcon workspaceId={project!.workspaceId} name={project!.name} />}
    <span className="conversation-message-avatar__badge">{agentFace(Math.max(8, Math.round(size / 2)))}</span>
  </span>
}
