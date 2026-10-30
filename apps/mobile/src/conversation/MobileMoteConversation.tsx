import { useCallback, type ReactNode } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { MoteDefaultConversation, MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import type { MoteDialogueLink } from '@agentmux/core/mote-dialogue'
import { MoteConversationThreads } from '@agentmux/client-ui/components/MoteConversationThreads'
import type { useMoteDialogue } from '@agentmux/client-ui/use-mote-dialogue'
import type { ConversationRecord } from '@agentmux/client-ui/conversation-records'
import type { ConversationRecordInsertion } from '@agentmux/client-ui/components/ConversationRecordSequence'
import type { ConversationReadingGeometry } from '@agentmux/client-ui/conversation-body-work'
import type { DescribeSpeaker } from '@agentmux/client-ui/conversation-speaker'

export type MobileMoteWork = Extract<MoteDialogueLink, { kind: 'work' }>
export type MobileMoteDialogue = ReturnType<typeof useMoteDialogue>
/** A read-only adapter over the accepted original page. Core owns links and role admission. */
export function MobileMoteConversation({ client, target, dialogue, agentSessionId, hostId, name, visible, records, memberName, mainAvatar,
  onOpenWork, onReturnMain, renderCurrent, readingGeometry, describeSpeaker }: {
  client: AgentMuxHostedClient | null; target: MotePreferencesTarget | undefined; agentSessionId: string; hostId: string | undefined
  dialogue: MobileMoteDialogue | undefined
  mainAvatar?: ((size?: number) => ReactNode) | undefined
  name: string; visible: boolean; records: readonly ConversationRecord[]; memberName?(source: MobileMoteWork): string
  onOpenWork?(source: MobileMoteWork): void; onReturnMain?(reference: MoteDefaultConversation): void
  renderCurrent(insertions: readonly ConversationRecordInsertion[]): ReactNode; readingGeometry: ConversationReadingGeometry; describeSpeaker: DescribeSpeaker
}) {
  const readWork = useCallback(async (source: MobileMoteWork) => {
    if (!client?.forwardRpc) throw new Error('原工作读取端口暂不可用；原引用保留。')
    const value = await client.forwardRpc('message.dispatch.read', { hostId: source.origin.hostId, sourceMessageId: source.origin.messageId })
    if (value.hostId !== source.origin.hostId) throw new Error('原工作返回了另一执行端的记录；已有引用与对话保留。')
    return value
  }, [client])
  if (!target || !hostId || !dialogue) return renderCurrent([])
  return <MoteConversationThreads page={dialogue.page} issue={dialogue.issue} loading={dialogue.loading} mainUnavailable={dialogue.unavailable}
    actor={{ hostId, agentSessionId }} name={name} visible={visible} records={records} conversationClient={client} readWork={readWork}
    {...(memberName ? { memberName } : {})} onRefresh={dialogue.refresh} onOlder={() => { void dialogue.older() }}
    onOpenWork={source => onOpenWork?.(source)} onReturnMain={() => { const main = dialogue.page?.main.current; if (main) onReturnMain?.(main) }}
    renderCurrent={renderCurrent} readingGeometry={readingGeometry} describeSpeaker={describeSpeaker} mainAvatar={mainAvatar} />
}
