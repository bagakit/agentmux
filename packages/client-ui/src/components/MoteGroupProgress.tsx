import type { MoteGroupMember, MoteGroupMessage } from '@agentmux/core/mote/group'
import { MoteGroupMemberAvatar, type RenderMoteGroupAvatar } from './MoteGroupSettings.js'

const milestones = {
  pending: ['等待接收', '正在送往群内会话'],
  accepted: ['已接收', '等待成员回报'],
  failed: ['投递失败', '可重试这次投递'],
  unknown: ['投递待核对', '可查看原投递回执'],
  reported: ['已回报', ''],
} as const

export function MoteGroupProgress({ deliveries, members, replies, contextual, renderAvatar, retrying, onRetry, onOpenReply }: {
  deliveries: MoteGroupMessage['deliveries']; members: ReadonlyMap<string, MoteGroupMember>;
  contextual: boolean; replies?: ReadonlyMap<string, MoteGroupMessage> | undefined; renderAvatar?: RenderMoteGroupAvatar | undefined;
  retrying: boolean; onRetry(memberId: string): void; onOpenReply(messageId: string): void
}) {
  return <ul className="mote-group__receipts" aria-label="投递进展">{deliveries.map(delivery => {
    const member = members.get(delivery.moteId)
    const name = member?.name ?? delivery.moteId
    const reply = replies?.get(delivery.moteId)
    const phase = reply ? 'reported' : delivery.status
    const [title, fallback] = milestones[phase]
    return <li key={delivery.moteId} data-status={phase} title={delivery.issue}>
      <MoteGroupMemberAvatar member={member ?? { moteId: delivery.moteId, name }} render={renderAvatar} size="small" />
      <div className="mote-group__progress-copy">
        <span><strong>{name}</strong><span className="mote-group__milestone" key={phase}><i aria-hidden="true" />{title}</span></span>
        {reply ? <button className="mote-group__progress-preview" type="button" onClick={() => onOpenReply(reply.id)}>{reply.body}</button>
          : <small>{contextual && phase === 'accepted' ? '可以按需回应' : fallback}</small>}
      </div>
      {phase === 'failed' || phase === 'unknown' ? <button type="button" disabled={retrying} onClick={() => onRetry(delivery.moteId)}>
        {phase === 'failed' ? '重试' : '核对'}
      </button> : null}
    </li>
  })}</ul>
}
