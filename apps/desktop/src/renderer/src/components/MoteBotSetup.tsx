import { useEffect, useRef, useState } from 'react'
import type { ConnectionRecord } from '@agentmux/core/connections'
import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../lib/api'
import { useMoteBotSetup } from '../lib/use-mote-bot-setup'
import { SelectionField } from './SelectionField'
import { BotConfirmationCode } from './BotConfirmationCode'
import { ConnectionProfileResult } from './ConnectionProfileResult'

export function MoteBotSetup({ target, topicId, record, onChoose, onCurrent }: {
  target: MotePreferencesTarget | null; topicId: string; record: ConnectionRecord | null
  onChoose(): void; onCurrent(): void
}) {
  const setup = useMoteBotSetup(target, topicId), [avatar, setAvatar] = useState(true), [issuer, setIssuer] = useState('')
  const [separate, setSeparate] = useState(false)
  const [openIssue, setOpenIssue] = useState(''), opened = useRef(0)
  const available = setup.capabilities.filter(item => item.availability === 'available')
  const capability = available.find(item => JSON.stringify([item.adapterId, item.domain]) === issuer) ?? available[0]
  const operation = setup.operation, raw = setup.requests.find(item => item.input.operationId === setup.selectedId)
  const selected = operation ?? raw, ids = new Set(setup.operations.map(item => item.operationId))
  const history = [...setup.operations.map(item => ({ id: item.operationId, name: item.snapshot.name, action: item.action })), ...setup.requests.filter(item => !ids.has(item.input.operationId)).map(item => ({ id: item.input.operationId, name: 'Unconfirmed bot setup', action: item.action }))]
  const unfinished = setup.operations.find(item => (item.action === 'create' && (!item.enrollment?.configured || item.defaultLink.state !== 'saved')) || !item.profile || !['confirmed', 'refused'].includes(item.profile.patch.state))
  const resumeId = unfinished?.operationId ?? setup.requests.find(item => !ids.has(item.input.operationId))?.input.operationId
  const challenge = operation?.enrollment?.challenge, busy = !!setup.selectedId && setup.busy.includes(setup.selectedId)
  useEffect(() => { opened.current++; setOpenIssue(''); return () => { opened.current++ } }, [setup.selectedId, challenge?.verificationUrl])
  return <section className="mote-bot-setup" aria-label="Mote bot profile">
    {!selected ? <>
      {setup.profile ? <>
        <div className="mote-bot-profile">{setup.profile.image ? <img width={48} height={48} src={setup.profile.image} alt="Saved Mote avatar" /> : null}<div><span className="mote-details__hint">From the saved Mote profile</span><strong>{setup.profile.name}</strong>{setup.profile.description ? <p>{setup.profile.description}</p> : <p className="mote-details__hint">No public description is saved. The bot’s description will be kept.</p>}</div></div>
        {setup.profile.image ? <label className="mote-bot-avatar"><input type="checkbox" checked={avatar} onChange={event => setAvatar(event.target.checked)} />Use the saved avatar</label> : <p className="mote-details__hint">{setup.profile.avatarIssue ?? 'No saved image avatar. The bot’s avatar will be kept.'}</p>}
      </> : <p role="status" className="mote-details__hint">{setup.loading ? 'Reading the saved profile…' : 'Saved public profile not available yet.'}</p>}
      {record ? <>
        <p className="mote-details__hint">Update <strong>{record.config.label}</strong>. This changes the same bot used by any other Motes and groups sharing this application.</p>
        <div className="mote-bot-actions"><button type="button" className="primary-button" disabled={!setup.profile} onClick={() => void setup.sync(record, avatar && !!setup.profile?.image)}>Sync Mote profile</button><button type="button" className="small-button" onClick={onChoose}>Change bot</button></div>
      </> : <>
        {available.length > 1 ? <SelectionField label="Mote bot platform" value={capability ? JSON.stringify([capability.adapterId, capability.domain]) : ''} options={available.map(item => ({ value: JSON.stringify([item.adapterId, item.domain]), label: item.label }))} onValueChange={setIssuer} /> : null}
        <div className="mote-bot-actions">{resumeId && !separate ? <button type="button" className="primary-button" onClick={() => void setup.check(resumeId)}>Resume original setup</button> : <button type="button" className="primary-button" disabled={!setup.profile || !capability} onClick={() => { setSeparate(false); capability && void setup.begin(capability, avatar && !!setup.profile?.image) }}>Create a bot for this Mote</button>}<button type="button" className="small-button" onClick={onChoose}>Choose existing bot</button></div>
        {!capability ? <p className="mote-details__hint">Bot creation is unavailable here. Existing bot choices are still available.</p> : null}
      </>}
      <button type="button" className="small-button" onClick={() => void setup.refreshSource()}>Refresh saved profile</button>
    </> : <>
      <button type="button" className="small-button" onClick={() => { setSeparate(false); setup.newIntent(); onCurrent() }}>Back to bot profile</button>
      <div className="mote-bot-request-heading"><strong>{operation?.snapshot.name ?? 'Original bot setup'}</strong><span className="mote-details__hint">{operation?.action === 'sync' || raw?.action === 'sync' ? 'Profile update' : 'Bot creation'}</span></div>
      {challenge ? <div className="mote-bot-confirmation"><BotConfirmationCode url={challenge.verificationUrl} /><p>Scan and confirm on your platform, then check this setup here.</p>{challenge.userCode ? <p>Confirmation code <strong>{challenge.userCode}</strong></p> : null}<button type="button" className="small-button" onClick={() => { const token = ++opened.current; void api.ui.openExternal(challenge.verificationUrl).catch(error => { if (token === opened.current) setOpenIssue(presentError(error)) }) }}>Open confirmation page</button></div> : null}
      {operation ? <>
        <dl className="mote-bot-stages" aria-label="Original bot setup results">
          {operation.enrollment ? <><div><dt>Application</dt><dd>{operation.enrollment.authorization === 'authorized' ? 'Created' : operation.enrollment.authorization === 'pending' ? 'Waiting for platform confirmation' : operation.enrollment.authorization === 'denied' ? 'Platform declined' : operation.enrollment.authorization === 'expired' ? 'Confirmation expired; creation not inferred' : 'Creation not confirmed'}</dd></div><div><dt>Connection</dt><dd>{operation.enrollment.configured ? 'Saved on this environment' : 'Save not complete'}</dd></div></> : null}
          {operation.action === 'create' ? <div><dt>Mote default</dt><dd>{operation.defaultLink.state === 'saved' ? 'Original save confirmed' : operation.defaultLink.state === 'conflict' ? 'The saved choice changed. Review a new association.' : operation.defaultLink.state === 'unknown' ? 'Original save not confirmed' : 'Not saved yet'}</dd></div> : null}
        </dl>
        {operation.profile ? <ConnectionProfileResult operation={operation.profile} /> : operation.connection ? <p className="mote-details__hint">The profile update has not been confirmed yet. The saved connection is kept.</p> : null}
        {operation.defaultLink.state === 'unknown' || operation.defaultLink.state === 'conflict' ? <p className="mote-details__hint">Reading the current choice does not confirm the original save. Choose this same saved bot explicitly to make a new association; its existing setup is kept.</p> : null}
        <div className="mote-bot-actions"><button type="button" className="primary-button" disabled={busy} onClick={() => void setup.check(operation.operationId, true)}>{busy ? 'Checking setup…' : challenge ? 'Check platform confirmation' : 'Check saved progress'}</button><button type="button" className="small-button" onClick={() => void setup.check(operation.operationId)}>View original result</button></div>
        <details className="bot-profile-details"><summary>Original setup details</summary><dl><div><dt>Original request</dt><dd><code>{operation.operationId}</code></dd></div>{operation.connection ? <div><dt>Application</dt><dd><code>{operation.connection.application.appId}</code></dd></div> : null}{operation.defaultLink.current ? <div><dt>Last observed default</dt><dd>{operation.defaultLink.current.connection?.application.appId ?? 'No default bot'} — current value, not a save receipt</dd></div> : null}{operation.issue ? <div><dt>Unconfirmed step</dt><dd>{operation.issue}</dd></div> : null}</dl></details>
      </> : <><p role="status">The result is not confirmed. Your original request is retained.</p><button type="button" className="primary-button" onClick={() => void setup.check(raw!.input.operationId)}>Check original result</button>{raw?.phase === 'not-dispatched' ? <button type="button" className="small-button" onClick={() => void setup.send(raw)}>Continue this request</button> : null}</>}
    </>}
    {resumeId || selected ? <details className="mote-bot-history"><summary>Create another bot</summary><p className="mote-details__hint">A separate setup may create another bot. All previous requests remain available.</p><button type="button" className="small-button" onClick={() => { setup.newIntent(); setSeparate(true); onCurrent() }}>Start a separate setup</button></details> : null}
    {setup.issue || openIssue ? <p role="status" className="mote-details__issue">{openIssue || setup.issue}</p> : null}
    {history.length ? <details className="mote-bot-history"><summary>Previous bot operations</summary>{history.map(item => <button type="button" className="small-button" key={item.id} data-mote-bot-operation={item.id} onClick={() => { setup.select(item.id); void setup.check(item.id) }}>{item.name} · {item.action === 'create' ? 'Creation' : 'Profile update'}</button>)}{setup.next ? <button type="button" className="small-button" onClick={() => void setup.list(setup.next!)}>Load earlier operations</button> : null}</details> : null}
  </section>
}
