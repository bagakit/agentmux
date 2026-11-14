import { Tabs } from '@agentmux/client-ui/components/Tabs'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { AgentAvatarFace } from '@agentmux/client-ui/components/AgentAvatarFace'
import { FocusStateMark } from '@agentmux/client-ui/components/FocusStateMark'
import { MobileNotice } from '../notices/MobileNotice'
import { mobileMoteMemberIdentity, type MobileMoteMember, type MobileMoteTeam } from './mobile-mote-team'
import type { MobileObjectIdentity } from './MobileIdentity'
import { ordinaryUnknownAgentStatus, mobileAgentStateLabel } from './mobile-agent-status'
import { MobileAgentStatusDetails } from './MobileAgentStatusDetails'
import './mote-team.css'

export function mobileMoteRecipient(team: MobileMoteTeam | null, sessionId: string | null, hostId: string | undefined): string {
  const member = team?.members.find(value => value.sessionId === sessionId && value.hostId === hostId)
  if (!member || !team?.main?.confirmed) return '对话'
  return team.main.reference.sessionId === sessionId && team.main.reference.hostId === hostId ? '主 Agent' : '成员'
}

/** The strip under a Mote conversation header. The header already names the conversation; this row never repeats it. */
export function MobileMoteContext({ tabsId, variant, team, issue, role, section, noticeRef, showMain, onDiscussion, onThreads, onTeam, onMain }: {
  tabsId: string; variant: 'main' | 'member'; team: MobileMoteTeam | null; issue: string | null; role: string
  section: 'discussion' | 'threads'; noticeRef(node: HTMLSpanElement | null): void; showMain: boolean
  onDiscussion(): void; onThreads(): void; onTeam(): void; onMain(): void
}) {
  const waiting = team?.members.filter(member => member.request).length ?? 0
  const known = team?.members.filter(member => member.hostId).length ?? 0, unknown = (team?.members.length ?? 0) - known
  const facts = [waiting ? `${waiting} 个需要你` : '', unknown ? `${unknown} 位执行端待确认` : '', issue ?? ''].filter(Boolean).join('；')
  return <div className="mobile-mote-context" data-variant={variant}>
    {variant === 'main' ? <Tabs className="mobile-mote-sections" aria-label="Mote 导航" value={section}
      onValueChange={next => next === 'discussion' ? onDiscussion() : onThreads()} options={[
        { value: 'discussion', panelId: `${tabsId}-discussion`, button: { id: `${tabsId}-discussion-tab` }, label: 'Discussion' },
        { value: 'threads', panelId: `${tabsId}-threads`, button: { id: `${tabsId}-threads-tab` }, label: 'Threads' },
      ]} /> : <span className="mobile-mote-context__role">{role}</span>}
    <span ref={noticeRef} className="mobile-mote-context__notice" />
    <button type="button" className="mobile-mote-team-button" aria-label="查看本 Mote 团队" {...(facts ? { 'aria-description': facts } : {})} onClick={onTeam}>
      <SemanticIcon name="object.collaboration" size={16} /><span className="mobile-mote-team-button__label">团队{team ? ` ${known}` : ''}</span>
      {issue || unknown ? <SemanticIcon className="mobile-mote-team-button__issue" name="status.warning" size={12} /> : null}
      {waiting ? <span className="mobile-tab-badge" aria-hidden="true" data-count={waiting}>{waiting > 99 ? '99+' : waiting}</span> : null}
    </button>
    {variant === 'member' && showMain ? <button type="button" className="mobile-mote-main-return" onClick={onMain}>回主对话</button> : null}
  </div>
}

export function MobileMoteTeamPanel({ team, issue, currentSessionId, currentHostId, onRefresh, onOpen, onMain, onWork, onConfigure, membersOnly = false }: {
  team: MobileMoteTeam | null; issue: string | null; currentSessionId: string | null; membersOnly?: boolean
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
      <button type="button" className="mobile-mote-member-open" onClick={() => open()} aria-label={`打开成员 · ${member.name}`}>
        <AgentAvatarFace providerId={member.presentation?.providerId ?? member.session?.providerId} appearance={member.presentation?.avatar} />
        <span className="mobile-mote-member-copy"><span><strong>{member.name}</strong>{main && <small className="mobile-mote-role">主 Agent</small>}{member.sessionId === currentSessionId && member.hostId === currentHostId && <small className="mobile-mote-role">当前</small>}</span>
          {(ambiguous || !member.hostId) && <span className="mobile-mote-member-state">{member.hostId ?? '执行端未确认'}</span>}
          {requestOnly && member.request ? <span className="mobile-mote-request"><SemanticIcon name="status.warning" size={12} />{member.request.kind === 'permission' ? '权限请求' : '等待答复'} · {member.request.kind === 'permission' ? member.request.title : member.request.questions[0]?.prompt ?? '问题'}</span>
            : !ordinaryUnknownAgentStatus(member.presentation, Boolean(member.request)) && <span className="mobile-mote-member-state">{member.presentation?.stateMark && <FocusStateMark kind={member.presentation.stateMark} presenceUnknown={member.presentation.presenceUnknown} />}{mobileAgentStateLabel(member.presentation)}</span>}
          {!requestOnly && member.presentation?.recap && <span className="mobile-mote-member-recap" title={member.presentation.recap.source}>{member.presentation.recap.text}</span>}
        </span><SemanticIcon name="navigation.disclosure" size={14} />
      </button>
      {!requestOnly && <div className="mobile-mote-member-actions"><button type="button" onClick={() => open(true)}>工作与结果</button>
        <MobileAgentStatusDetails presentation={member.presentation} onRefresh={onRefresh} />
        {member.places.length > 1 && <details><summary>{member.places.length} 个原位置</summary>{member.places.map(place => <button type="button" key={JSON.stringify(place)} onClick={() => open(false, place)}>打开原位置 · {place.groupId} / {place.tabId} / {place.regionId}</button>)}</details>}
      </div>}
      {member.issue && <p role="status" className="mobile-mote-team-issue">{member.issue}</p>}
      {(ambiguous || member.issue) && !requestOnly && <details className="mobile-mote-member-references"><summary>位置与恢复</summary>
        <code>{member.hostId ?? 'Mac 未确认'} · {member.sessionId}</code>
        {member.regions.map(region => <code key={JSON.stringify(region)}>{region.tabId} / {region.regionId}</code>)}
        <button type="button" onClick={onRefresh}>刷新团队</button>
      </details>}
    </li>
  }
  return <section className="mobile-mote-team-panel" aria-label="本 Mote 团队">
    <div className="mobile-mote-team-actions"><span>{team ? `${known} 位 Agent${unknown ? ` · ${unknown} 处待确认` : ''}` : '团队待确认'}</span><button type="button" aria-label="刷新本 Mote 团队" onClick={onRefresh}><SemanticIcon name="action.refresh" size={14} />刷新</button></div>
    {issue && <MobileNotice identity={[team?.spaceId,issue]} role="status">{issue} 已有工作面保留，可继续对话。</MobileNotice>}
    {team?.facts?.issue && <MobileNotice identity={[team.spaceId,team.facts.issue]} role="status">{team.facts.issue}</MobileNotice>}
    {!membersOnly && (team?.main ? <button type="button" className="mobile-mote-main-action" aria-label={team.main.confirmed ? '回到主对话' : '打开上次主对话'} onClick={onMain}><SemanticIcon name="object.conversation" size={17} /><span><strong>{team.main.confirmed ? '回到主对话' : '打开上次主对话'}</strong><small>{team.main.confirmed ? team.members.find(member => member.sessionId === team.main!.reference.sessionId && member.hostId === team.main!.reference.hostId)?.name ?? '主 Agent' : '上次保存的主对话 · 角色待核对'}</small></span><SemanticIcon name="navigation.disclosure" size={14} /></button>
      : <button type="button" className="mobile-mote-main-action" aria-label="核对主 Agent" onClick={onConfigure}><SemanticIcon name="object.conversation" size={17} /><span><strong>核对主 Agent</strong><small>成员与对话不受影响</small></span></button>)}
    {needsYou.length > 0 && <section className="mobile-mote-team-section"><h3>需要你 <span>{needsYou.length}</span></h3><ul>{needsYou.map(member => renderMember(member, true))}</ul></section>}
    <section className="mobile-mote-team-section">{membersOnly ? null : <h3>团队在做什么</h3>}<ul>{team?.members.map(member => renderMember(member))}</ul>
      {team && !team.members.length && <p className="mobile-mote-team-empty">成员还没确认，对话仍可继续。</p>}
      {!team && <p className="mobile-mote-team-empty">正在核对团队…</p>}
    </section>
  </section>
}
