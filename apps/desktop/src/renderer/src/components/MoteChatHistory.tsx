import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionActor } from '@agentmux/core/connections'
import type { MoteChatGeneration, MoteChatPerson, MoteChatTarget } from '@agentmux/core/mote-chat'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { Button } from '@agentmux/client-ui/components/Button'
import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { MoteConversationBrowser } from './MoteConversationBrowser'
import { MoteSessionConversation } from './MoteSessionConversation'
import type { MoteThreadCount } from './MoteThreadNavigation'

const LoadingIcon = semanticIconComponent('status.loading')
const PersonIcon = semanticIconComponent('object.user')

/** Original generations. Selection reads the exact source without creating or resuming it. */
export function MoteChatHistory({ target, actor, people = [], hostingTarget, active, observe = active, onCount }: {
  target: MoteChatTarget; actor?: ConnectionActor; people?: readonly MoteChatPerson[]; hostingTarget: ConnectionHostingTarget; active: boolean
  observe?: boolean; onCount?: ((count: MoteThreadCount) => void) | undefined
}) {
  const [generations, setGenerations] = useState<MoteChatGeneration[]>([]), [next, setNext] = useState<string | null>(null)
  const [reading, setReading] = useState(false), [issue, setIssue] = useState('')
  const lifetime = useRef(0)
  const [confirmed, setConfirmed] = useState(false)
  const read = useCallback(async (cursor?: string) => {
    const epoch = ++lifetime.current
    setReading(true); setIssue('')
    try {
      const page = await api.moteChat.call('space.mote.chat.history', { target, ...(actor ? { actor } : {}), ...(cursor ? { cursor } : {}), limit: 3 }, hostingTarget)
      if (lifetime.current !== epoch) return
      setGenerations(current => {
        const unique = new Map<string, MoteChatGeneration>()
        for (const row of cursor ? [...current, ...page.generations] : [...page.generations, ...current]) if (!unique.has(row.generationId)) unique.set(row.generationId, row)
        return [...unique.values()]
      })
      setNext(page.next); setConfirmed(true)
    } catch (error) { if (lifetime.current === epoch) setIssue(presentError(error)) }
    finally { if (lifetime.current === epoch) setReading(false) }
  }, [target, actor, hostingTarget])
  useEffect(() => { if (observe) void read(); return () => { lifetime.current++ } }, [observe, read])
  useEffect(() => { onCount?.({ value: confirmed ? generations.length : null, more: Boolean(next), unavailable: Boolean(issue) }) }, [confirmed, generations.length, next, issue, onCount])
  const choices = generations.map(generation => {
    const name = people.find(person => JSON.stringify(person.actor) === JSON.stringify(generation.actor))?.name ?? generation.actor.userId
    const at = new Date(generation.lastActivityAt)
    const time = at.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    return { id: generation.generationId, title: name + ' · ' + time,
      row: <span className="mote-conversation-browser__row" data-mote-chat-generation={generation.generationId}><PersonIcon size={22} /><span>
        <strong>{name}</strong><small>{generation.application.domain} · <time dateTime={at.toISOString()}>{time}</time></small>
        {generation.phase === 'preparing' ? <small>正在准备原对话</small> : null}</span></span>,
      actions: <Button type="button" onClick={() => useAppStore.getState().revealFocusAgent({ hostId: generation.executionHostId, agentSessionId: generation.agentSessionId })}>在 Focus 打开</Button>,
      conversation: (visible: boolean) => <MoteSessionConversation hostId={generation.executionHostId} agentSessionId={generation.agentSessionId} identity={'mote-private:' + generation.generationId} active={visible} /> }
  })
  return <section className="mote-chat-history" aria-label="Private conversations" aria-busy={reading}>
    <MoteConversationBrowser choices={choices} active={active}
      heading={<p className="mote-details__hint">原私聊 · 创建时间从新到旧</p>}
      empty={!reading && !issue ? <p className="mote-details__hint">{actor ? '还没有这个人的原私聊记录。' : '还没有读取到这个 Mote 的原独立私聊记录。'}</p> : null}
      footer={<>
        {reading ? <p className="mote-private-chat__activity" role="status"><LoadingIcon size={13} animation="spin" />读取私聊…</p> : null}
        {issue ? <p role="status" className="mote-details__issue">{generations.length ? '已读原对话保留。' : ''}{issue}</p> : null}
        <div className="mote-chat-actions"><Button type="button" disabled={reading} onClick={() => void read()}>Refresh conversations</Button>{next ? <Button type="button" disabled={reading} onClick={() => void read(next)}>Earlier conversations</Button> : null}</div>
      </>} />
  </section>
}
