import { useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { RoomLinkOperation } from '@agentmux/core/connections'
import { api } from '../lib/api'
import { copyTextToClipboard } from '../lib/clipboard-copy'

/** Joining and Agent access remain separate facts; this view never guesses the local person's account. */
export function ConnectorRoomJoinLink({ submitted, operation, pending, onCreate, onInspect }: {
  submitted: boolean; operation: RoomLinkOperation | null; pending: boolean; onCreate(): void; onInspect(): void
}) {
  const [feedback, setFeedback] = useState('')
  const link = operation?.state === 'confirmed' ? operation.link : null
  const expired = link && link.expiresAtUnixSeconds * 1000 <= Date.now()
  async function open() {
    if (!link) return
    try { await api.ui.openExternal(link.url); setFeedback('Join link handed to your system. Membership and Agent access still need confirmation.') }
    catch (error) { setFeedback(presentError(error)) }
  }
  return <section className="agent-connector-fields" aria-label="Joining this group">
    <h3>Join this group</h3>
    <p className="agent-connector-note">Your platform account is not linked here. Use a join link to request entry; the group may require approval. Joining does not give permission to use this Agent.</p>
    {!submitted ? <button className="small-button" disabled={pending} onClick={onCreate}>Create join link</button>
      : <><p role="status" className="agent-connector-note">{link ? expired ? 'This join link has expired' : 'Join link ready' : operation?.state === 'refused' ? 'Join link could not be created' : 'Join link result not confirmed'}</p>
        {link ? <><div className="agent-connector-link-actions"><button className="small-button" onClick={() => void open()}>Open join link</button>
          <button className="small-button" onClick={() => void copyTextToClipboard(link.url, error => setFeedback(presentError(error))).then(copied => { if (copied) setFeedback('Join link copied.') })}>Copy join link</button></div>
          <p className="agent-connector-note">Valid until {new Date(link.expiresAtUnixSeconds * 1000).toLocaleString()}</p></> : null}
        <button className="agent-connector-text-action" disabled={pending} onClick={onInspect}>Check link status</button>
        <details className="agent-connector-disclosure"><summary>Join link receipt</summary><div className="agent-connector-fields">
          {operation ? <><span>{operation.input.externalConversationId}</span><code>{operation.operationId}</code><span>{operation.state}{operation.state === 'refused' ? ' · ' + operation.reason : ''}</span></> : <span>The original operation is kept. Its result is unknown.</span>}
        </div></details>
      </>}
    {feedback ? <p role="status" className="agent-connector-note">{feedback}</p> : null}
  </section>
}
