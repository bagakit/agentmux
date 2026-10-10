import { useEffect, useRef, useState } from 'react'
import type { ConnectionProfileObservation, ConnectionProfileOperation } from '@agentmux/core/connections'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../lib/api'
import '../styles/bot-profile.css'

export function ProfileManagementLink({ url }: { url?: string | undefined }) {
  const [issue, setIssue] = useState(''), epoch = useRef(0)
  useEffect(() => { epoch.current++; setIssue(''); return () => { epoch.current++ } }, [url])
  return url ? <><button type="button" className="small-button" onClick={() => {
    const current = ++epoch.current
    void api.ui.openExternal(url).catch(error => { if (epoch.current === current) setIssue(presentError(error)) })
  }}>Manage on platform</button>{issue ? <p role="status" className="mote-details__issue">{issue}</p> : null}</> : null
}

/** Original write receipt and separate current observations. Never declares publication. */
export function ConnectionProfileResult({ operation }: { operation: ConnectionProfileOperation }) {
  const patch = operation.patch.state
  return <div className="bot-profile-result" data-profile-operation={operation.operationId}>
    <p role="status">{patch === 'confirmed' ? 'Profile written. Check and publish it on the platform.'
      : patch === 'unknown' || patch === 'dispatching' ? 'The profile write is not confirmed. Its original operation is kept.'
      : patch === 'refused' ? 'The platform did not accept this profile update. The bot connection is kept.'
      : 'Profile update is not complete yet.'}</p>
    {operation.reason ? <p className="mote-details__hint">{profileReason(operation.reason)}</p> : null}
    {operation.language ? <p className="mote-details__hint">Name and description language: {operation.language}. Other languages are not claimed as synchronized.</p> : null}
    {operation.online ? <ConnectionProfileObservationView observation={operation.online} /> : null}
    <ProfileManagementLink url={operation.managementUrl} />
    <details className="bot-profile-details"><summary>Profile update details</summary><dl>
      <div><dt>Image upload</dt><dd>{operation.upload.state}</dd></div><div><dt>Profile write</dt><dd>{patch}</dd></div>
      <div><dt>Publication</dt><dd>{operation.publication === 'platform-review-required' ? 'Platform review required' : 'Not submitted here'}</dd></div>
      <div><dt>Original update</dt><dd><code>{operation.operationId}</code></dd></div>
    </dl></details>
  </div>
}
export function ConnectionProfileObservationView({ observation }: { observation: ConnectionProfileObservation }) {
  return <div className="bot-profile-observation" data-profile-observation={observation.connectionId}>
    <strong>Current online profile</strong>
    {observation.profile ? <div className="mote-bot-profile">{observation.profile.avatarUrl ? <img src={observation.profile.avatarUrl} alt="Current bot avatar" width={40} height={40} referrerPolicy="no-referrer" /> : null}<div>{observation.profile.name ? <strong>{observation.profile.name}</strong> : null}{observation.profile.description ? <p>{observation.profile.description}</p> : null}</div></div> : <p className="mote-details__hint">Online profile not confirmed.</p>}
    {observation.state !== 'observed' || observation.reason ? <p className="mote-details__hint">{observation.reason ? profileReason(observation.reason) : 'Some online fields are not confirmed.'}</p> : null}
    {observation.version || observation.reviewingVersionId ? <p className="mote-details__hint">{observation.reviewingVersionId ? 'A platform version is under review. ' : ''}{observation.version ? `Version status: ${observation.version.status}.` : ''}</p> : null}
    <details className="bot-profile-details"><summary>Observation sources</summary><dl><div><dt>App ID</dt><dd><code>{observation.application.appId}</code></dd></div><div><dt>Online version</dt><dd>{observation.onlineVersionId ?? 'Not confirmed'}</dd></div><div><dt>Description language</dt><dd>{observation.language ?? 'Not confirmed'}</dd></div>{observation.metadata?.description ? <div><dt>Application metadata</dt><dd>{observation.metadata.description} (not an online description)</dd></div> : null}</dl></details>
  </div>
}
function profileReason(reason: NonNullable<ConnectionProfileOperation['reason']>): string {
  const labels: Record<typeof reason, string> = {
    'adapter-unavailable': 'Profile management is unavailable here. Existing messaging is kept.',
    'credential-unavailable': 'The saved credential could not be read for this update.',
    'connection-revised': 'This connection changed. The original update remains attached to its original application and revision.',
    'source-unconfirmed': 'The platform profile baseline is not confirmed. Existing fields have been kept.',
    'storage-unconfirmed': 'The saved update could not be confirmed. Check the same operation.',
    'permission-required': 'The platform requires additional permission for this profile update.',
    'creation-origin-unsupported': 'The platform does not support this profile operation for this application’s creation source.',
    'application-under-review': 'This application is under platform review.',
    'platform-rejected': 'The platform did not accept this profile update.',
    'effect-unconfirmed': 'The original platform result is not confirmed. It will not be sent again.',
    'online-unconfirmed': 'Online profile details are not confirmed.'
  }
  return labels[reason]
}
