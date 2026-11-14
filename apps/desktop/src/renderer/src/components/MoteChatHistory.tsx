import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConnectionActor } from '@agentmux/core/connections'
import type { MoteChatGeneration, MoteChatPerson, MoteChatTarget } from '@agentmux/core/mote-chat'
import { useConversationView } from '@agentmux/client-ui/use-conversation-view'
import { describeConversationWindow } from '@agentmux/client-ui/conversation-records'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { InputMailboxRecords } from '@agentmux/client-ui/components/InputMailboxRecords'
import { useAgentInputMailbox } from '@agentmux/client-ui/use-agent-input-mailbox'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { OriginalInputWaitingControl } from './OriginalInputWaitingControl'
import { ConnectorEntityIdentity } from './ConnectorEntityIdentity'

const LoadingIcon = semanticIconComponent('status.loading')
const FocusIcon = semanticIconComponent('navigation.focus')

/** Original Mote generations, optionally scoped to one person. Reading never creates or resumes a Session. */
export function MoteChatHistory({ target, actor, people = [], hostingTarget, active }: {
  target: MoteChatTarget; actor?: ConnectionActor; people?: readonly MoteChatPerson[]; hostingTarget: ConnectionHostingTarget; active: boolean
}) {
  const [generations, setGenerations] = useState<MoteChatGeneration[]>([]), [next, setNext] = useState<string | null>(null)
  const [reading, setReading] = useState(false), [issue, setIssue] = useState(''), [selected, setSelected] = useState<string | null>(null)
  const lifetime = useRef(0)
  const read = useCallback(async (cursor?: string) => {
    const epoch = ++lifetime.current
    setReading(true); setIssue('')
    try {
      const page = await api.moteChat.call('space.mote.chat.history', { target, ...(actor ? { actor } : {}), ...(cursor ? { cursor } : {}), limit: 3 }, hostingTarget)
      if (lifetime.current !== epoch) return
      setGenerations(current => cursor ? [...current, ...page.generations.filter(row => !current.some(old => old.generationId === row.generationId))]
        : [...page.generations, ...current.filter(row => !page.generations.some(updated => updated.generationId === row.generationId))])
      setNext(page.next)
    } catch (error) { if (lifetime.current === epoch) setIssue(presentError(error)) }
    finally { if (lifetime.current === epoch) setReading(false) }
  }, [target, actor, hostingTarget])
  useEffect(() => { if (active) void read(); return () => { lifetime.current++ } }, [active, read])
  return <section className="mote-chat-history" aria-label="Private conversations" aria-busy={reading}>
    <p className="mote-details__hint">原私聊按创建顺序从新到旧排列，可直接阅读输入和回复。</p>
    <ol>{generations.map(generation => <li key={generation.generationId} data-mote-chat-generation={generation.generationId}>
      <div className="mote-chat-history__row"><div>
        {!actor ? <ConnectorEntityIdentity compact identityKey={JSON.stringify(generation.actor)} kind="person" name={people.find(person => JSON.stringify(person.actor) === JSON.stringify(generation.actor))?.name} missingName={generation.actor.userId} secondary={<span>{generation.application.domain} · 私聊</span>} /> : null}
        <strong>Last active <time dateTime={new Date(generation.lastActivityAt).toISOString()}>{new Date(generation.lastActivityAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></strong>
        {generation.phase === 'preparing' ? <small>Preparing conversation</small> : null}</div>
        <div className="mote-chat-actions"><button type="button" className="small-button" aria-expanded={selected === generation.generationId} onClick={() => setSelected(current => current === generation.generationId ? null : generation.generationId)}>{selected === generation.generationId ? 'Hide messages' : 'View messages'}</button>
          <button type="button" className="icon-button" title="Locate in Focus" aria-label={`Locate Agent ${generation.agentSessionId} in Focus`} onClick={() => useAppStore.getState().revealFocusAgent({ hostId: generation.executionHostId, agentSessionId: generation.agentSessionId })}><FocusIcon size={13} /></button></div>
      </div>
      <div hidden={selected !== generation.generationId}><MotePrivateConversation generation={generation} active={active && selected === generation.generationId} /></div>
    </li>)}</ol>
    {reading ? <p className="mote-private-chat__activity" role="status"><LoadingIcon size={13} animation="spin" />Reading conversations…</p> : !generations.length && !issue ? <p className="mote-details__hint">{actor ? '还没有这个人的原私聊记录。' : '还没有读取到这个 Mote 的原独立私聊记录。'}</p> : null}
    {issue ? <p role="status" className="mote-details__issue">{generations.length ? 'Previously read conversations are kept. ' : ''}{issue}</p> : null}
    <div className="mote-chat-actions"><button type="button" className="small-button" disabled={reading} onClick={() => void read()}>Refresh conversations</button>{next ? <button type="button" className="small-button" disabled={reading} onClick={() => void read(next)}>Earlier conversations</button> : null}</div>
  </section>
}

function MotePrivateConversation({ generation, active }: { generation: MoteChatGeneration; active: boolean }) {
  const reference = useMemo(() => ({ hostId: generation.executionHostId, agentSessionId: generation.agentSessionId }), [generation.executionHostId, generation.agentSessionId])
  const view = useConversationView(api.conversation, reference, active, { identity: 'mote-private:' + generation.generationId })
  const reading = useMemo(() => view.reading ? describeConversationWindow(view.reading) : null, [view.reading])
  const [receiptsOpen, setReceiptsOpen] = useState(false)
  return <section className="mote-private-conversation" aria-label="Original private conversation">
    {view.error || view.observationError ? <p role="status" className="mote-conversation__issue">{(view.error ?? view.observationError)?.message} 原对话与已读内容保留。</p> : null}
    {reading ? <ConversationView sessionId={reference.agentSessionId} executionHostId={reference.hostId} records={reading.records} originalRecords={reading.originalRecords}
      page={reading.historyPage ?? null} coverage={reading.timeline.coverage} active={active} readProcessDetail={view.readProcessDetail} detailsOnlyMetadata sourceLabelsInDetails />
      : <p className="mote-conversation__muted">{view.loading ? '读取原对话…' : view.error ? '原来源暂不可读，可重读同一会话。' : '此读取范围尚无对话记录。'}</p>}
    <div className="mote-chat-actions">{view.hasMore ? <button type="button" className="small-button" disabled={view.loading} onClick={() => void view.earlier()}>更早的消息</button> : null}
      <button type="button" className="small-button" disabled={view.loading} onClick={() => void view.refresh()}>重读原对话</button></div>
    <details><summary>原会话来源</summary><code>{generation.executionHostId} / {generation.agentSessionId}</code></details>
    <details onToggle={event => setReceiptsOpen(event.currentTarget.open)}><summary>输入回执</summary><MoteChatInputs generation={generation} active={active && receiptsOpen} /></details>
  </section>
}

function MoteChatInputs({ generation, active }: { generation: MoteChatGeneration; active: boolean }) {
  const { executionHostId: hostId, agentSessionId } = generation
  const read = useCallback<Parameters<typeof useAgentInputMailbox>[0]['read']>(input => api.sessions.inputMailbox({ hostId, agentSessionId }, input), [hostId, agentSessionId])
  const mailbox = useAgentInputMailbox({ hostId, agentSessionId, enabled: active, read })
  return <section className="mote-chat-inputs" aria-label="Received private messages"><header><strong>Received messages</strong><small>Original inputs and receipts · Agent replies are in the original conversation.</small></header><InputMailboxRecords mailbox={mailbox} hostId={hostId} compact renderRelated={item => item.kind === 'controlled' && item.receipt ? <OriginalInputWaitingControl hostId={hostId} receipt={item.receipt} onRefresh={mailbox.refresh} /> : null} /></section>
}
