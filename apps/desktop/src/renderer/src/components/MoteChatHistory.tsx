import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionActor } from '@agentmux/core/connections'
import type { MoteChatGeneration, MoteChatTarget } from '@agentmux/core/mote-chat'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { InputMailboxRecords } from '@agentmux/client-ui/components/InputMailboxRecords'
import { useAgentInputMailbox } from '@agentmux/client-ui/use-agent-input-mailbox'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { OriginalInputWaitingControl } from './OriginalInputWaitingControl'

const LoadingIcon = semanticIconComponent('status.loading')
const OpenIcon = semanticIconComponent('action.open-external')

/** One requested person's original generations. No session creation, selection or recovery owner. */
export function MoteChatHistory({ target, actor, hostingTarget, active }: {
  target: MoteChatTarget; actor: ConnectionActor; hostingTarget: ConnectionHostingTarget; active: boolean
}) {
  const [generations, setGenerations] = useState<MoteChatGeneration[]>([]), [next, setNext] = useState<string | null>(null)
  const [reading, setReading] = useState(false), [issue, setIssue] = useState(''), [selected, setSelected] = useState<string | null>(null)
  const lifetime = useRef(0)
  const read = useCallback(async (cursor?: string) => {
    const epoch = ++lifetime.current
    setReading(true); setIssue('')
    try {
      const page = await api.moteChat.call('space.mote.chat.history', { target, actor, ...(cursor ? { cursor } : {}), limit: 3 }, hostingTarget)
      if (lifetime.current !== epoch) return
      setGenerations(current => cursor ? [...current, ...page.generations.filter(row => !current.some(old => old.generationId === row.generationId))]
        : [...page.generations, ...current.filter(row => !page.generations.some(updated => updated.generationId === row.generationId))])
      setNext(page.next)
    } catch (error) { if (lifetime.current === epoch) setIssue(presentError(error)) }
    finally { if (lifetime.current === epoch) setReading(false) }
  }, [target, actor, hostingTarget])
  useEffect(() => { if (active) void read(); return () => { lifetime.current++ } }, [active, read])
  return <section className="mote-chat-history" aria-label="Private conversations" aria-busy={reading}>
    <p className="mote-details__hint">Recent conversations, newest first. Read received messages here or locate the original Agent.</p>
    <ol>{generations.map(generation => <li key={generation.generationId} data-mote-chat-generation={generation.generationId}>
      <div className="mote-chat-history__row"><div><strong>Last active <time dateTime={new Date(generation.lastActivityAt).toISOString()}>{new Date(generation.lastActivityAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></strong>
        <span title={generation.agentSessionId}>{generation.executionHostId} · {generation.agentSessionId}</span>
        {generation.phase === 'preparing' ? <small>Preparing conversation</small> : null}</div>
        <div className="mote-chat-actions"><button type="button" className="small-button" aria-expanded={selected === generation.generationId} onClick={() => setSelected(current => current === generation.generationId ? null : generation.generationId)}>{selected === generation.generationId ? 'Hide messages' : 'View messages'}</button>
          <button type="button" className="icon-button" title="Locate in Focus" aria-label={`Locate Agent ${generation.agentSessionId} in Focus`} onClick={() => useAppStore.getState().revealFocusAgent({ hostId: generation.executionHostId, agentSessionId: generation.agentSessionId })}><OpenIcon size={13} /></button></div>
      </div>
      {selected === generation.generationId ? <MoteChatInputs generation={generation} active={active} /> : null}
    </li>)}</ol>
    {reading ? <p className="mote-private-chat__activity" role="status"><LoadingIcon size={13} animation="spin" />Reading conversations…</p> : !generations.length && !issue ? <p className="mote-details__hint">No recorded conversations for this person yet.</p> : null}
    {issue ? <p role="status" className="mote-details__issue">{generations.length ? 'Previously read conversations are kept. ' : ''}{issue}</p> : null}
    <div className="mote-chat-actions"><button type="button" className="small-button" disabled={reading} onClick={() => void read()}>Refresh conversations</button>{next ? <button type="button" className="small-button" disabled={reading} onClick={() => void read(next)}>Earlier conversations</button> : null}</div>
  </section>
}

function MoteChatInputs({ generation, active }: { generation: MoteChatGeneration; active: boolean }) {
  const { executionHostId: hostId, agentSessionId } = generation
  const read = useCallback<Parameters<typeof useAgentInputMailbox>[0]['read']>(input => api.sessions.inputMailbox({ hostId, agentSessionId }, input), [hostId, agentSessionId])
  const mailbox = useAgentInputMailbox({ hostId, agentSessionId, enabled: active, read })
  return <section className="mote-chat-inputs" aria-label="Received private messages"><header><strong>Received messages</strong><small>Original inputs and receipts · Agent replies are in the original conversation.</small></header><InputMailboxRecords mailbox={mailbox} hostId={hostId} compact renderRelated={item => item.kind === 'controlled' && item.receipt ? <OriginalInputWaitingControl hostId={hostId} receipt={item.receipt} onRefresh={mailbox.refresh} /> : null} /></section>
}
