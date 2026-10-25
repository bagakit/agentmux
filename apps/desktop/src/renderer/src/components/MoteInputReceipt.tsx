import { useState } from 'react'
import type { MoteInputInspection } from '@agentmux/core'
import type { SessionHistoryReference } from '../../../shared/contracts'
import { api } from '../lib/api'
import '../styles/mote-primary-agent.css'

/** Read only on an explicit detail/refresh action, using this original input's Host and ID. */
export function MoteInputReceipt(props: { reference: SessionHistoryReference; observationId: string }) {
  return <OriginalMoteInputReceipt key={JSON.stringify([props.reference.hostId, props.reference.agentSessionId, props.observationId])} {...props} />
}
function OriginalMoteInputReceipt({ reference, observationId }: { reference: SessionHistoryReference; observationId: string }) {
  const [value, setValue] = useState<MoteInputInspection | null>(null)
  const [phase, setPhase] = useState<'unread' | 'reading' | 'read' | 'unknown'>('unread')
  async function read() {
    if (phase === 'reading') return
    setPhase('reading')
    try {
      const next = await api.sessions.inspectMoteInput(reference, observationId)
      setValue(next); setPhase(next ? 'read' : 'unknown')
    } catch { setPhase('unknown') }
  }
  const notice = (kind: 'input' | 'result') => {
    const current = value?.notices[kind]
    if (!current || current.state === 'unassociated') return 'Not yet associated'
    return current.state === 'submitted' ? 'Notification submitted' : current.state === 'pending' ? 'Waiting to notify'
      : current.state === 'not-applied' ? 'Notification not applied' : 'Delivery unconfirmed'
  }
  return <details className="mote-input-receipt" onToggle={event => { if (event.currentTarget.open && phase === 'unread') void read() }}>
    <summary>Main Agent update</summary>
    {phase === 'reading' ? <p role="status">Reading original receipt…</p> : null}
    {phase === 'unknown' ? <p role="status">The update could not be confirmed. The member’s original input is retained.</p> : null}
    {value ? <>
      {value.observation.sourceStatus === 'self' ? <p>This input is already in the main Agent conversation.</p>
        : <dl><dt>Input notice</dt><dd>{notice('input')}</dd><dt>Result notice</dt><dd>{notice('result')}</dd></dl>}
      {value.observation.issue ? <p>{value.observation.issue}</p> : null}
      <p>Notification delivery does not confirm understanding or completion.</p>
    </> : null}
    <button type="button" className="small-button" disabled={phase === 'reading'} onClick={() => void read()}>Check original update</button>
  </details>
}
