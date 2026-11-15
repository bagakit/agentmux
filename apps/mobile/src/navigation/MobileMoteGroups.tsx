import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { parseMoteGroupParams, type MoteGroupMember } from '@agentmux/core/mote/group'
import { Button } from '@agentmux/client-ui/components/Button'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { IconButton } from '@agentmux/client-ui/components/IconButton'
import { MoteGroupConversation, useMoteGroups, type MoteGroupCall, type MoteGroupCandidate, type MoteGroupDraft, type MoteGroupCreation, type MoteGroupReadingPositions } from '@agentmux/client-ui/components/MoteGroupConversation'
import { Notice } from '@agentmux/client-ui/components/Notice'
import { describeConversationWindow } from '@agentmux/client-ui/conversation-records'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { useConversationView } from '@agentmux/client-ui/use-conversation-view'
import { useMobileLocalDrafts } from '../conversation/local-drafts-owner'
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

export function MobileMoteGroups({ client, connected, moteId, positions }: {
  client: AgentMuxHostedClient | null; connected: boolean; moteId?: string; positions: MoteGroupReadingPositions
}) {
  const local = useMobileLocalDrafts()
  const [source] = useState(() => sourceIdentity(client))
  const [openedClient] = useState(() => client)
  const current = useRef({ client, connected })
  current.current = { client, connected }
  const [view, setView] = useState<{ groupId: string; members: boolean } | 'create' | null>(null)
  const [candidates, setCandidates] = useState<{ values: MoteGroupCandidate[]; error: string | null }>({ values: [], error: null })
  const [listConfirmed, setListConfirmed] = useState(false)
  const [candidateRevision, setCandidateRevision] = useState(0)
  const [draftNotice, setDraftNotice] = useState<string | null>(null)
  const sourceMatches = useCallback(() => {
    const observed = sourceIdentity(current.current.client)
    return (!openedClient || current.current.client === openedClient) && observed.recordId === source.recordId &&
      observed.hostId === source.hostId && observed.origin === source.origin && (!source.runtimeId || observed.runtimeId === source.runtimeId)
  }, [openedClient, source])
  const call = useCallback<MoteGroupCall>(async (method, input) => {
    const observed = current.current
    if (!observed.connected || !observed.client?.forwardRpc) throw new Error('连接暂不可用，请连接原 Mac 后重试群聊。')
    if (!sourceMatches()) throw new Error('群聊的原连接已变化，请返回后重新打开。')
    const runtime = observed.client.runtimeOwnerIdentity?.()
    const fence = runtime?.ownerInstanceId ? { runtimeId: runtime.runtimeId, ownerInstanceId: runtime.ownerInstanceId } : undefined
    const result = await observed.client.forwardRpc(method, input, {}, fence)
    if (observed.client !== current.current.client || !sourceMatches()) throw new Error('群聊请求的原连接已变化，本次结果待核对。')
    if (method === 'space.mote.group.list') setListConfirmed(true)
    return result
  }, [sourceMatches])
  const groups = useMoteGroups(call, { enabled: view === null, ...(moteId ? { moteId } : {}) })
  const creating = view === 'create'
  useEffect(() => {
    if (!creating || !connected || !client?.forwardRpc || !sourceMatches()) return
    const controller = new AbortController()
    void client.forwardRpc('space.ls', { target: {}, presentation: true }, { signal: controller.signal }).then(({ catalog }) => {
      if (controller.signal.aborted || !sourceMatches()) return
      const spaces = new Map(catalog.spaces.filter(space => space.kind === 'mote').map(space => [space.spaceId, space]))
      const values = catalog.motePresentation?.flatMap(fact => {
        const space = spaces.get(fact.spaceId), content = fact.content
        return space && content ? [{ name: space.name, target: { spaceId: space.spaceId, zoneId: content.zoneId,
          expectedResource: { hostId: content.hostId, workspaceId: content.workspaceId, workspacePath: content.workspacePath } } }] : []
      }) ?? []
      setCandidates({ values, error: null })
    }).catch(error => {
      if (!controller.signal.aborted) setCandidates(previous => ({ ...previous, error: error instanceof Error ? error.message : String(error) }))
    })
    return () => controller.abort()
  }, [candidateRevision, client, connected, creating, sourceMatches])

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
    {creating && candidates.error ? <Notice tone="warning" density="compact" messageRole="status"
      actions={<Button type="button" onClick={() => setCandidateRevision(value => value + 1)}>重读 Mote</Button>}>{candidates.error}</Notice> : null}
    {draftNotice ? <Notice tone="warning" density="compact" messageRole="status">{draftNotice}</Notice> : null}
    <MoteGroupConversation call={call} candidates={candidates.values} groupId={groupId} creating={creating}
      {...(moteId ? { initialMoteId: moteId } : {})} initialMembers={view !== 'create' && view.members}
      onOpen={groupId => setView({ groupId, members: false })} onClose={() => setView(null)} positions={positions} {...custody}
      renderThread={thread => <MobileMoteGroupThread client={connected && sourceMatches() ? client : null} thread={thread} />} />
  </div>
  return <section className="mobile-mote-groups" aria-label={moteId ? 'Mote 的群聊' : '群聊列表'}>
    {!moteId && <Button type="button" onClick={() => setView('create')}><SemanticIcon name="action.add-item" size={16} />{custody.creation.read() ? '继续创建群聊' : '创建群聊'}</Button>}
    {groups.error && <Notice tone="warning" density="compact" messageRole="status"
      actions={<Button type="button" onClick={groups.refresh}>重读群聊</Button>}>{groups.error}</Notice>}
    {!groups.groups.length && !groups.error && <p role="status">{!listConfirmed || groups.loading ? '正在读取群聊…' : '暂无群聊'}</p>}
    {groups.groups.length > 0 && <ul className="mobile-mote-groups__list">{groups.groups.map(group => <li key={group.id}>
      <IconButton type="button" title={`${group.name} · 群资料`} aria-label={`查看 ${group.name} 的群资料`} className="mobile-mote-groups__avatar"
        onClick={() => setView({ groupId: group.id, members: true })}><SemanticIcon name="object.conversations" size={19} /></IconButton>
      <button type="button" className="mobile-mote-groups__row" onClick={() => setView({ groupId: group.id, members: false })}>
        <strong>{group.name}</strong><small>{group.lastMessage?.body ?? '暂无消息'}</small>
      </button>
    </li>)}</ul>}
    {groups.hasMore && <Button type="button" disabled={groups.loading} onClick={groups.loadMore}>更多群聊</Button>}
  </section>
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
