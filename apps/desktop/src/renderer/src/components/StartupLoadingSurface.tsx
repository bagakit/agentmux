import { FullPageLoadingSurface } from './FullPageLoadingSurface'
import { startupProgressDetail, type StartupProgress } from '../lib/startup-progress'
import type { RuntimeEndpointWarning } from '../../../shared/contracts'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { CSSProperties } from 'react'

const DisclosureIcon = semanticIconComponent('navigation.disclosure')

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
    {activities.map((group, index) => <section className="startup-activity__group" key={group.step} style={{ '--startup-order': index } as CSSProperties}>
      <div className="startup-activity__line">
        <span className="startup-activity__marker" aria-hidden="true" />
        <h3>{group.step}</h3>
        <span className="startup-activity__count">{group.hostIds.size} {group.hostIds.size === 1 ? 'endpoint' : 'endpoints'}</span>
      </div>
      {group.messages.map(message => <p className="startup-activity__message" key={message}>{message}</p>)}
    </section>)}
  </div>
}

function StartupEndpointDetails({ warnings }: { warnings: readonly RuntimeEndpointWarning[] }) {
  const endpoints = new Map<string, RuntimeEndpointWarning[]>()
  for (const warning of warnings) {
    let endpoint = endpoints.get(warning.hostId)
    if (!endpoint) {
      endpoint = []
      endpoints.set(warning.hostId, endpoint)
    }
    endpoint.push(warning)
  }
  return <div className="startup-endpoints" aria-label="Endpoint connection details">
    {[...endpoints].map(([hostId, endpointWarnings], index) => <details className="startup-endpoint" key={hostId} style={{ '--startup-order': index } as CSSProperties}>
      <summary>
        <DisclosureIcon className="startup-endpoint__chevron" size={12} aria-hidden="true" />
        <span className="startup-endpoint__host">{hostId}</span>
        <span className="startup-endpoint__count">{endpointWarnings.length} {endpointWarnings.length === 1 ? 'activity' : 'activities'}</span>
      </summary>
      <div className="startup-endpoint__activities">
        {endpointWarnings.map(warning => <section className="startup-endpoint__activity" key={JSON.stringify([warning.hostId, warning.step])}>
          <h4>{warning.step}</h4>
          <p className="startup-endpoint__message">{warning.message}</p>
          <p className="startup-endpoint__recovery">{warning.recovery}</p>
          <span className="startup-endpoint__code">{warning.code}</span>
        </section>)}
      </div>
    </details>)}
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
    {...(runtimeEndpointWarnings.length ? { details: { summary: 'Connection details', content: <StartupEndpointDetails warnings={runtimeEndpointWarnings} /> } } : {})} />
}
