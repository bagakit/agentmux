import { ArrowUpRight } from 'lucide-react'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import type { DemandArrangement } from '../lib/global-task-board'
import { workspaceForSession } from '../lib/workbench-tabs'
import { useAppStore } from '../store'
import { SessionPane } from './SessionPane'
import { SessionRegionHost } from './SessionRegionHost'
import { StatusDot } from './StatusDot'

/** Observes existing Sessions; input and terminal size remain owned by their original Regions. */
export function SessionObservationRegions({ sessionIds, contextId, arrangement = 'columns' }: {
  sessionIds: readonly string[]
  contextId: string
  arrangement?: DemandArrangement
}) {
  const sessions = useAppStore((state) => state.sessions)
  const config = useAppStore((state) => state.config)
  const selectSession = useAppStore((state) => state.selectSession)
  return <SessionRegionHost arrangement={arrangement} className={`global-task-workspace__regions global-task-workspace__regions--${arrangement}`}>
    {sessionIds.map((id) => {
      const session = sessions.find((item) => item.id === id)
      if (!session) return <section key={id} className="global-task-workspace__empty" data-session-id={id}><strong>Session awaiting recovery</strong><span>{id}</span><span>The link is preserved. Open Session to inspect recovery.</span><button type="button" onClick={() => selectSession(id)}>Open Session</button></section>
      const workspaceId = workspaceForSession(config, session)?.id ?? SCRATCH_WORKSPACE_ID
      return <section key={id} className="global-task-region" data-session-id={id}>
        <header className="global-task-region__header"><span className="global-task-region__name"><StatusDot status={session.status} />{session.label}</span><button type="button" className="global-task-region__jump" onClick={() => selectSession(id)}><ArrowUpRight size={12} />Open Session</button></header>
        <div className="global-task-region__body"><SessionPane sessionId={id} surfaceKind={session.kind} interactiveResize={false} readOnly visible linkOrigin={{ workspaceId, tabGroupId: `observe:${contextId}`, tabId: `observe:${contextId}`, regionId: `observe:${contextId}:${id}` }} /></div>
      </section>
    })}
  </SessionRegionHost>
}
