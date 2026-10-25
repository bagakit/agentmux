import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useReducer, useRef, useState } from 'react'
import { BotConfirmationCode } from './BotConfirmationCode'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { RoomLinkOperation } from '@agentmux/core/connections'
import { api } from '../lib/api'
import { copyTextToClipboard } from '../lib/clipboard-copy'

const JoinIcon = semanticIconComponent('object.link')

/** Joining and Agent access remain separate facts; this view never guesses the local person's account. */
export function ConnectorRoomJoinLink({ submitted, operation, pending, prominent, canContinue, onCreate, onInspect, onContinue, onRegenerate, initialOpen = false, heading = true }: {
  heading?: boolean; initialOpen?: boolean; submitted: boolean; operation: RoomLinkOperation | null; pending: boolean; prominent: boolean; canContinue: boolean; onCreate(): void; onInspect(): void; onContinue(): void; onRegenerate(): void
}) {
  const [feedback, setFeedback] = useState('')
  const disclosure = useRef<HTMLDetailsElement>(null)
  useEffect(() => { if (initialOpen && disclosure.current) { disclosure.current.open = true; disclosure.current.querySelector('summary')?.focus() } }, [initialOpen])
  useEffect(() => setFeedback(''), [operation?.operationId, submitted])
  const link = operation?.state === 'confirmed' ? operation.link : null
  const expired = link && link.expiresAtUnixSeconds * 1000 <= Date.now()
  const [, showExpiry] = useReducer(value => value + 1, 0)
  useEffect(() => {
    if (!link || expired) return
    let timer: number
    const schedule = () => {
      const remaining = link.expiresAtUnixSeconds * 1000 - Date.now()
      if (remaining <= 0) { showExpiry(); return }
      // Browser timers use a signed 32-bit delay; a long-lived link keeps its original deadline.
      timer = window.setTimeout(schedule, Math.min(remaining, 2_147_483_647))
    }
    schedule()
    return () => window.clearTimeout(timer)
  }, [link?.url, link?.expiresAtUnixSeconds, expired])
  async function open() {
    if (!link) return
    try { await api.ui.openExternal(link.url); setFeedback('Join link handed to your system. Membership and Agent access still need confirmation.') }
    catch (error) { setFeedback(presentError(error)) }
  }
  const body = <div className="agent-connector-fields">
    <p className="agent-connector-note">Create a link or code to open this group in your chat app. Group approval may still be required.</p>
    <p className="agent-connector-note">Joining and permission to use this Agent are separate.</p>
    {!submitted ? <button className="small-button" disabled={pending} onClick={onCreate}>Create join link</button>
      : <><p role="status" className="agent-connector-note">{link ? expired ? 'This join link has expired' : 'Join link ready' : operation?.state === 'refused' ? 'Join link could not be created' : canContinue ? 'Join link has not been sent' : 'Join link result not confirmed'}</p>
        {link && !expired ? <BotConfirmationCode url={link.url} title="Join this group" failureMessage="The join code could not be displayed. Open or copy the original join link instead." /> : null}
        {link ? <><div className="agent-connector-link-actions"><button className="small-button" onClick={() => void open()}>Open join link</button>
          <button className="small-button" onClick={() => void copyTextToClipboard(link.url, error => setFeedback(presentError(error))).then(copied => { if (copied) setFeedback('Join link copied.') })}>Copy join link</button></div>
          <p className="agent-connector-note">Valid until {new Date(link.expiresAtUnixSeconds * 1000).toLocaleString()}</p></> : null}
        <button className="agent-connector-text-action" disabled={pending} onClick={onInspect}>Check link status</button>
        {canContinue ? <button className="small-button" disabled={pending} onClick={onContinue}>Save and continue</button> : null}
        {operation?.state === 'confirmed' || operation?.state === 'refused' ? <button className="small-button" disabled={pending} onClick={onRegenerate}>Generate a new join link</button> : null}
        <details className="agent-connector-disclosure"><summary>Join link receipt</summary><ConnectorRoomJoinReceipt operation={operation} /></details>
      </>}
    {feedback ? <p role="status" className="agent-connector-note">{feedback}</p> : null}
  </div>
  return prominent ? <section className="agent-connector-fields" aria-label="Joining this group">{heading ? <h3><JoinIcon size={16} />Join this group</h3> : null}{body}</section>
    : <details ref={disclosure} className="agent-connector-disclosure" aria-label="Joining this group"><summary>Join this group</summary>{body}</details>
}

/** A historical receipt is readable without becoming the current request or a new effect. */
export function ConnectorRoomJoinReceipt({ operation }: { operation: RoomLinkOperation | null }) {
  return <div className="agent-connector-fields">
    {operation ? <><span>Result · {operation.state}{operation.state === 'refused' ? ' · ' + operation.reason : ''}</span><span>Group · {operation.input.externalConversationId}</span><code>{operation.operationId}</code>
      {operation.state === 'confirmed' ? <><span>Valid until {new Date(operation.link.expiresAtUnixSeconds * 1000).toLocaleString()}</span><code>{operation.link.url}</code></> : null}</> : <span>The original operation is kept. Its result is unknown.</span>}
  </div>
}
