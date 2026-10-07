import { FullPageLoadingSurface } from './FullPageLoadingSurface'
import { startupProgressDetail, type StartupAgentAvailability, type StartupProgress } from '../lib/startup-progress'

/** The app's existing startup stage also observes the parallel executable checks. */
export function StartupLoadingSurface({ loading, progress, agents, hostLabel, detailSuffix = '', onContinue }: {
  loading: boolean
  progress: StartupProgress
  agents: StartupAgentAvailability | null
  hostLabel?: string | undefined
  detailSuffix?: string
  onContinue(): void
}) {
  return <FullPageLoadingSurface scope="app" phase="loading" eyebrow="AgentMux startup"
    title={loading ? 'Restoring your workspace' : 'Checking your Agents'}
    detail={(loading ? startupProgressDetail(progress) : 'Your workspace is restored. Checking the Agent commands available here.') + detailSuffix}
    actions={!loading && agents?.pending ? <button type="button" className="small-button" onClick={onContinue}>Continue to workspace</button> : undefined}
    supplement={agents ? <div className="startup-agent-check" aria-label="Agent availability check">
      <div className="startup-agent-check__heading"><strong>Agent availability</strong><span>{agents.pending ? 'Checking' : 'Checked'}</span></div>
      <p>{hostLabel ?? agents.hostId}{agents.total === null ? '' : ` · ${agents.current} of ${agents.total} checked`}</p>
      {agents.pending ? <small>You can enter your workspace while this check continues.</small> : null}
    </div> : undefined} />
}
