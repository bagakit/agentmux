import { FullPageLoadingSurface } from './FullPageLoadingSurface'
import { startupProgressDetail, type StartupProgress } from '../lib/startup-progress'

/** Only necessary workface hydration owns the app-wide loading surface. */
export function StartupLoadingSurface({ progress, detailSuffix = '' }: {
  progress: StartupProgress
  detailSuffix?: string
}) {
  return <FullPageLoadingSurface scope="app" phase="loading" eyebrow="AgentMux startup"
    title="Restoring your workspace" detail={startupProgressDetail(progress) + detailSuffix} />
}
