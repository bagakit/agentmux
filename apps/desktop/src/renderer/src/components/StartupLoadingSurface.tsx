import { FullPageLoadingSurface } from './FullPageLoadingSurface'
import { startupProgressDetail, type StartupProgress } from '../lib/startup-progress'
import type { RuntimeEndpointWarning } from '../../../shared/contracts'
import { Fragment } from 'react'

/** Only necessary workface hydration owns the app-wide loading surface. */
export function StartupLoadingSurface({ progress, runtimeEndpointWarnings = [], detailSuffix = '' }: {
  progress: StartupProgress
  runtimeEndpointWarnings?: readonly RuntimeEndpointWarning[] | undefined
  detailSuffix?: string
}) {
  return <FullPageLoadingSurface scope="app" phase="loading" eyebrow="AgentMux startup"
    title="Restoring your workspace" detail={startupProgressDetail(progress) + detailSuffix}
    supplement={runtimeEndpointWarnings.length ? <div className="surface-state__description" aria-label="Runtime startup observations">
      {runtimeEndpointWarnings.map(warning => <p key={JSON.stringify([warning.hostId, warning.step])} className="full-page-loading__detail">
        <strong>{warning.hostId}: {warning.step}</strong><br />{warning.message}
      </p>)}
    </div> : null}
    {...(runtimeEndpointWarnings.length ? { details: { summary: 'Connection details', content: <dl>
      {runtimeEndpointWarnings.map(warning => <Fragment key={JSON.stringify([warning.hostId, warning.step])}>
        <dt>{warning.hostId}: {warning.step}</dt><dd>{warning.code}<br />{warning.recovery}</dd>
      </Fragment>)}
    </dl> } } : {})} />
}
