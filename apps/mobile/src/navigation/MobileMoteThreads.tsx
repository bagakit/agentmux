import { useCallback } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { MoteWorkThreads } from '@agentmux/client-ui/components/MoteConversationThreads'
import type { MobileMoteDialogue, MobileMoteWork } from '../conversation/MobileMoteConversation'
import { MobileMoteTeamPanel } from './MobileMoteTeam'
import type { MobileMoteMember, MobileMoteTeam } from './mobile-mote-team'
import type { MobileObjectIdentity } from './MobileIdentity'
import './mote-threads.css'

/** One read-only projection of original work sources and members, never another conversation store. */
export function MobileMoteThreads({ client, dialogue, team, issue, visible, currentSessionId, currentHostId, onOpen, onWork, onMain, onConfigure, onRefresh }: {
  client: AgentMuxHostedClient | null; dialogue: MobileMoteDialogue; team: MobileMoteTeam | null; issue: string | null; visible: boolean
  currentSessionId: string | null; currentHostId?: string | undefined
  onOpen(id: string, identity: MobileObjectIdentity, member: MobileMoteMember): void
  onWork(source: MobileMoteWork): void; onMain(): void; onConfigure(): void; onRefresh(): void
}) {
  const readWork = useCallback(async (source: MobileMoteWork) => {
    if (!client?.forwardRpc) throw new Error('原工作读取端口暂不可用；原引用保留。')
    const value = await client.forwardRpc('message.dispatch.read', { hostId: source.origin.hostId, sourceMessageId: source.origin.messageId })
    if (value.hostId !== source.origin.hostId) throw new Error('原工作返回了另一执行端的记录；已有引用与对话保留。')
    return value
  }, [client])
  const current = dialogue.page?.main.status === 'ready' && !dialogue.unavailable ? dialogue.page.main.current : null
  const members = team ? { ...team, members: team.members.filter(member => !current || member.hostId !== current.hostId || member.sessionId !== current.sessionId) } : null
  return <section className="mobile-mote-threads" aria-label="Mote Threads">
    <MoteWorkThreads page={dialogue.page} issue={dialogue.issue} loading={dialogue.loading} visible={visible} readWork={readWork}
      memberName={source => team?.members.find(member => member.hostId === source.origin.hostId && member.sessionId === source.origin.recipientSessionId)?.name ?? source.origin.recipientSessionId}
      onRefresh={onRefresh} onOlder={() => { void dialogue.older() }} onOpenWork={onWork} />
    <MobileMoteTeamPanel team={members} issue={issue} currentSessionId={currentSessionId} currentHostId={currentHostId} membersOnly
      onRefresh={onRefresh} onOpen={onOpen} onMain={onMain} onWork={(id, identity, member) => onOpen(id, identity, member)} onConfigure={onConfigure} />
  </section>
}
