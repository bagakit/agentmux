import { useRef, useState, type ReactNode } from 'react'
import type { AgentMuxRpcParams, AgentMuxRpcResult } from '@agentmux/core'
import { mintObjectId } from '@agentmux/core/object-id'
import type { MoteGroupMember, MoteGroupSummary } from '@agentmux/core/mote/group'
import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import { Button } from './Button.js'
import { Notice } from './Notice.js'
import { SemanticIcon } from '../theme/semantic-icon.js'
import type { MoteGroupCall, MoteGroupCandidate } from './MoteGroupConversation.js'

type RenderAvatar = (moteId: string, name: string) => ReactNode

export function MoteGroupAvatar({ memberIds, members, renderMoteAvatar }: {
  memberIds: readonly string[]
  members: readonly Pick<MoteGroupMember, 'moteId' | 'name'>[]
  renderMoteAvatar?: RenderAvatar | undefined
}) {
  const faces = memberIds.flatMap(id => {
    const member = members.find(item => item.moteId === id)
    return member ? [member] : []
  }).slice(0, 4)
  return <span className="mote-group-avatar" data-faces={faces.length} aria-hidden="true">
    {faces.length ? faces.map(member => <span key={member.moteId}>{renderMoteAvatar?.(member.moteId, member.name)
      ?? Array.from(member.name.trim())[0] ?? '·'}</span>) : <SemanticIcon name="object.team" size={20} />}
  </span>
}

export type MoteGroupSettingsValue = {
  avatarMoteIds: string[]
  announcement: string
  topic: MotePreferencesTarget | null
}

export function MoteGroupSettingsFields({ value, members, topicCandidates, renderMoteAvatar, disabled, onChange }: {
  value: MoteGroupSettingsValue
  members: readonly Pick<MoteGroupMember, 'moteId' | 'name'>[]
  topicCandidates: readonly MoteGroupCandidate[]
  renderMoteAvatar?: RenderAvatar | undefined
  disabled?: boolean
  onChange(value: MoteGroupSettingsValue): void
}) {
  const unavailableTopic = value.topic && !topicCandidates.some(candidate => candidate.target.spaceId === value.topic?.spaceId)
  return <div className="mote-group-settings__fields">
    {members.length > 0 ? <fieldset disabled={disabled}><legend>群头像</legend>
      <div className="mote-group-settings__faces">
        <MoteGroupAvatar memberIds={value.avatarMoteIds} members={members} renderMoteAvatar={renderMoteAvatar} />
        <div className="mote-group-settings__picks" role="group" aria-label="构成群头像的 Mote">
          {members.map(member => {
            const chosen = value.avatarMoteIds.includes(member.moteId)
            return <button className="mote-group-settings__face-pick" type="button" key={member.moteId} aria-pressed={chosen}
              disabled={!chosen && value.avatarMoteIds.length === 4} onClick={() => onChange({ ...value, avatarMoteIds:
                chosen ? value.avatarMoteIds.filter(id => id !== member.moteId) : [...value.avatarMoteIds, member.moteId] })}>
              {renderMoteAvatar?.(member.moteId, member.name)}<span>{member.name}</span>
            </button>
          })}
        </div>
      </div>
    </fieldset> : null}
    <label className="mote-group__field">群公告<textarea value={value.announcement} rows={3} maxLength={4096} disabled={disabled}
      placeholder="告诉新成员这个群要做什么" onChange={event => onChange({ ...value, announcement: event.target.value })} /></label>
    <label className="mote-group__field">群文件所在的 Topic<select value={value.topic?.spaceId ?? ''} disabled={disabled}
      onChange={event => onChange({ ...value, topic: topicCandidates.find(candidate => candidate.target.spaceId === event.target.value)?.target ?? null })}>
      <option value="">未绑定</option>
      {unavailableTopic ? <option value={value.topic!.spaceId}>已绑定的 Topic · 等待原来源</option> : null}
      {topicCandidates.map(candidate => <option key={candidate.target.spaceId} value={candidate.target.spaceId}>{candidate.name}</option>)}
    </select></label>
  </div>
}

type SettingsMethod = 'space.mote.group.update' | 'space.mote.group.members.add' | 'space.mote.group.members.remove'
type Pending = { [M in SettingsMethod]: { method: M; input: AgentMuxRpcParams<M> } }[SettingsMethod]
const activeMember = (member: MoteGroupMember) => (member.state ?? 'active') === 'active'

export function MoteGroupDetails({ group, candidates, topicCandidates, call, onUpdated, onPerspective, renderMoteAvatar }: {
  group: MoteGroupSummary
  candidates: readonly MoteGroupCandidate[]
  topicCandidates: readonly MoteGroupCandidate[]
  call: MoteGroupCall
  onUpdated(group: MoteGroupSummary): void
  onPerspective(moteId: string): void
  renderMoteAvatar?: RenderAvatar | undefined
}) {
  const [page, setPage] = useState<'members' | 'settings'>('members')
  const [invite, setInvite] = useState<string[]>([])
  const [edit, setEdit] = useState<{ revision: number; baseline: MoteGroupSettingsValue; value: MoteGroupSettingsValue } | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const [busy, setBusy] = useState(false)
  const active = group.members.filter(activeMember)
  const available = candidates.filter(candidate => !active.some(member => member.moteId === candidate.target.spaceId))
  const ready = Boolean(group.revision)
  const current = { avatarMoteIds: group.avatarMoteIds ?? [], announcement: group.announcement?.body ?? '', topic: group.topic ?? null }
  const staleEdit = edit !== null && edit.revision !== group.revision

  async function submit(action: Pending) {
    if (inFlight.current) return
    setPending(action)
    setError(null)
    inFlight.current = true
    setBusy(true)
    try {
      const result = await call(action.method, action.input) as AgentMuxRpcResult<'space.mote.group.update'>
      onUpdated(result.group)
      setPending(null)
      setEdit(null)
      setInvite([])
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : String(issue))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const base = () => ({ groupId: group.id, expectedRevision: group.revision, operationId: mintObjectId() })
  return <section className="mote-group__members mote-group-settings" aria-label="群资料">
    {ready ? <nav className="mote-group__views" aria-label="群资料分区">
      <button type="button" aria-pressed={page === 'members'} onClick={() => setPage('members')}>成员</button>
      <button type="button" aria-pressed={page === 'settings'} onClick={() => setPage('settings')}>公告与设置</button>
    </nav> : null}
    <div className="mote-group-settings__body">
    {error && pending ? <Notice tone="warning" heading="原群操作待核对" messageRole="status" density="compact"
      actions={<Button onClick={() => void submit(pending)} disabled={busy}>核对原操作</Button>}>{error}</Notice> : null}
    {page === 'members' ? <>
      <div className="mote-group-settings__members">{group.members.map(member => <div className="mote-group-settings__member" key={member.moteId}>
        <button type="button" onClick={() => onPerspective(member.moteId)}>
          <span className="mote-group__avatar" aria-hidden="true">{renderMoteAvatar?.(member.moteId, member.name) ?? Array.from(member.name.trim())[0] ?? '·'}</span>
          <strong>{member.name}</strong>
          <span>{member.state === 'left' ? '已退群' : member.state === 'removed' ? '已移出' : member.role === 'admin' ? '管理员' : member.thread ? '查看群内会话' : '尚未参与发言'}</span>
        </button>
        {ready && activeMember(member) ? <div className="mote-group-settings__member-actions">
          <Button disabled={Boolean(pending)} onClick={() => {
            const adminMoteIds = active.filter(item => item.role === 'admin' && item.moteId !== member.moteId).map(item => item.moteId)
            if (member.role !== 'admin') adminMoteIds.push(member.moteId)
            void submit({ method: 'space.mote.group.update', input: { ...base(), adminMoteIds } })
          }}>{member.role === 'admin' ? '撤下管理员' : '设为管理员'}</Button>
          <Button disabled={Boolean(pending)} onClick={() => void submit({ method: 'space.mote.group.members.remove',
            input: { ...base(), memberIds: [member.moteId] } })}>移出</Button>
        </div> : null}
      </div>)}</div>
      {ready && available.length > 0 ? <details className="mote-group-settings__invite">
        <summary>邀请 Mote</summary>
        <div className="mote-group-settings__invite-options">{available.map(candidate => <label key={candidate.target.spaceId}>
          <input type="checkbox" disabled={Boolean(pending)} checked={invite.includes(candidate.target.spaceId)} onChange={event => setInvite(
            event.target.checked ? [...invite, candidate.target.spaceId] : invite.filter(id => id !== candidate.target.spaceId))} />
          {candidate.name}</label>)}</div>
        <Button variant="primary" disabled={Boolean(pending) || !invite.length} onClick={() => void submit({ method: 'space.mote.group.members.add',
          input: { ...base(), members: available.filter(candidate => invite.includes(candidate.target.spaceId)).map(candidate => candidate.target) } })}>邀请成员</Button>
      </details> : null}
    </> : <>
      {staleEdit && !pending ? <Notice tone="warning" density="compact" messageRole="status"
        actions={<Button onClick={() => setEdit(null)}>读取最新群资料</Button>}>群资料已更新。当前修改仍保留。</Notice> : null}
      <MoteGroupSettingsFields value={edit?.value ?? current} members={active} topicCandidates={topicCandidates} renderMoteAvatar={renderMoteAvatar}
        disabled={Boolean(pending)} onChange={value => setEdit(previous => previous
          ? { ...previous, value } : { revision: group.revision, baseline: current, value })} />
      <Button variant="primary" disabled={!edit || Boolean(pending) || staleEdit} onClick={() => {
        if (!edit) return
        const { value, baseline } = edit
        const changes = {
          ...(JSON.stringify(value.avatarMoteIds) === JSON.stringify(baseline.avatarMoteIds) ? {} : { avatarMoteIds: value.avatarMoteIds }),
          ...(value.announcement.trim() === baseline.announcement ? {} : { announcement: value.announcement.trim() || null }),
          ...(value.topic?.spaceId === baseline.topic?.spaceId ? {} : { topic: value.topic }),
        }
        if (!Object.keys(changes).length) { setEdit(null); return }
        void submit({ method: 'space.mote.group.update', input: { ...base(), expectedRevision: edit.revision, ...changes } })
      }}>保存群资料</Button>
    </>}
    </div>
  </section>
}
