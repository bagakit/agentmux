import { FullPageLoadingSurface } from './FullPageLoadingSurface'
import { startupProgressDetail, type StartupProgress } from '../lib/startup-progress'
import type { RuntimeEndpointWarning } from '../../../shared/contracts'
import { Fragment } from 'react'

type StartupActivityGroup = {
  step: string
  hostIds: Set<string>
  messages: string[]
}

function StartupActivity({ warnings }: { warnings: readonly RuntimeEndpointWarning[] }) {
  const groups = new Map<string, StartupActivityGroup>()
  for (const warning of warnings) {
    const key = warning.step
    let group = groups.get(key)
    if (!group) {
      group = { step: warning.step, hostIds: new Set(), messages: [] }
      groups.set(key, group)
    }
    group.hostIds.add(warning.hostId)
    if (!group.messages.includes(warning.message)) group.messages.push(warning.message)
  }
  const activities = [...groups.values()]
  const endpointCount = new Set(warnings.map(warning => warning.hostId)).size
  return <div className="startup-activity" aria-label="Runtime startup observations">
    <div className="startup-activity__heading"><span>Current activity</span><span>{endpointCount} {endpointCount === 1 ? 'endpoint' : 'endpoints'} · {activities.length} {activities.length === 1 ? 'step' : 'steps'}</span></div>
    {activities.map(group => <section className="startup-activity__group" key={group.step}>
      <div className="startup-activity__line">
        <span className="startup-activity__marker" aria-hidden="true">›</span>
        <h3>{group.step}</h3>
        <span className="startup-activity__count">{group.hostIds.size} {group.hostIds.size === 1 ? 'endpoint' : 'endpoints'}</span>
      </div>
      {group.messages.map(message => <p className="startup-activity__message" key={message}>{message}</p>)}
    </section>)}
  </div>
}

/** Only necessary workface hydration owns the app-wide loading surface. */
export function StartupLoadingSurface({ progress, runtimeEndpointWarnings = [], detailSuffix = '' }: {
  progress: StartupProgress
  runtimeEndpointWarnings?: readonly RuntimeEndpointWarning[] | undefined
  detailSuffix?: string
}) {
  return <FullPageLoadingSurface scope="app" phase="loading" eyebrow="AgentMux startup"
    title="Restoring your workspace" detail={startupProgressDetail(progress) + detailSuffix}
    supplement={runtimeEndpointWarnings.length ? <StartupActivity warnings={runtimeEndpointWarnings} /> : null}
    {...(runtimeEndpointWarnings.length ? { details: { summary: 'Connection details', content: <dl>
      {runtimeEndpointWarnings.map(warning => <Fragment key={JSON.stringify([warning.hostId, warning.step])}>
        <dt>{warning.hostId}: {warning.step}</dt><dd>{warning.code}<br />{warning.recovery}</dd>
      </Fragment>)}
    </dl> } } : {})} />
}
