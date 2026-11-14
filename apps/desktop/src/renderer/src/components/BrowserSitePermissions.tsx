import { useState } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import type { BrowserSitePermissionAnswer, BrowserSitePermissionDecision, BrowserSitePermissionRequest, BrowserSitePermissionState } from '../../../shared/browser-site-permissions'

type Props = {
  state?: BrowserSitePermissionState | undefined
  onAnswer(answer: BrowserSitePermissionAnswer): Promise<void>
  onForget(decision: Pick<BrowserSitePermissionDecision, 'origin' | 'embeddingOrigin' | 'permission'>): Promise<void>
  onRetry(): Promise<void>
}
const names = { camera: 'camera', microphone: 'microphone', geolocation: 'location', notifications: 'notifications' }

function PermissionRequest({ request, onAnswer }: { request: BrowserSitePermissionRequest; onAnswer: Props['onAnswer'] }) {
  const [remember, setRemember] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const answer = async (allow: boolean) => {
    setBusy(true); setError('')
    try { await onAnswer({ requestId: request.requestId, navigationId: request.navigationId, allow, remember }) }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <section className="browser-permission-request" aria-label="Website permission request">
    <p><strong>{request.origin}</strong> wants to use your {request.permissions.map(value => names[value]).join(' and ')}.</p>
    {request.origin !== request.embeddingOrigin ? <p>Embedded in <strong>{request.embeddingOrigin}</strong>.</p> : null}
    <div className="browser-permission-actions">
      {request.profileId ? <label><input type="checkbox" checked={remember} disabled={busy} onChange={event => setRemember(event.target.checked)} /> Remember for this Profile</label> : <span>For this page only</span>}
      <Button type="button" disabled={busy} onClick={event => { if (event.isTrusted) void answer(false) }}>{remember ? 'Block' : 'Block once'}</Button>
      <Button type="button" disabled={busy} onClick={event => { if (event.isTrusted) void answer(true) }}>{remember ? 'Allow' : 'Allow once'}</Button>
    </div>
    {error ? <p role="alert">{error}</p> : null}
  </section>
}

export function BrowserSitePermissions({ state, onAnswer, onForget, onRetry }: Props) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [forgot, setForgot] = useState(false)
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await action() } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  if (!state || (!state.requests.length && !state.decisions.length && !state.warning && !forgot && !error)) return null
  return <aside className="browser-site-permissions" aria-label="Site permissions">
    {state.requests.map(request => <PermissionRequest key={request.requestId} request={request} onAnswer={onAnswer} />)}
    {state.warning ? <p role="status">{state.warning} <Button type="button" disabled={busy} onClick={() => void run(onRetry)}>Retry reading</Button></p> : null}
    {state.decisions.length ? <details><summary>Site permissions · {state.decisions.length}</summary>
      {state.decisions.map(decision => <p key={JSON.stringify([decision.origin, decision.embeddingOrigin, decision.permission])}>
        <span>{decision.origin} · {names[decision.permission]} · {decision.allow ? 'Allowed' : 'Blocked'} · {decision.scope === 'profile' ? 'This Profile' : 'This page'}</span>
        <Button type="button" disabled={busy} onClick={() => void run(async () => { await onForget(decision); setForgot(true) })}>Forget</Button>
      </p>)}
    </details> : null}
    {forgot ? <p role="status">The decision was forgotten for future requests. Reload this page to end existing access.</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </aside>
}
