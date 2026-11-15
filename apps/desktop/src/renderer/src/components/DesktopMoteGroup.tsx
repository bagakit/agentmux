import { useEffect, useState, type ReactNode } from 'react'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { Button } from '@agentmux/client-ui/components/Button'
import { MoteGroupAvatar, MoteGroupConversation, useMoteGroups, type MoteGroupDraft, type MoteGroupCreation, type MoteGroupCandidate, type MoteGroupReadingPositions } from '@agentmux/client-ui/components/MoteGroupConversation'
import type { MoteGroupSummary } from '@agentmux/core/mote/group'
import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import type { FileDirectoryEntry } from '@agentmux/core/files'
import { Notice } from '@agentmux/client-ui/components/Notice'
import type { ScratchTopicSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { useAppStore } from '../store'
import { topicSpaceIconTarget } from '../lib/space-object-appearance'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { api } from '../lib/api'
import { checkpointLauncherState, useLauncherState } from '../lib/launcher-state'
import { requestMoteGroupFloatingOpen } from '../lib/pmo-teams-topic-floating'
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
type AvatarRenderer = (moteId: string, name: string) => ReactNode

export function DesktopGroupMoteAvatar({ workspace, topic }: { workspace: WorkspaceRecord; topic: ScratchTopicSnapshot }) {
  const bindings = useAppStore(state => state.spaceZoneBindings)
  const target = topicSpaceIconTarget(workspace, topic, bindings)
  const manualIcon = useAppStore(state => target ? state.spaceObjectIcons[target.key] ?? null : null)
  return <SpaceObjectIcon kind="mote" name={topic.title} manualIcon={manualIcon} avatarObjectKey={target?.key}
    avatarWorkspaceId={target?.avatarTarget?.workspaceId} avatarTopicId={target?.avatarTarget?.topicId} />
}

export function DesktopMoteGroup({ groupId, moteId, members, creating, candidates, topicCandidates, renderMoteAvatar, onOpen, onClose, onChanged, onPerspectiveChange, positions }: {
  groupId: string | null
  moteId?: string | undefined
  members?: boolean | undefined
  creating: boolean
  candidates: readonly MoteGroupCandidate[]
  topicCandidates: readonly TopicCandidate[]
  renderMoteAvatar: AvatarRenderer
  onOpen(groupId: string): void
  onClose(): void
  onChanged(): void
  positions: MoteGroupReadingPositions
  onPerspectiveChange(moteId: string | undefined): void
}) {
  const [files, setFiles] = useState<{ groupId: string | null; target: MotePreferencesTarget } | null>(null)
  if (!creating && files && groupId === files.groupId) {
    const original = topicCandidates.find(candidate => candidate.target.spaceId === files.target.spaceId && candidate.target.zoneId === files.target.zoneId)
    return <DesktopGroupTopicFiles key={files.target.spaceId} target={files.target} original={original} onClose={() => setFiles(null)} />
  }
  return <MoteGroupConversation call={api.moteGroup.call} candidates={candidates} topicCandidates={topicCandidates} renderMoteAvatar={renderMoteAvatar}
    onOpenTopicFiles={target => setFiles({ groupId, target })} groupId={groupId} creating={creating}
    {...(moteId === undefined ? {} : { initialMoteId: moteId })} {...(members === undefined ? {} : { initialMembers: members })}
    onOpen={onOpen} onClose={onClose} onChanged={onChanged} onPerspectiveChange={onPerspectiveChange} draft={draft} creation={creation} positions={positions}
    renderThread={thread => <MoteSessionConversation {...thread} identity={'mote-group:' + groupId} active />} />
}

export function DesktopMoteGroupRail({ groups, selectedId, avatars, renderMoteAvatar, open }: {
  groups: readonly MoteGroupSummary[]
  selectedId?: string | undefined
  avatars: boolean
  renderMoteAvatar: AvatarRenderer
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


function DesktopGroupTopicFiles({ target, original, onClose }: {
  target: MotePreferencesTarget; original: TopicCandidate | undefined; onClose(): void
}) {
  const [directories, setDirectories] = useState<string[]>([])
  const [document, setDocument] = useState<{ path: string; content: string } | null>(null)
  const [list, setList] = useState<{ path: string; entries: FileDirectoryEntry[]; complete: boolean } | null>(null)
  const [issue, setIssue] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const directory = directories.at(-1) ?? '.'
  useEffect(() => {
    let canceled = false
    setIssue(null)
    const input = { ...target, path: directory, mode: 'directory' as const, limit: 100 }
    if (selected) {
      const read = { ...target, path: selected }
      void api.files.readPublic(read).then(({ result }) => {
        if (canceled) return
        if (result.status === 'read') setDocument(result.document)
        else setIssue('message' in result ? result.message : '原文件不可读取。')
      }).catch(error => { if (!canceled) setIssue(error instanceof Error ? error.message : String(error)) })
    } else void api.files.listPublic(input).then(({ result }) => {
      if (canceled) return
      if (result.status === 'directory-listed') setList({ path: directory, entries: result.entries, complete: result.complete })
      else setIssue('message' in result ? result.message : '原文件目录暂未确认。')
    }).catch(error => { if (!canceled) setIssue(error instanceof Error ? error.message : String(error)) })
    return () => { canceled = true }
  }, [target, directory, selected, attempt])
  return <section className="mote-group mote-group-files" aria-label="群文件">
    <header className="mote-group__header"><div><h2>群文件</h2><p>{original?.name ?? '绑定的 Topic'}</p></div>
      <Button onClick={onClose}>返回群聊</Button></header>
    <div className="mote-group-files__body">
      {selected || directories.length ? <Button onClick={() => {
        if (selected) { setSelected(null); setDocument(null) } else setDirectories(value => value.slice(0, -1))
      }}>返回上一级</Button> : null}
      {original ? <Button onClick={() => {
        void useAppStore.getState().openScratchTopic(original.topicId, target.expectedResource.workspaceId).then(opened => {
          if (opened) onClose()
        }).catch(error => setIssue(error instanceof Error ? error.message : String(error)))
      }}>打开 Topic</Button> : null}
      {issue ? <Notice tone="warning" messageRole="status" actions={<Button onClick={() => setAttempt(value => value + 1)}>重读</Button>}>{issue}</Notice> : null}
      {selected ? document ? <section><h3>{document.path}</h3><pre>{document.content}</pre></section> :
        !issue ? <p role="status">正在读取原文件…</p> : null :
        list?.path === directory ? <>
          <ul className="mote-group-files__list">{list.entries.map(entry => <li key={entry.path}>
            <button type="button" onClick={() => {
              if (entry.isDirectory) setDirectories(previous => [...previous, entry.path])
              else setSelected(entry.path)
            }}><SemanticIcon name={entry.isDirectory ? 'object.folder' : 'object.document'} size={16} />{entry.name}</button>
          </li>)}</ul>
          {!list.entries.length ? <p>这个目录暂无文件。</p> : null}
          {!list.complete ? <p>已显示当前可读取的目录条目。</p> : null}
        </> : !issue ? <p role="status">正在读取原目录…</p> : null}
    </div>
  </section>
}
