import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxSpaceAppearance } from '@agentmux/core/control'
import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import { parseMoteGroupParams, type MoteGroupMember } from '@agentmux/core/mote/group'
import type { OpenHttpLink } from '@agentmux/client-ui/components/AgentMarkdown'
import { Button } from '@agentmux/client-ui/components/Button'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { IconButton } from '@agentmux/client-ui/components/IconButton'
import { MoteGroupAvatar, MoteGroupConversation, useMoteGroups, type MoteGroupCall, type MoteGroupCandidate, type MoteGroupDraft, type MoteGroupCreation, type MoteGroupReadingPositions } from '@agentmux/client-ui/components/MoteGroupConversation'
import { Notice } from '@agentmux/client-ui/components/Notice'
import { describeConversationWindow } from '@agentmux/client-ui/conversation-records'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { useConversationView } from '@agentmux/client-ui/use-conversation-view'
import { useMobileLocalDrafts } from '../conversation/local-drafts-owner'
import { MobileMoteSpeakerAvatar } from '../conversation/MobileMoteSpeakerAvatar'
import { MobileTopicSource } from '../topics/MobileTopicSource'
import { getDeviceWorkface } from '../recovery/device-workface'
import './mote-groups.css'

export type { MoteGroupReadingPositions } from '@agentmux/client-ui/components/MoteGroupConversation'

function sourceIdentity(client: AgentMuxHostedClient | null) {
  const { host, recordId } = getDeviceWorkface().snapshotIdentity()
  const runtime = client?.runtimeOwnerIdentity?.()
  return { origin: host?.origin ?? location.origin, hostId: host?.hostId ?? null, recordId, runtimeId: runtime?.runtimeId }
}

function parseDraft(text: string | undefined): MoteGroupDraft | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as Partial<MoteGroupDraft> | null
    if (typeof value?.body !== 'string' || !Array.isArray(value.recipientIds) ||
        value.recipientIds.some(id => typeof id !== 'string') ||
        value.operationId !== undefined && typeof value.operationId !== 'string' ||
        value.replyToMessageId !== undefined && typeof value.replyToMessageId !== 'string') return null
    return value as MoteGroupDraft
  } catch { return null }
}

export function MobileMoteGroups({ client, connected, moteId, positions, openHttpLink, onBackChange }: {
  client: AgentMuxHostedClient | null; connected: boolean; moteId?: string; positions: MoteGroupReadingPositions; openHttpLink?: OpenHttpLink; onBackChange?(back: (() => void) | null): void
}) {
  const local = useMobileLocalDrafts()
  const [source] = useState(() => sourceIdentity(client))
  const [openedClient] = useState(() => client)
  const current = useRef({ client, connected })
  current.current = { client, connected }
  const [view, setView] = useState<{ groupId: string; members: boolean } | 'create' | null>(null)
  const [candidates, setCandidates] = useState<{ values: MoteGroupCandidate[]; error: string | null }>({ values: [], error: null })
  const [topicCandidates, setTopicCandidates] = useState<{ values: MoteGroupCandidate[]; error: string | null }>({ values: [], error: null })
  const [appearances, setAppearances] = useState(new Map<string, AgentMuxSpaceAppearance | null>())
  const appearanceRequests = useRef(new Set<string>())
  const [files, setFiles] = useState<MotePreferencesTarget | null>(null)
  const [fileBack, setFileBack] = useState<(() => void) | null>(null)
  const registerFileBack = useCallback((back: (() => void) | null) => setFileBack(() => back), [])
  const closeFiles = useCallback(() => setFiles(null), [])
  const listView = view === null
  useLayoutEffect(() => {
    if (listView || !onBackChange) return
    onBackChange(files ? fileBack ?? closeFiles : () => setView(null))
    return () => onBackChange(null)
  }, [closeFiles, fileBack, files, listView, onBackChange])
  const [listConfirmed, setListConfirmed] = useState(false)
  const [candidateRevision, setCandidateRevision] = useState(0)
  const [draftNotice, setDraftNotice] = useState<string | null>(null)
  const sourceMatches = useCallback(() => {
    const observed = sourceIdentity(current.current.client)
    return (!openedClient || current.current.client === openedClient) && observed.recordId === source.recordId &&
      observed.hostId === source.hostId && observed.origin === source.origin && (!source.runtimeId || observed.runtimeId === source.runtimeId)
  }, [openedClient, source])
  const request = useCallback<NonNullable<AgentMuxHostedClient['forwardRpc']>>(async (method, input, options) => {
    const observed = current.current
    if (!observed.connected || !observed.client?.forwardRpc) throw new Error('连接暂不可用，请连接原 Mac 后重试群聊。')
    if (!sourceMatches()) throw new Error('群聊的原连接已变化，请返回后重新打开。')
    const runtime = observed.client.runtimeOwnerIdentity?.()
    const fence = runtime?.ownerInstanceId ? { runtimeId: runtime.runtimeId, ownerInstanceId: runtime.ownerInstanceId } : undefined
    const result = await observed.client.forwardRpc(method, input, options, fence)
    if (observed.client !== current.current.client || !sourceMatches()) throw new Error('群聊请求的原连接已变化，本次结果待核对。')
    if (method === 'space.mote.group.list') setListConfirmed(true)
    return result
  }, [sourceMatches])
  const call: MoteGroupCall = request
  const groups = useMoteGroups(call, { enabled: listView, ...(moteId ? { moteId } : {}) })
  const creating = view === 'create'
  const chooserOpen = view !== null
  useEffect(() => {
    if (!chooserOpen || !connected || !client?.forwardRpc || !sourceMatches()) return
    const controller = new AbortController()
    const scopes = request('space.ls', { target: {}, presentation: true }, { signal: controller.signal })
    void scopes.then(({ catalog }) => {
      if (controller.signal.aborted || !sourceMatches()) return
      const spaces = new Map(catalog.spaces.filter(space => space.kind === 'mote').map(space => [space.spaceId, space]))
      const values = catalog.motePresentation?.flatMap(fact => {
        const space = spaces.get(fact.spaceId), content = fact.content
        return space && content ? [{ name: space.name, target: { spaceId: space.spaceId, zoneId: content.zoneId,
          expectedResource: { hostId: content.hostId, workspaceId: content.workspaceId, workspacePath: content.workspacePath } } }] : []
      }) ?? []
      setCandidates({ values, error: null })
      setAppearances(previous => {
        const next = new Map(previous)
        for (const original of catalog.appearance ?? []) {
          if (!spaces.has(original.spaceId)) continue
          const prior = previous.get(original.spaceId)
          const image = prior?.image
          const retainImage = image?.dataUrl && original.image &&
            image.revision === original.image.revision && !original.image.dataUrl
          next.set(original.spaceId, retainImage ? { ...original, image } : original)
        }
        return next
      })
    }).catch(error => {
      if (!controller.signal.aborted) setCandidates(previous => ({ ...previous, error: error instanceof Error ? error.message : String(error) }))
    })
    void Promise.all([scopes, request('topic.ls', {}, { signal: controller.signal }),
      request('app.snapshot', { include: ['workspaces'] }, { signal: controller.signal })]).then(([{ catalog }, { topics }, { workspaces }]) => {
      if (controller.signal.aborted || !sourceMatches()) return
      const values = topics.flatMap(topic => {
        const zone = catalog.zones.find(zone => zone.zoneId === topic.zoneId && zone.hostId === topic.hostId &&
          zone.kind !== 'unknown' && zone.directoryPath === topic.directoryPath)
        const workspace = zone && workspaces.find(workspace => workspace.hostId === topic.hostId && workspace.workspaceId === zone.workspaceId)
        return topic.contentKind !== 'mote' && !topic.readError && zone && workspace && (!topic.workspaceId || topic.workspaceId === zone.workspaceId)
          ? [{ name: topic.title, target: { spaceId: topic.topicId, zoneId: zone.zoneId,
            expectedResource: { hostId: workspace.hostId, workspaceId: workspace.workspaceId, workspacePath: workspace.path } } }] : []
      })
      setTopicCandidates({ values, error: null })
    }).catch(error => {
      if (!controller.signal.aborted) setTopicCandidates(previous => ({ ...previous, error: error instanceof Error ? error.message : String(error) }))
    })
    return () => controller.abort()
  }, [candidateRevision, client, connected, chooserOpen, request, sourceMatches])

  const ensureAppearance = useCallback((id: string) => {
    if (!connected || appearanceRequests.current.has(id)) return
    appearanceRequests.current.add(id)
    void request('space.inspect', { target: { spaceId: id }, presentation: 'status' }).then(({ catalog }) => {
      const exact = catalog.appearance?.find(value => value.spaceId === id) ?? null
      setAppearances(previous => new Map(previous).set(id, exact ?? previous.get(id) ?? null))
    }).catch(() => { appearanceRequests.current.delete(id) })
  }, [connected, request])
  const renderMoteAvatar = useCallback((id: string, name: string) =>
    <MobileMoteGroupMemberAvatar id={id} name={name} appearance={appearances.get(id)} ensure={ensureAppearance} />,
  [appearances, ensureAppearance])

  const custody = useMemo(() => {
    const scope = [source.origin, source.hostId, source.runtimeId ?? null]
    const keyFor = (id: string) => JSON.stringify(['mote-group', ...scope, id])
    const creationKey = JSON.stringify(['mote-group-creation', ...scope])
    const readCreation = () => {
      const saved = local.drafts.get(creationKey)
      if (!saved) return null
      try { return parseMoteGroupParams('space.mote.group.create', JSON.parse(saved)) }
      catch { return null }
    }
    const save = async (key: string, previous: string | undefined) => {
      if (previous === local.drafts.get(key)) return
      await local.saveText(key, previous)
      setDraftNotice(local.notice)
    }
    return {
      draft: {
        read: (id: string) => parseDraft(local.drafts.get(keyFor(id))),
        write: async (id: string, value: MoteGroupDraft) => {
          const key = keyFor(id), previous = local.drafts.get(key)
          if (!value.body && !value.operationId && !value.replyToMessageId && !value.recipientIds.length) local.drafts.delete(key)
          else local.drafts.set(key, JSON.stringify(value))
          await save(key, previous)
        },
        clear: async (id: string, operationId: string) => {
          const key = keyFor(id), previous = local.drafts.get(key)
          if (parseDraft(previous)?.operationId !== operationId) return
          local.drafts.delete(key)
          await save(key, previous)
        },
      },
      creation: {
        read: readCreation,
        write: async (input: MoteGroupCreation) => {
          const previous = local.drafts.get(creationKey)
          local.drafts.set(creationKey, JSON.stringify(input))
          await save(creationKey, previous)
        },
        clear: async (operationId: string) => {
          if (readCreation()?.operationId !== operationId) return
          const previous = local.drafts.get(creationKey)
          local.drafts.delete(creationKey)
          await save(creationKey, previous)
        },
      },
    }
  }, [local, source])

  const groupId = view && view !== 'create' ? view.groupId : null
  if (view !== null) return <div className="mobile-mote-groups">
    <div className="mobile-mote-groups__content" hidden={files !== null}>
    {candidates.error ? <Notice tone="warning" density="compact" messageRole="status"
      actions={<Button type="button" onClick={() => setCandidateRevision(value => value + 1)}>重读 Mote</Button>}>{candidates.error}</Notice> : null}
    {topicCandidates.error ? <Notice tone="warning" density="compact" messageRole="status"
      actions={<Button type="button" onClick={() => setCandidateRevision(value => value + 1)}>重读 Topics</Button>}>{topicCandidates.error}</Notice> : null}
    {draftNotice ? <Notice tone="warning" density="compact" messageRole="status">{draftNotice}</Notice> : null}
    <MoteGroupConversation call={call} candidates={candidates.values} topicCandidates={topicCandidates.values} groupId={groupId} creating={creating}
      renderMoteAvatar={renderMoteAvatar} onOpenTopicFiles={setFiles}
      {...(moteId ? { initialMoteId: moteId } : {})} initialMembers={view !== 'create' && view.members}
      onOpen={groupId => setView({ groupId, members: false })} onClose={() => setView(null)} positions={positions} {...custody}
      renderThread={thread => <MobileMoteGroupThread client={connected && sourceMatches() ? client : null} thread={thread} />} />
    </div>
    {files && <MobileMoteGroupFiles key={JSON.stringify(files)} target={files} request={request} onBack={closeFiles} onBackChange={registerFileBack}
      {...(openHttpLink ? { openHttpLink } : {})} />}
  </div>
  return <section className="mobile-mote-groups" aria-label={moteId ? 'Mote 的群聊' : '群聊列表'}>
    {!moteId && <Button type="button" onClick={() => setView('create')}><SemanticIcon name="action.add-item" size={16} />{custody.creation.read() ? '继续创建群聊' : '创建群聊'}</Button>}
    {groups.error && <Notice tone="warning" density="compact" messageRole="status"
      actions={<Button type="button" onClick={groups.refresh}>重读群聊</Button>}>{groups.error}</Notice>}
    {!groups.groups.length && !groups.error && <p role="status">{!listConfirmed || groups.loading ? '正在读取群聊…' : '暂无群聊'}</p>}
    {groups.groups.length > 0 && <ul className="mobile-mote-groups__list">{groups.groups.map(group => <li key={group.id}>
      <IconButton type="button" title={`${group.name} · 群资料`} aria-label={`查看 ${group.name} 的群资料`} className="mobile-mote-groups__avatar"
        onClick={() => setView({ groupId: group.id, members: true })}><MoteGroupAvatar memberIds={group.avatarMoteIds} members={group.members} renderMoteAvatar={renderMoteAvatar} /></IconButton>
      <button type="button" className="mobile-mote-groups__row" onClick={() => setView({ groupId: group.id, members: false })}>
        <strong>{group.name}</strong><small>{group.lastMessage?.body ?? '暂无消息'}</small>
      </button>
    </li>)}</ul>}
    {groups.hasMore && <Button type="button" disabled={groups.loading} onClick={groups.loadMore}>更多群聊</Button>}
  </section>
}

function MobileMoteGroupMemberAvatar({ id, name, appearance, ensure }: {
  id: string; name: string; appearance: AgentMuxSpaceAppearance | null | undefined; ensure(id: string): void
}) {
  useEffect(() => {
    if (appearance === undefined || appearance?.image && !appearance.image.dataUrl) ensure(id)
  }, [appearance, ensure, id])
  return <MobileMoteSpeakerAvatar spaceId={id} name={name} appearance={appearance ?? undefined} size={18} />
}

function MobileMoteGroupFiles({ target, request, onBack, openHttpLink, onBackChange }: {
  target: MotePreferencesTarget; request: NonNullable<AgentMuxHostedClient['forwardRpc']>; onBack(): void; openHttpLink?: OpenHttpLink
  onBackChange(back: (() => void) | null): void
}) {
  const [state, setState] = useState<{ topic: { path: string; title: string } | null; issue: string | null }>({ topic: null, issue: null })
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void request('topic.inspect', { topicId: target.spaceId }, { signal: controller.signal }).then(({ topic }) => {
      if (controller.signal.aborted) return
      if (!topic || topic.topicId !== target.spaceId || topic.zoneId !== target.zoneId || topic.hostId !== target.expectedResource.hostId ||
          topic.workspaceId && topic.workspaceId !== target.expectedResource.workspaceId || topic.contentKind === 'mote' || topic.readError) {
        throw new Error('群聊绑定的原 Topic 文件范围暂未确认。')
      }
      setState({ topic: { path: topic.directoryPath, title: topic.title }, issue: null })
    }).catch(error => {
      if (!controller.signal.aborted) setState({ topic: null, issue: error instanceof Error ? error.message : String(error) })
    })
    return () => controller.abort()
  }, [request, retry, target])
  if (state.topic) return <MobileTopicSource source={{ kind: 'file', hostId: target.expectedResource.hostId, path: state.topic.path }}
    expectedFileRoot={target} rpc={request} rootTitle={state.topic.title} presentation={{ presented: true, observed: true }} onBack={onBack} onBackChange={onBackChange} backLabel="返回群聊"
    {...(openHttpLink ? { openHttpLink } : {})} />
  return <div className="mobile-mote-groups__files-state"><Button type="button" onClick={onBack}>返回群聊</Button>
    {state.issue ? <Notice tone="warning" density="compact" messageRole="status"
      actions={<Button type="button" onClick={() => setRetry(value => value + 1)}>重读文件范围</Button>}>{state.issue}</Notice>
      : <p role="status">正在核对群文件…</p>}
  </div>
}

function MobileMoteGroupThread({ client, thread }: { client: AgentMuxHostedClient | null; thread: NonNullable<MoteGroupMember['thread']> }) {
  const reading = useConversationView(client, thread, Boolean(client), { identity: 'mobile-mote-group-thread' })
  const content = useMemo(() => reading.reading ? describeConversationWindow(reading.reading) : null, [reading.reading])
  const issue = reading.error ?? reading.observationError
  return <section className="mobile-mote-groups__thread" aria-label="群内 Agent 原会话">
    {issue && <Notice tone="warning" density="compact" messageRole="status"
      actions={<Button type="button" onClick={() => void reading.refresh()}>重读原会话</Button>}>{issue.message}</Notice>}
    {content ? <ConversationView sessionId={thread.agentSessionId} executionHostId={thread.hostId} records={content.records} originalRecords={content.originalRecords}
      page={content.historyPage ?? null} coverage={content.timeline.coverage} coverageSummary="阅读范围与来源" showInputSource={false}
      detailsOnlyMetadata sourceLabelsInDetails active={Boolean(client)} readProcessDetail={reading.readProcessDetail} />
      : !issue && <p role="status">{client ? '正在读取群内会话…' : '群内会话的原连接暂不可用。'}</p>}
    {reading.hasMore && <Button type="button" onClick={() => void reading.earlier()}>更早的会话记录</Button>}
  </section>
}
