import { useEffect, useRef, useState } from 'react'
import type { MoteChatConfiguration, MoteChatPerson, MoteChatTarget } from '@agentmux/core/mote-chat'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { ConnectionHostingTarget } from '../../../shared/contracts'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import { moteConnectionTarget } from '../lib/mote-connection-default'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { MoteChatHistory } from './MoteChatHistory'

/** A reading entry over the original chat owner; no configuration or lifecycle writes. */
export function MotePrivateConversations({ scope, active }: { scope: MoteWorkfaceScope; active: boolean }) {
  const bindings = useAppStore(state => state.spaceZoneBindings)
  const target = moteConnectionTarget(scope, bindings)
  return target ? <PrivateConversations key={JSON.stringify(target)} target={target} active={active} />
    : <p role="status" className="mote-conversation__issue">原 Mote 位置尚未确认，无法读取它的私聊。原对话仍保留。</p>
}

function PrivateConversations({ target, active }: { target: MoteChatTarget; active: boolean }) {
  const selection = useAppStore(state => state.manualConnectionSelections.lark)
  const [source, setSource] = useState<{ owner: ConnectionHostingTarget; configuration: MoteChatConfiguration | null; people: MoteChatPerson[]; peopleIssue: string } | null>(null)
  const [issue, setIssue] = useState(''), [reading, setReading] = useState(false)
  const lifetime = useRef(0)
  async function read() {
    const epoch = ++lifetime.current
    setReading(true)
    try {
      if (selection === null) throw Error('原机器人托管 Host 尚未确认，请在 Profile 核对原连接器位置。已读对话仍保留。')
      const owner = selection ?? await api.connections.hostingTarget()
      const inspection = await api.moteChat.call('space.mote.chat.inspect', { target }, owner)
      const audience = inspection.configuration ? await api.moteChat.call('space.mote.chat.audience', { target, limit: 20 }, owner)
        .then(page => ({ people: page.people, issue: '' }), error => ({ people: null, issue: presentError(error) })) : { people: [], issue: '' }
      if (lifetime.current !== epoch) return
      setSource(previous => ({ owner, configuration: inspection.configuration, people: audience.people ?? (JSON.stringify(previous?.owner) === JSON.stringify(owner) ? previous!.people : []), peopleIssue: audience.issue })); setIssue('')
    } catch (error) { if (lifetime.current === epoch) setIssue(presentError(error)) }
    finally { if (lifetime.current === epoch) setReading(false) }
  }
  useEffect(() => { if (active) void read(); return () => { lifetime.current++ } }, [active, selection])
  return <section className="mote-private-conversations" aria-label="Mote private conversations" aria-busy={reading}>
    <header><p>原独立私聊记录。与你的 Mote 继续交流，请返回主对话。</p><button type="button" className="small-button" disabled={reading} onClick={() => void read()}>刷新私聊</button></header>
    {issue ? <p role="status" className="mote-conversation__issue">{issue}</p> : null}
    {source?.peopleIssue ? <p role="status" className="mote-conversation__muted">人物资料暂未确认，原对话仍可读取。{source.peopleIssue}</p> : null}
    {source ? <MoteChatHistory key={JSON.stringify([target, source.owner])} target={target} hostingTarget={source.owner} people={source.people} active={active} />
      : !issue ? <p className="mote-conversation__muted">{reading ? '读取原私聊位置…' : '选择私聊后读取原记录。'}</p> : null}
  </section>
}
