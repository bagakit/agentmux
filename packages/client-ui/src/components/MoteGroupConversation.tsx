import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { AgentMuxRpcParams, AgentMuxRpcResult } from '@agentmux/core'
import { MOTE_GROUP_MAX_BODY_LENGTH, type MoteGroupMember, type MoteGroupMessage, type MoteGroupMethod, type MoteGroupSummary } from '@agentmux/core/mote/group'
import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import { mintObjectId } from '@agentmux/core/object-id'
import { Button } from './Button.js'
import { IconButton } from './IconButton.js'
import { SearchInput } from '../input/SearchInput.js'
import { Notice } from './Notice.js'
import { MoteAssignmentButton } from './MoteAssignment.js'
import { MoteGroupAvatar, MoteGroupDetails, MoteGroupSettingsFields, type MoteGroupSettingsValue } from './MoteGroupSettings.js'
export { MoteGroupAvatar } from './MoteGroupSettings.js'
import { SemanticIcon } from '../theme/semantic-icon.js'
import '../styles/mote-group.css'

type ClientMethod = Exclude<MoteGroupMethod, 'space.mote.group.reply'>
export type MoteGroupCall = <M extends ClientMethod>(method: M, input: AgentMuxRpcParams<M>) => Promise<AgentMuxRpcResult<M>>
export type MoteGroupCandidate = { target: MotePreferencesTarget; name: string }
export type MoteGroupDraft = { body: string; recipientIds: string[]; operationId?: string; replyToMessageId?: string }
export type MoteGroupReadingPositions = Map<string, { top: number; atTail: boolean }>
export type MoteGroupCreation = AgentMuxRpcParams<'space.mote.group.create'>
type DraftOwner = {
  read(groupId: string): MoteGroupDraft | null
  write(groupId: string, draft: MoteGroupDraft): void | Promise<void>
  clear?(groupId: string, operationId: string): void | Promise<void>
}
type CreationOwner = {
  read(): MoteGroupCreation | null
  write(input: MoteGroupCreation): void | Promise<void>
  clear(operationId: string): void | Promise<void>
}
type Props = {
  call: MoteGroupCall
  candidates: readonly MoteGroupCandidate[]
  topicCandidates?: readonly MoteGroupCandidate[]
  renderMoteAvatar?(moteId: string, name: string): ReactNode
  onOpenTopicFiles?(target: MotePreferencesTarget): void
  groupId: string | null
  creating?: boolean
  initialMoteId?: string
  initialMembers?: boolean
  onOpen(groupId: string): void
  onChanged?(): void
  onPerspectiveChange?(moteId: string | undefined): void
  onClose(): void
  onCreate?(): void
  draft?: DraftOwner
  creation?: CreationOwner
  positions?: MoteGroupReadingPositions
  renderThread?(thread: NonNullable<MoteGroupMember['thread']>): ReactNode
}

const EMPTY_DRAFT: MoteGroupDraft = { body: '', recipientIds: [] }
const STATUS = { pending: '等待接收', accepted: '已接收', failed: '投递失败', unknown: '待核对' } as const
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

export function useMoteGroups(call: MoteGroupCall, { enabled = true, moteId }: { enabled?: boolean; moteId?: string } = {}) {
  const [page, setPage] = useState<{ key: string | undefined; groups: MoteGroupSummary[]; next: number | null }>({ key: moteId, groups: [], next: null })
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const version = useRef(0)
  const inFlight = useRef(false)
  const read = useCallback(async (cursor?: number, quiet = false) => {
    if (!enabled || inFlight.current && (quiet || cursor === undefined)) return
    inFlight.current = true
    const current = ++version.current
    if (!quiet) setLoading(true)
    try {
      const result = await call('space.mote.group.list', { ...(moteId ? { moteId } : {}), ...(cursor === undefined ? {} : { beforeSequence: cursor }), limit: 30 })
      if (current !== version.current) return
      setPage(previous => {
        if (cursor !== undefined && previous.key === moteId) return { key: moteId, groups: [...new Map([...previous.groups, ...result.groups].map(group => [group.id, group])).values()], next: result.nextBeforeSequence }
        if (previous.key === moteId && previous.groups.length > result.groups.length) {
          const visible = new Set(result.groups.map(group => group.id))
          return { key: moteId, groups: [...result.groups, ...previous.groups.filter(group => !visible.has(group.id))], next: previous.next }
        }
        return { key: moteId, groups: result.groups, next: result.nextBeforeSequence }
      })
      setError(null)
    } catch (issue) {
      if (current === version.current) setError(errorText(issue))
    } finally {
      if (current === version.current) { inFlight.current = false; setLoading(false) }
    }
  }, [call, enabled, moteId])
  useEffect(() => {
    void read()
    const timer = enabled ? setInterval(() => void read(undefined, true), 5000) : undefined
    return () => { ++version.current; inFlight.current = false; clearInterval(timer) }
  }, [enabled, read])
  const refresh = useCallback(() => { void read() }, [read])
  const loadMore = useCallback(() => {
    if (page.key === moteId && page.next !== null) void read(page.next)
  }, [read, moteId, page])
  return { groups: page.key === moteId ? page.groups : [], error, loading, refresh, loadMore, hasMore: page.key === moteId && page.next !== null }
}

export function MoteGroupConversation(props: Props) {
  if (props.creating) return <GroupCreate {...props} />
  if (props.groupId) return <GroupView key={props.groupId} {...props} groupId={props.groupId} />
  return <section className="mote-group mote-group--empty">
    <SemanticIcon name="object.team" size={28} />
    <h2>群聊</h2>
    {props.onCreate ? <Button onClick={props.onCreate}>创建群聊</Button> : null}
  </section>
}

function GroupCreate({ call, candidates, topicCandidates = [], renderMoteAvatar, onOpen, onChanged, onClose, creation }: Props) {
  const [saved] = useState(() => creation?.read() ?? null)
  const [name, setName] = useState(saved?.name ?? '')
  const [selected, setSelected] = useState<MoteGroupCandidate[]>(() => (saved?.members ?? []).map(target => ({
    target, name: candidates.find(candidate => candidate.target.spaceId === target.spaceId)?.name ?? '待识别的 Mote'
  })))
  const [query, setQuery] = useState('')
  const [setup, setSetup] = useState<MoteGroupSettingsValue>(() => ({
    avatarMoteIds: saved?.avatarMoteIds ?? [], announcement: saved?.announcement ?? '', topic: saved?.topic ?? null
  }))
  const [issue, setIssue] = useState<string | null>(null)
  const attempted = useRef(saved)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const submitting = useRef(false)
  const [pending, setPending] = useState(false)
  const locked = attempted.current !== null
  const needle = query.trim().toLocaleLowerCase()
  const matching = candidates.filter(candidate => candidate.name.toLocaleLowerCase().includes(needle))
  const members = selected.map(({ target, name }) => ({
    moteId: target.spaceId,
    name: candidates.find(candidate => candidate.target.spaceId === target.spaceId)?.name ?? name
  }))
  const groupName = name.trim() || '未命名群聊'
  function remove(id: string) {
    setSelected(current => current.filter(member => member.target.spaceId !== id))
    setSetup(current => ({ ...current, avatarMoteIds: current.avatarMoteIds.filter(member => member !== id) }))
  }
  async function create(event: FormEvent) {
    event.preventDefault()
    if (submitting.current) return
    const selectedAvatars = setup.avatarMoteIds.filter(id => members.some(member => member.moteId === id))
    const input = attempted.current ?? {
      operationId: mintObjectId(), name: name.trim(),
      members: selected.map(member => member.target),
      ...(selectedAvatars.length ? { avatarMoteIds: selectedAvatars } : {}),
      ...(setup.announcement.trim() ? { announcement: setup.announcement.trim() } : {}),
      ...(setup.topic ? { topic: setup.topic } : {})
    }
    if (!input.name || input.members.length === 0) return
    attempted.current = input
    submitting.current = true
    setPending(true)
    try {
      await creation?.write(input)
      const receipt = await call('space.mote.group.create', input)
      onChanged?.()
      await creation?.clear(input.operationId)
      if (mounted.current) onOpen(receipt.group.id)
    } catch (error) { setIssue(errorText(error)) }
    finally { submitting.current = false; setPending(false) }
  }
  return <section className="mote-group mote-group--create" aria-label="创建群聊">
    <header className="mote-group__header"><h2>创建群聊</h2><Button type="button" onClick={onClose}>返回</Button></header>
    <form className="mote-group__create" onSubmit={create} aria-busy={pending}>
      <div className="mote-group__create-body">
        <fieldset className="mote-group__people">
          <legend>选择成员</legend>
          <SearchInput aria-label="搜索 Mote" clearLabel="清空成员搜索" placeholder="搜索 Mote" value={query} onValueChange={setQuery}
            onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }} />
          {matching.length ? <div className="mote-group__candidate-list">{matching.map(candidate => {
            const id = candidate.target.spaceId
            const checked = members.some(member => member.moteId === id)
            return <label key={id} className="mote-group__candidate">
              <span className="mote-group__avatar" aria-hidden="true">{renderMoteAvatar?.(id, candidate.name) ?? initial(candidate.name)}</span>
              <strong>{candidate.name}</strong>
              <input type="checkbox" checked={checked} disabled={locked} onChange={event => {
                if (event.target.checked) setSelected(current => [...current, candidate])
                else remove(id)
              }} />
            </label>
          })}</div> : <p className="mote-group__picker-status" role="status">{needle ? '没有匹配的 Mote' : '暂未读到可选成员'}</p>}
        </fieldset>
        <section className="mote-group__create-draft" aria-label="群资料预览">
          <div className="mote-group__create-preview">
            <MoteGroupAvatar memberIds={setup.avatarMoteIds} members={members} renderMoteAvatar={renderMoteAvatar} />
            <div><strong>{groupName}</strong></div>
          </div>
          {members.length > 0 && <ul className="mote-group__selected" aria-label="已选成员">{members.map(member => <li key={member.moteId}>
            <span className="mote-group__avatar" aria-hidden="true">{renderMoteAvatar?.(member.moteId, member.name) ?? initial(member.name)}</span>
            <span>{member.name}</span>
            <IconButton type="button" aria-label={`移除 ${member.name}`} disabled={locked} onClick={() => remove(member.moteId)}><SemanticIcon name="action.close" size={12} /></IconButton>
          </li>)}</ul>}
          <label className="mote-group__field">群名称<input value={name} maxLength={120} placeholder="输入群名称" disabled={locked} onChange={event => setName(event.target.value)} /></label>
          <details className="mote-group-settings__create">
            <summary>头像、公告与群文件</summary>
            <MoteGroupSettingsFields value={setup} disabled={locked} members={members}
              topicCandidates={topicCandidates} renderMoteAvatar={renderMoteAvatar} onChange={setSetup} />
          </details>
        </section>
      </div>
      {issue ? <Notice tone="warning" density="compact" heading="建群请求待核对" messageRole="status">{issue}</Notice> : null}
      <div className="mote-group__create-actions">
        <output className="mote-group__muted">已选 {members.length} 位成员</output>
        <Button type="submit" variant="primary" disabled={pending || !name.trim() || selected.length === 0}>{pending ? '正在创建…' : locked ? '核对原建群请求' : '创建群聊'}</Button>
      </div>
    </form>
  </section>
}

function initial(name: string) { return Array.from(name.trim())[0] ?? '·' }
function time(date: string | number) {
  return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
function bySequence(messages: MoteGroupMessage[]) {
  return [...new Map(messages.map(message => [message.id, message])).values()].sort((left, right) => left.sequence - right.sequence)
}

function GroupView({ call, groupId, initialMoteId, initialMembers, onChanged, onClose, onPerspectiveChange, draft, renderThread, positions, candidates, topicCandidates = [], renderMoteAvatar, onOpenTopicFiles }: Props & { groupId: string }) {
  const [group, setGroup] = useState<MoteGroupSummary | null>(null)
  const [messages, setMessages] = useState<MoteGroupMessage[]>([])
  const [viewerId, setViewerId] = useState<string>()
  const [newerAvailable, setNewerAvailable] = useState(false)
  const [cursor, setCursor] = useState<number | null>(null)
  const [moteId, setMoteId] = useState(initialMoteId)
  const [membersOpen, setMembersOpen] = useState(initialMembers ?? false)
  const [value, setValue] = useState(() => draft?.read(groupId) ?? EMPTY_DRAFT)
  const [issue, setIssue] = useState<string | null>(null)
  const [sendIssue, setSendIssue] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [retrying, setRetrying] = useState<string | null>(null)
  const sendingRef = useRef(false)
  const observing = useRef(0)
  const reading = useRef<number | null>(null)
  const loaded = useRef(false)
  const latestSequence = useRef<number | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const localPositions = useRef<MoteGroupReadingPositions>(new Map())
  const readingPositions = positions ?? localPositions.current
  const positionKey = JSON.stringify([groupId, moteId])
  const keepTail = useRef(readingPositions.get(positionKey)?.atTail ?? true)
  const readingView = useRef<string | undefined>(undefined)
  const focusMessage = useRef<string | null>(null)
  const member = group?.members.find(item => item.moteId === moteId)
  const activeMembers = group?.members.filter(item => (item.state ?? 'active') === 'active') ?? []
  const visibleMessages = moteId ? messages.filter(message => message.deliveries.some(delivery => delivery.moteId === moteId) || (message.author.kind === 'mote' && message.author.moteId === moteId)) : messages

  const read = useCallback(async (beforeSequence?: number, quiet = false, replace = false) => {
    if (quiet && reading.current !== null) return
    const request = ++observing.current
    reading.current = request
    if (!quiet) setLoading(true)
    const height = list.current?.scrollHeight ?? 0
    try {
      const result = await call('space.mote.group.inspect', { groupId, limit: 60, ...(beforeSequence === undefined ? {} : { beforeSequence }) })
      if (request !== observing.current) return
      setGroup(result.group)
      setViewerId(result.viewerId)
      const first = result.messages[0]?.sequence
      if (!replace && beforeSequence === undefined && first !== undefined && latestSequence.current !== null && first > latestSequence.current) {
        setNewerAvailable(true)
      } else {
        const last = result.messages.at(-1)?.sequence
        if (beforeSequence === undefined && last !== undefined) latestSequence.current = last
        setMessages(previous => bySequence(replace ? result.messages : [...previous, ...result.messages]))
        if (!loaded.current || beforeSequence !== undefined || replace) setCursor(result.nextBeforeSequence)
        if (beforeSequence === undefined) setNewerAvailable(false)
      }
      loaded.current = true
      setIssue(null)
      if (beforeSequence !== undefined) {
        keepTail.current = false
        requestAnimationFrame(() => { if (list.current) list.current.scrollTop += list.current.scrollHeight - height })
      }
    } catch (error) { if (request === observing.current) setIssue(errorText(error)) }
    finally {
      if (reading.current === request) reading.current = null
      if (request === observing.current) setLoading(false)
    }
  }, [call, groupId])

  useEffect(() => {
    setMoteId(initialMoteId)
    setMembersOpen(Boolean(initialMembers))
  }, [initialMembers, initialMoteId])
  useEffect(() => {
    void read()
    const timer = setInterval(() => void read(undefined, true), 2500)
    return () => { ++observing.current; reading.current = null; clearInterval(timer) }
  }, [read])
  useEffect(() => {
    const viewport = list.current
    if (!viewport || !loaded.current || membersOpen) return
    if (readingView.current !== positionKey) {
      readingView.current = positionKey
      const saved = readingPositions.get(positionKey)
      keepTail.current = saved?.atTail ?? true
      viewport.scrollTop = keepTail.current ? viewport.scrollHeight : saved?.top ?? 0
    } else if (keepTail.current) viewport.scrollTop = viewport.scrollHeight
    if (!moteId && focusMessage.current) {
      const article = Array.from(viewport.querySelectorAll<HTMLElement>('[data-group-message-id]')).find(node => node.dataset.groupMessageId === focusMessage.current)
      focusMessage.current = null
      if (article) { keepTail.current = false; article.scrollIntoView({ block: 'nearest' }); article.focus({ preventScroll: true }) }
    }
  }, [messages, moteId, membersOpen, positionKey, readingPositions])

  async function change(next: MoteGroupDraft) {
    setValue(next)
    await draft?.write(groupId, next)
  }
  function edit(next: MoteGroupDraft) {
    void change(next).catch(error => setSendIssue(errorText(error)))
  }
  async function send(event: FormEvent) {
    event.preventDefault()
    if (sendingRef.current || !value.body.trim()) return
    const receiverIds = value.operationId ? value.recipientIds : value.recipientIds.filter(id => activeMembers.some(member => member.moteId === id))
    sendingRef.current = true
    setSending(true)
    setSendIssue(null)
    const exact = { ...value, recipientIds: receiverIds, operationId: value.operationId ?? mintObjectId() }
    try {
      await change(exact)
      const receipt = await call('space.mote.group.send', { groupId, ...exact })
      keepTail.current = true
      setMessages(previous => bySequence([...previous, receipt.message]))
      onChanged?.()
      if (draft?.clear) await draft.clear(groupId, exact.operationId)
      else if (draft?.read(groupId)?.operationId === exact.operationId) await draft.write(groupId, EMPTY_DRAFT)
      setValue(current => current.operationId === exact.operationId ? EMPTY_DRAFT : current)
      void read()
    } catch (error) { setSendIssue(errorText(error)) }
    finally { sendingRef.current = false; setSending(false) }
  }

  async function retry(messageId: string, memberId: string) {
    if (retrying) return
    setRetrying(memberId)
    setIssue(null)
    try {
      const { delivery } = await call('space.mote.group.retry', { groupId, messageId, memberId })
      setMessages(previous => previous.map(message => message.id === messageId
        ? { ...message, deliveries: message.deliveries.map(old => old.moteId === memberId ? delivery : old) } : message))
      void read()
    } catch (error) { setIssue(errorText(error)) }
    finally { setRetrying(null) }
  }

  function selectView(next: string | undefined) {
    if (list.current && !membersOpen) readingPositions.set(positionKey, { top: list.current.scrollTop, atTail: keepTail.current })
    setMembersOpen(false)
    setMoteId(next)
    onPerspectiveChange?.(next)
  }
  const locked = Boolean(value.operationId)
  const author = (message: MoteGroupMessage) => message.author.kind === 'system' ? '群公告' : message.author.kind === 'mote' ? message.author.name : message.author.id === viewerId ? '我' : '用户'
  return <section className="mote-group" aria-label={group?.name ?? '群聊'}>
    <header className="mote-group__header">
      <div className="mote-group__identity"><MoteGroupAvatar memberIds={group?.avatarMoteIds ?? []} members={group?.members ?? []} renderMoteAvatar={renderMoteAvatar} /><div><h2>{group?.name ?? '群聊'}</h2>
        {group ? <p>{member ? `正在查看 ${member.name} 的群内视角` : `${activeMembers.length} 位 Mote`}</p> : null}</div></div>
      <div className="mote-group__header-actions">
        {group?.topic && onOpenTopicFiles ? <Button onClick={() => onOpenTopicFiles(group.topic!)}>群文件</Button> : null}
        {group ? <Button aria-expanded={membersOpen} onClick={() => setMembersOpen(open => !open)}>群资料</Button> : null}
        <Button onClick={membersOpen ? () => setMembersOpen(false) : onClose}>返回</Button>
      </div>
    </header>
    {group ? <nav className="mote-group__views" aria-label="会话视角">
      <button type="button" aria-pressed={!moteId} onClick={() => selectView(undefined)}>群聊</button>
      {group.members.map(item => <button type="button" key={item.moteId} aria-pressed={item.moteId === moteId} onClick={() => selectView(item.moteId)}>{item.name}</button>)}
    </nav> : null}
    {membersOpen && group ? <MoteGroupDetails group={group} candidates={candidates} topicCandidates={topicCandidates} call={call}
      onReload={() => void read()} onUpdated={summary => { ++observing.current; setGroup(summary); onChanged?.(); void read() }}
      onPerspective={selectView} renderMoteAvatar={renderMoteAvatar} /> : null}
    {newerAvailable ? <Notice tone="info" density="compact" messageRole="status" actions={<Button onClick={() => {
      keepTail.current = true
      void read(undefined, false, true)
    }}>读取最新</Button>}>有新消息可读。</Notice> : null}
    {issue ? <Notice tone="warning" density="compact" messageRole="status" actions={<Button onClick={() => void read()}>重读</Button>}>{issue}</Notice> : null}
    <div className="mote-group__timeline" hidden={membersOpen} ref={list} onScroll={event => {
      const viewport = event.currentTarget
      keepTail.current = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 48
      readingPositions.set(positionKey, { top: viewport.scrollTop, atTail: keepTail.current })
    }} role="region" tabIndex={0} aria-label={moteId ? '群内消息' : '公开群聊记录'}>
      {cursor !== null ? <Button type="button" disabled={loading} onClick={() => void read(cursor)}>更早的消息</Button> : null}
      {!visibleMessages.length && !issue ? <div className="mote-group__empty">
        <h3>{!group ? '正在读取群聊' : member ? '尚无参与记录' : '开始群聊'}</h3>
        {group ? <p>{member ? `发给 ${member.name} 的消息和它在群里的回复会显示在这里。` : '你可以直接发言，也可以选择希望回答的 Mote。'}</p> : null}
      </div> : null}
      {visibleMessages.map(message => {
        if (message.author.kind === 'system') return <Notice key={message.id} className="mote-group__announcement" density="compact" heading="群公告已更新">
          {message.body}
        </Notice>
        const own = message.author.kind === 'human' && message.author.id === viewerId
        const reply = messages.find(earlier => earlier.id === message.replyToMessageId)
        const deliveries = moteId ? message.deliveries.filter(delivery => delivery.moteId === moteId) : message.deliveries
        return <article className="mote-group__message" data-own={own || undefined} data-group-message-id={message.id} tabIndex={-1} key={message.id}>
          <span className="mote-group__avatar" aria-hidden="true">{(message.author.kind === 'mote' ? renderMoteAvatar?.(message.author.moteId, message.author.name) : null) ?? initial(author(message))}</span>
          <div className="mote-group__message-content"><div className="mote-group__byline"><strong>{author(message)}</strong><time dateTime={new Date(message.createdAt).toISOString()}>{time(message.createdAt)}</time>
            {moteId && message.author.kind === 'mote' ? <button className="mote-group__quote-action" type="button" onClick={() => {
              focusMessage.current = message.id
              selectView(undefined)
            }}>群聊原文</button> : null}
            {!moteId && !locked ? <button className="mote-group__quote-action" type="button" aria-label={`回复 ${author(message)} 的消息`} onClick={() => edit({ ...value, replyToMessageId: message.id })}>回复</button> : null}</div>
            <div className="mote-group__bubble">
              {message.replyToMessageId ? <p className="mote-group__quote">{reply ? `${author(reply)} · ${reply.body}` : '回复一条较早的消息'}</p> : null}
              <div>{message.body}</div>
            </div>
            {deliveries.length ? <ul className="mote-group__receipts" aria-label="投递回执">{deliveries.map(delivery => <li key={delivery.moteId} data-status={delivery.status} title={delivery.issue}>
              <span>{group?.members.find(item => item.moteId === delivery.moteId)?.name ?? delivery.moteId} · {STATUS[delivery.status]}</span>
              {delivery.status !== 'accepted' ? <button type="button" disabled={retrying !== null} onClick={() => void retry(message.id, delivery.moteId)}>{delivery.status === 'failed' ? '重试' : '核对'}</button> : null}
            </li>)}</ul> : null}
            {!moteId && message.author.kind === 'mote' && message.deliveries.length > 0
              ? <MoteAssignmentButton target={{ kind: 'group', conversationId: groupId, messageId: message.id, read: call }} /> : null}
          </div>
        </article>
      })}
      {member?.thread && renderThread ? <ThreadDetails key={member.moteId} thread={member.thread} renderThread={renderThread} /> : null}
    </div>
    {group && !moteId && !membersOpen ? <form className="mote-group__composer" onSubmit={send}>
      {sendIssue || (locked && !sending) ? <Notice tone="warning" density="compact" heading="原发送结果待确认" messageRole="status">{sendIssue ?? '继续确认同一个发送请求。'}</Notice> : null}
      {value.replyToMessageId ? <div className="mote-group__quote-preview"><span>{messages.find(message => message.id === value.replyToMessageId)?.body ?? '回复原消息'}</span>
        <Button type="button" aria-label="取消引用" disabled={locked} onClick={() => edit({ body: value.body, recipientIds: value.recipientIds })}>取消</Button></div> : null}
      <div className="mote-group__recipients" role="group" aria-label="选择参与成员">
        <span>请谁参与</span>
        {activeMembers.map(item => {
          const selected = value.recipientIds.includes(item.moteId)
          return <button type="button" key={item.moteId} aria-pressed={selected} disabled={locked} onClick={() => edit({ ...value,
            recipientIds: selected ? value.recipientIds.filter(id => id !== item.moteId) : [...value.recipientIds, item.moteId] })}>{item.name}</button>
        })}
      </div>
      <div className="mote-group__send"><textarea aria-label="群消息" value={value.body} maxLength={MOTE_GROUP_MAX_BODY_LENGTH} rows={2} readOnly={locked} placeholder="以「我」发言…" onChange={event => edit({ ...value, body: event.target.value })} />
        <Button type="submit" variant="primary" disabled={sending || !value.body.trim()}>{sending ? '发送中…' : locked ? '确认发送' : '发送'}</Button>
      </div>
    </form> : null}
  </section>
}

function ThreadDetails({ thread, renderThread }: {
  thread: NonNullable<MoteGroupMember['thread']>; renderThread(thread: NonNullable<MoteGroupMember['thread']>): ReactNode
}) {
  const [open, setOpen] = useState(false)
  return <details className="mote-group__thread" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>原群内会话</summary>{open ? renderThread(thread) : null}
  </details>
}
