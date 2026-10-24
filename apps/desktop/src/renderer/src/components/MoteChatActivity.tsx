import { useCallback, useEffect, useRef, useState } from 'react'
import type { MoteChatDiagnosis, MoteChatDiagnosisIntake, MoteChatTarget } from '@agentmux/core/mote-chat'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { api } from '../lib/api'

const RefreshIcon = semanticIconComponent('action.refresh')
const ChatIcon = semanticIconComponent('object.conversation')

/** These labels explain the original bounded diagnosis; they never grant or retry an input. */
function intakeLabel(row: MoteChatDiagnosisIntake): { title: string; detail: string } {
  const input = row.input
  if (row.preparation === 'other-route') return { title: 'Another private-chat route', detail: 'This message belongs to a different saved Mote route.' }
  if (input.status === 'admitted') return { title: 'Agent received the message', detail: 'Input accepted. A reply is a separate result.' }
  if (input.status === 'terminal-confirmed') return { title: 'Sent to the terminal', detail: 'The Agent has not yet confirmed receiving this input.' }
  if (input.status === 'stopped') return { title: 'Waiting stopped', detail: 'The original message is kept.' }
  if (input.status === 'not-applied') return { title: 'Message was not accepted', detail: 'The original input receipt confirms it was not applied.' }
  if (input.status === 'unknown' || input.observation === 'unavailable') return { title: 'Delivery could not be checked', detail: 'The original message is kept. Open its conversation below to inspect the input.' }
  if (input.status === 'waiting') {
    const detail = input.preparationReason === 'context-compaction' ? 'The Agent is arranging its context.'
      : input.preparationReason === 'native-busy' ? 'The Agent is busy with its current input.'
        : input.failureCode === 'AGENT_INTERACTION_PENDING' ? 'The Agent has an unanswered question or permission request.'
          : input.failureCode === 'AGENT_PROMPT_SUBMISSION_BUSY' ? 'Another input is still being submitted.'
            : input.runtime?.target === 'original' && input.runtime.state === 'exited' ? 'The original Run has ended; this message still belongs to that Run.'
              : input.runtime?.target === 'original' && input.runtime.state === 'interrupted' ? 'The original conversation was interrupted. This message is kept with its original Run.'
                : input.waiting?.reason === 'original-target-changed' ? 'The original input target changed; the saved message has not been redirected.'
                  : input.waiting?.phase === 'runtime' ? 'Waiting for the original Runtime connection to return.'
                : input.waiting?.phase === 'authorization' ? 'The original sender’s permission needs confirmation.'
                  : input.waiting?.phase === 'observer' || input.receiptObservation === 'rejoin-needed' ? 'The original input is saved, but its waiting observer is not attached.'
                    : 'The original input environment is not confirmed yet.'
    return { title: 'Message saved · waiting for Agent', detail }
  }
  if (row.state === 'refused') return { title: 'Message not submitted', detail: row.code === 'MOTE_CHAT_QUOTA_EXHAUSTED' ? 'This person has no remaining message allowance.'
    : row.code === 'MOTE_CHAT_EXECUTOR_REQUIRED' ? 'Choose an Executor for new chat below.'
      : row.code === 'MOTE_CHAT_ROUTE_DISABLED' ? 'Private chat was off when this message arrived.'
        : 'The original intake was refused. Its recorded reason is available in details.' }
  if (row.preparation === 'reserved' || row.preparation === 'prepared' || row.preparation === 'creation-dispatched') return { title: 'Preparing a conversation', detail: 'The message is received; Agent input has not started.' }
  return { title: 'Message received', detail: 'Agent input has not started yet.' }
}

export function MoteChatActivity({ target, hostingTarget, active, revision }: {
  target: MoteChatTarget; hostingTarget: ConnectionHostingTarget; active: boolean; revision: number | null
}) {
  const [report, setReport] = useState<MoteChatDiagnosis | null>(null), [reading, setReading] = useState(false), [issue, setIssue] = useState('')
  const lifetime = useRef(0)
  const read = useCallback(async () => {
    const epoch = ++lifetime.current
    setReading(true); setIssue('')
    try {
      const result = await api.moteChat.call('space.mote.chat.diagnose', { target }, hostingTarget)
      if (lifetime.current === epoch) setReport(result)
    } catch (error) { if (lifetime.current === epoch) setIssue(presentError(error)) }
    finally { if (lifetime.current === epoch) setReading(false) }
  }, [target, hostingTarget])
  useEffect(() => { if (active) void read(); return () => { lifetime.current++ } }, [active, revision, read])
  const rows = report?.incoming?.rows ?? [], latest = rows[0], status = latest ? intakeLabel(latest) : null
  return <section className="mote-chat-activity" aria-label="Private chat message activity" aria-busy={reading}>
    <header><span><ChatIcon size={13} />Recent messages</span><button type="button" className="icon-button" aria-label="Refresh private chat activity" title="Refresh private chat activity" disabled={reading} onClick={() => void read()}><RefreshIcon size={13} animation={reading ? 'spin' : undefined} /></button></header>
    {status ? <div className="mote-chat-activity__latest" role="status"><strong>{status.title}</strong><p>{status.detail}</p></div>
      : <p role="status">{reading ? 'Checking recent messages…' : !report ? 'Recent messages could not be checked.' : report.incoming ? 'No private messages in the current reading window.' : report.configuration?.connection ? 'Recent message records are unavailable.' : 'Choose a bot and save to start receiving private messages.'}</p>}
    {issue ? <p className="mote-details__issue" role="status">{report ? 'Previously read status is kept. ' : ''}{issue}</p> : null}
    {report ? <details><summary>Message details{reading ? ' · refreshing' : ''}</summary>
      {rows.length ? <ol>{rows.map((row, index) => { const view = intakeLabel(row); return <li key={row.key}><strong>{index === 0 ? 'Latest' : 'Earlier'} · {view.title}</strong><p>{view.detail}</p>{row.input.failureCode || row.code ? <code>{row.input.failureCode ?? row.code}</code> : null}</li> })}</ol> : null}
      {report.readiness.state === 'unavailable' ? <p>New conversation preparation is unavailable{report.readiness.code ? <code> · {report.readiness.code}</code> : '.'}</p> : null}
      {report.issues.length ? <p>Some observations are unavailable: {report.issues.join(', ')}.</p> : null}
      <p>Only the latest {report.limit} recorded intakes are checked. Saved settings do not confirm delivery.</p>
    </details> : null}
  </section>
}
