import { useCallback, type ReactNode } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import type { MoteDialogueLink } from '@agentmux/core/mote-dialogue'
import { MoteConversationThreads } from '@agentmux/client-ui/components/MoteConversationThreads'
import type { useMoteDialogue } from '@agentmux/client-ui/use-mote-dialogue'
import type { ConversationRecordInsertion } from '@agentmux/client-ui/components/ConversationRecordSequence'
import type { ConversationReadingGeometry } from '@agentmux/client-ui/conversation-body-work'
import type { DescribeSpeaker } from '@agentmux/client-ui/conversation-speaker'

export type MobileMoteWork = Extract<MoteDialogueLink, { kind: 'work' }>
export type MobileMoteDialogue = ReturnType<typeof useMoteDialogue>
/** Main reading and the compact related-work disclosure use the same original page. */
export function MobileMoteConversation({ client, target, dialogue, agentSessionId, hostId, name, visible, mainAvatar, memberName, onOpenWork, onShowThreads,
  renderCurrent, readingGeometry, describeSpeaker }: {
  client: AgentMuxHostedClient | null; target: MotePreferencesTarget | undefined; agentSessionId: string; hostId: string | undefined
  dialogue: MobileMoteDialogue | undefined; mainAvatar?: ((size?: number) => ReactNode) | undefined
  name: string; visible: boolean
  memberName?: ((source: MobileMoteWork) => string) | undefined
  onOpenWork?: ((source: MobileMoteWork) => void) | undefined
  onShowThreads?: (() => void) | undefined
  renderCurrent(insertions: readonly ConversationRecordInsertion[]): ReactNode; readingGeometry: ConversationReadingGeometry; describeSpeaker: DescribeSpeaker
}) {
  const readWork = useCallback(async (source: MobileMoteWork) => {
    if (!client?.forwardRpc) throw new Error('工作资料暂不可读，原对话和工作引用仍保留。')
    const value = await client.forwardRpc('message.dispatch.read', { hostId: source.origin.hostId, sourceMessageId: source.origin.messageId })
    if (value.hostId !== source.origin.hostId) throw new Error('工作来源未能核对，原引用仍保留。')
    return value
  }, [client])
  if (!target || !hostId || !dialogue) return renderCurrent([])
  return <MoteConversationThreads page={dialogue.page} issue={dialogue.issue}
    actor={{ hostId, agentSessionId }} name={name} visible={visible} conversationClient={client}
    work={{ readWork, ...(memberName ? { memberName } : {}), ...(onOpenWork ? { onOpenWork } : {}), ...(onShowThreads ? { onShowThreads } : {}) }}
    onOlder={() => { void dialogue.older() }} renderCurrent={renderCurrent} readingGeometry={readingGeometry} describeSpeaker={describeSpeaker} mainAvatar={mainAvatar} />
}
