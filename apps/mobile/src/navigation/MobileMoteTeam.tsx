import { SemanticIcon } from '@agentmux/client-ui/icons'
import { AgentAvatarFace } from '@agentmux/client-ui/components/AgentAvatarFace'
import { FocusStateMark } from '@agentmux/client-ui/components/FocusStateMark'
import { MobileNotice } from '../notices/MobileNotice'
import { mobileMoteMemberIdentity, type MobileMoteMember, type MobileMoteTeam } from './mobile-mote-team'
import type { MobileObjectIdentity } from './MobileIdentity'
import './mote-team.css'

export function mobileMoteRecipient(team: MobileMoteTeam | null, sessionId: string | null, hostId: string | undefined): string {
  const member = team?.members.find(value => value.sessionId === sessionId && value.hostId === hostId)
  if (!member || !team?.main?.confirmed) return '原对话'
  return team.main.reference.sessionId === sessionId && team.main.reference.hostId === hostId ? '主 Agent' : '成员'
}

export function MobileMoteTeamSummary({ team, recipient, role, issue, onOpen, onMain, showMain }: {
  team: MobileMoteTeam | null; recipient: string; role: string; issue: string | null
  onOpen(): void; onMain(): void; showMain: boolean
}) {
  const requests = team?.members.filter(member => member.request).length ?? 0
  const known = team?.members.filter(member => member.hostId).length ?? 0, unknown = (team?.members.length ?? 0) - known
  return <div className="mobile-mote-team-summary" aria-label="当前收件人与团队">
    <span className="mobile-mote-recipient" title={`${role} · ${recipient}`}><small>{role}</small><strong>{recipient}</strong></span>
    <button type="button" className="mobile-mote-team-trigger" aria-label="查看本 Mote 团队" onClick={onOpen}>
      <SemanticIcon name="object.collaboration" size={14} /><span>团队{team ? ` ${known}${unknown ? ` · ${unknown} 待确认` : ''}` : ''}</span>
      {requests > 0 && <span className="mobile-mote-needs">{requests} 需要你</span>}
      {issue && <SemanticIcon name="status.warning" size={12} />}
    </button>
    {showMain && <button type="button" className="mobile-mote-main-return" onClick={onMain}>回主对话</button>}
  </div>
}

export function MobileMoteTeamPanel({ team, issue, currentSessionId, currentHostId, onRefresh, onOpen, onMain, onWork, onConfigure }: {
  team: MobileMoteTeam | null; issue: string | null; currentSessionId: string | null
  currentHostId?: string | undefined
  onRefresh(): void; onOpen(id: string, identity: MobileObjectIdentity, member: MobileMoteMember): void
  onMain(): void; onWork(id: string, identity: MobileObjectIdentity, member: MobileMoteMember): void; onConfigure(): void
}) {
  const needsYou = team?.members.filter(member => member.request) ?? []
  const known = team?.members.filter(member => member.hostId).length ?? 0, unknown = (team?.members.length ?? 0) - known
  const renderMember = (member: MobileMoteMember, requestOnly = false) => {
    const main = team?.main?.confirmed && team.main.reference.sessionId === member.sessionId && team.main.reference.hostId === member.hostId
    const open = (work = false, place = member.places.length === 1 ? member.places[0] : undefined) => {
      if (!team) return
      const identity = mobileMoteMemberIdentity(team, member, place)
      if (work) onWork(member.sessionId, identity, member); else onOpen(member.sessionId, identity, member)
    }
    const ambiguous = (team?.members.filter(value => value.sessionId === member.sessionId).length ?? 0) > 1
    return <li key={member.key} className="mobile-mote-member" data-mote-member={member.sessionId} data-mote-host={member.hostId ?? ''} data-mote-member-key={member.key}>
      <button type="button" className="mobile-mote-member-open" onClick={() => open()} aria-label={`打开原成员 · ${member.name}`}>
        <AgentAvatarFace providerId={member.presentation?.providerId ?? member.session?.providerId} appearance={member.presentation?.avatar} />
        <span className="mobile-mote-member-copy"><span><strong>{member.name}</strong>{main && <small className="mobile-mote-role">主 Agent</small>}{member.sessionId === currentSessionId && member.hostId === currentHostId && <small className="mobile-mote-role">当前</small>}</span>
          {(ambiguous || !member.hostId) && <span className="mobile-mote-member-state">{member.hostId ?? '执行端未确认'}</span>}
          {requestOnly && member.request ? <span className="mobile-mote-request"><SemanticIcon name="status.warning" size={12} />{member.request.kind === 'permission' ? '权限请求' : '等待答复'} · {member.request.kind === 'permission' ? member.request.title : member.request.questions[0]?.prompt ?? '原问题'}</span>
            : <span className="mobile-mote-member-state">{member.presentation?.stateMark && <FocusStateMark kind={member.presentation.stateMark} presenceUnknown={member.presentation.presenceUnknown} />}{member.presentation?.stateLabel ?? member.presentation?.detail ?? '状态未确认'}</span>}
          {!requestOnly && member.presentation?.recap && <span className="mobile-mote-member-recap" title={member.presentation.recap.source}>{member.presentation.recap.text}</span>}
        </span><SemanticIcon name="navigation.disclosure" size={14} />
      </button>
      {!requestOnly && <div className="mobile-mote-member-actions"><button type="button" onClick={() => open(true)}>工作与结果</button>
        {member.places.length > 1 && <details><summary>{member.places.length} 个原位置</summary>{member.places.map(place => <button type="button" key={JSON.stringify(place)} onClick={() => open(false, place)}>打开原位置 · {place.groupId} / {place.tabId} / {place.regionId}</button>)}</details>}
      </div>}
      {member.issue && <p role="status" className="mobile-mote-team-issue">{member.issue}</p>}
      {(ambiguous || member.issue) && !requestOnly && <details className="mobile-mote-member-references"><summary>原位置与恢复</summary>
        <code>{member.hostId ?? 'Host 未确认'} · {member.sessionId}</code>
        {member.regions.map(region => <code key={JSON.stringify(region)}>{region.tabId} / {region.regionId}</code>)}
        <button type="button" onClick={onRefresh}>刷新原团队</button>
      </details>}
    </li>
  }
  return <section className="mobile-mote-team-panel" aria-label="本 Mote 团队">
    <div className="mobile-mote-team-actions"><span>{team ? `${known} 位 Agent${unknown ? ` · ${unknown} 处待确认` : ''}` : '原团队待确认'}</span><button type="button" aria-label="刷新本 Mote 团队" onClick={onRefresh}><SemanticIcon name="action.refresh" size={14} />刷新</button></div>
    {issue && <MobileNotice identity={[team?.spaceId,issue]} role="status">{issue} 已有呈现保留，可继续原对话。</MobileNotice>}
    {team?.facts?.issue && <MobileNotice identity={[team.spaceId,team.facts.issue]} role="status">{team.facts.issue}</MobileNotice>}
    {team?.main ? <button type="button" className="mobile-mote-main-action" aria-label="回到主对话" onClick={onMain}><SemanticIcon name="object.conversation" size={17} /><span><strong>回到主对话</strong><small>{team.main.confirmed ? team.members.find(member => member.sessionId === team.main!.reference.sessionId && member.hostId === team.main!.reference.hostId)?.name ?? '原主 Agent' : '原保存引用 · 位置待确认'}</small></span><SemanticIcon name="navigation.disclosure" size={14} /></button>
      : <button type="button" className="mobile-mote-main-action" aria-label="核对主 Agent" onClick={onConfigure}><SemanticIcon name="object.conversation" size={17} /><span><strong>核对主 Agent</strong><small>原成员与会话保留</small></span></button>}
    {needsYou.length > 0 && <section className="mobile-mote-team-section"><h3>需要你 <span>{needsYou.length}</span></h3><ul>{needsYou.map(member => renderMember(member, true))}</ul></section>}
    <section className="mobile-mote-team-section"><h3>团队在做什么</h3><ul>{team?.members.map(member => renderMember(member))}</ul>
      {team && !team.members.length && <p className="mobile-mote-team-empty">尚未确认成员绑定。原对话仍可继续。</p>}
      {!team && <p className="mobile-mote-team-empty">正在核对原团队。原对话与草稿保留。</p>}
    </section>
  </section>
}
