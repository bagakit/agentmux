import { useEffect, useState, type ReactNode } from 'react'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { Button } from '@agentmux/client-ui/components/Button'
import { MoteGroupAvatar, MoteGroupConversation, useMoteGroups, type MoteGroupDraft, type MoteGroupCreation, type MoteGroupCandidate, type MoteGroupReadingPositions, type RenderMoteGroupAvatar } from '@agentmux/client-ui/components/MoteGroupConversation'
import type { MoteGroupSummary } from '@agentmux/core/mote/group'
import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import { MoteGroupFiles } from '@agentmux/client-ui/components/MoteGroupFiles'
import type { ScratchTopicSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { useAppStore } from '../store'
import { topicSpaceIconTarget } from '../lib/space-object-appearance'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { api } from '../lib/api'
import { checkpointLauncherState, useLauncherState } from '../lib/launcher-state'
import { requestMoteGroupFloatingOpen, requestPmoTeamsTopicFloatingClose } from '../lib/pmo-teams-topic-floating'
import { MoteSessionConversation } from './MoteSessionConversation'

const draftKey = (groupId: string) => 'mote-group:' + groupId
const creationKey = 'mote-group-creation'
function readSaved<T>(key: string): T | null {
  const saved = useLauncherState.getState().drafts[key]?.prompt
  if (!saved) return null
  try { return JSON.parse(saved) as T } catch { return null }
}
function save(key: string, value: string) {
  if (!useLauncherState.getState().setDraft(key, 'prompt', value)) throw new Error('群聊草稿保存失败。')
}
const draft = {
  read(groupId: string): MoteGroupDraft | null {
    const value = readSaved<MoteGroupDraft>(draftKey(groupId))
    return value && typeof value.body === 'string' && Array.isArray(value.recipientIds) ? value : null
  },
  async write(groupId: string, value: MoteGroupDraft) {
    save(draftKey(groupId), JSON.stringify(value))
    if (value.operationId || !value.body) await checkpointLauncherState()
  },
  async clear(groupId: string, operationId: string) {
    if (draft.read(groupId)?.operationId !== operationId) return
    save(draftKey(groupId), '')
    await checkpointLauncherState()
  }
}
const creation = {
  read() { return readSaved<MoteGroupCreation>(creationKey) },
  async write(input: MoteGroupCreation) {
    save(creationKey, JSON.stringify(input))
    await checkpointLauncherState()
  },
  async clear(operationId: string) {
    if (creation.read()?.operationId !== operationId) return
    save(creationKey, '')
    await checkpointLauncherState()
  }
}

type TopicCandidate = MoteGroupCandidate & { topicId: string }
export function DesktopGroupMoteAvatar({ workspace, topic }: { workspace: WorkspaceRecord; topic: ScratchTopicSnapshot }) {
  const bindings = useAppStore(state => state.spaceZoneBindings)
  const target = topicSpaceIconTarget(workspace, topic, bindings)
  const manualIcon = useAppStore(state => target ? state.spaceObjectIcons[target.key] ?? null : null)
  return <SpaceObjectIcon kind="mote" name={topic.title} manualIcon={manualIcon} avatarObjectKey={target?.key}
    avatarWorkspaceId={target?.avatarTarget?.workspaceId} avatarTopicId={target?.avatarTarget?.topicId} />
}

export function DesktopMoteGroup({ groupId, initialGroup, moteId, members, creating, candidates, topicCandidates, renderMoteAvatar, onOpen, onClose, onChanged, onPerspectiveChange, positions }: {
  groupId: string | null
  initialGroup?: MoteGroupSummary | undefined
  moteId?: string | undefined
  members?: boolean | undefined
  creating: boolean
  candidates: readonly MoteGroupCandidate[]
  topicCandidates: readonly TopicCandidate[]
  renderMoteAvatar: RenderMoteGroupAvatar
  onOpen(groupId: string): void
  onClose(): void
  onChanged(group?: MoteGroupSummary): void
  positions: MoteGroupReadingPositions
  onPerspectiveChange(moteId: string | undefined): void
}) {
  const [files, setFiles] = useState<{ groupId: string | null; target: MotePreferencesTarget } | null>(null)
  if (!creating && groupId && files && groupId === files.groupId) {
    const original = topicCandidates.find(candidate => candidate.target.spaceId === files.target.spaceId && candidate.target.zoneId === files.target.zoneId)
    return <MoteGroupFiles key={groupId} call={api.moteGroup.call} groupId={groupId} target={files.target} name={original?.name} onBack={() => setFiles(null)}
      actions={original && <Button onClick={() => {
        void useAppStore.getState().openScratchTopic(original.topicId, files.target.expectedResource.workspaceId).then(opened => {
          if (opened) { setFiles(null); requestPmoTeamsTopicFloatingClose({ restoreFocus: false }) }
        }).catch(error => useAppStore.getState().reportError(error instanceof Error ? error.message : String(error)))
      }}>打开 Topic</Button>} />
  }
  return <MoteGroupConversation call={api.moteGroup.call} initialGroup={initialGroup} candidates={candidates} topicCandidates={topicCandidates} renderMoteAvatar={renderMoteAvatar}
    onOpenTopicFiles={target => setFiles({ groupId, target })} groupId={groupId} creating={creating}
    {...(moteId === undefined ? {} : { initialMoteId: moteId })} {...(members === undefined ? {} : { initialMembers: members })}
    onOpen={onOpen} onClose={onClose} onChanged={onChanged} onPerspectiveChange={onPerspectiveChange} draft={draft} creation={creation} positions={positions}
    renderThread={thread => <MoteSessionConversation {...thread} identity={'mote-group:' + groupId} active />} />
}

export function DesktopMoteGroupRail({ groups, selectedId, avatars, renderMoteAvatar, open }: {
  groups: readonly MoteGroupSummary[]
  selectedId?: string | undefined
  avatars: boolean
  renderMoteAvatar: RenderMoteGroupAvatar
  open(groupId: string, members: boolean): void
}) {
  return groups.map(group => <div className="mote-chooser__row" key={group.id}>
    <button type="button" className="mote-chooser__profile mote-chooser__group-icon" aria-label={group.name + ' · 群成员'}
      title={group.name + ' · 群成员'} onClick={() => open(group.id, true)}>
      <MoteGroupAvatar memberIds={group.avatarMoteIds ?? []} members={group.members} renderMoteAvatar={renderMoteAvatar} /></button>
    <button type="button" className="mote-chooser__choice" aria-pressed={selectedId === group.id} aria-label={group.name} onClick={() => open(group.id, false)}>
      {avatars ? <span className="mote-chooser__group-selection" aria-hidden="true" /> : <>
        <span className="mote-chooser__name"><strong>{group.name}</strong></span>
        <span className="mote-chooser__preview" data-mote-message-preview={group.lastMessage ? true : undefined}>
          {group.lastMessage ? (group.lastMessage.author.kind === 'mote' ? group.lastMessage.author.name + ' · ' : group.lastMessage.author.kind === 'system' ? '群公告 · ' : '我 · ') + group.lastMessage.body.replace(/\s+/gu, ' ') : group.members.filter(member => (member.state ?? 'active') === 'active').length + ' 位 Mote'}
        </span>
      </>}
    </button>
  </div>)
}

export function DesktopMoteThreadGroups({ moteId, active }: { moteId: string | undefined; active: boolean }): ReactNode {
  const directory = useMoteGroups(api.moteGroup.call, { enabled: active && Boolean(moteId), ...(moteId ? { moteId } : {}) })
  if (!active || !moteId || (!directory.groups.length && !directory.error)) return null
  return <details className="mote-thread-groups">
    <summary>群聊 <span>{directory.groups.length}</span></summary>
    {directory.groups.map(group => <button className="mote-thread-groups__row" type="button" key={group.id} onClick={() => requestMoteGroupFloatingOpen(group.id, moteId)}>
      <SemanticIcon name="object.team" size={16} /><strong>{group.name}</strong><span>群内视角</span></button>)}
    {directory.error ? <div role="status" className="mote-thread-groups__issue"><span>{directory.error}</span><Button onClick={directory.refresh}>重读群聊</Button></div> : null}
    {directory.hasMore ? <Button disabled={directory.loading} onClick={directory.loadMore}>更多群聊</Button> : null}
  </details>
}
