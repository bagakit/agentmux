import { useRef, type ReactNode } from 'react'
import { ordinaryAgentSpaceMember, useAppStore } from '../store'
import { spaceMountKey } from '../../../shared/space-mount'
import { SpaceMemberWorkface } from './MountedSpaceAgent'
import { SurfaceState } from './SurfaceState'
import { ordinaryMemberObservedRun, ordinaryMemberRouteOccurrence } from '../lib/ordinary-space-member'
import { MountedExecutionRelation } from './MountedExecutionRelation'
import { SpaceSourceReaders, useSpaceSourceReader } from './SpaceSourceReaders'
import './mounted-space.css'
import './ordinary-space-member.css'

/** An ordinary private Region keeps its layout; only its exact foreign IO source differs. */
export function OrdinarySpaceMemberViewport(props: {
  tabId: string; regionId: string; sessionId: string; visible: boolean; active: boolean; children: ReactNode
}) {
  return <SpaceSourceReaders><Viewport {...props} /></SpaceSourceReaders>
}
function Viewport({ tabId, regionId, sessionId, visible, active, children }: {
  tabId: string; regionId: string; sessionId: string; visible: boolean; active: boolean; children: ReactNode
}) {
  const occurrence = useAppStore(() => ordinaryAgentSpaceMember({ tabId, regionId, sessionId }))
  const refreshSource = useSpaceSourceReader(occurrence.kind === 'foreign' ? occurrence.source : undefined, visible)
  const activeRegion = useAppStore(state => state.tabs[tabId]?.layout.activeRegionId === regionId)
  const metadata = useAppStore(state => occurrence.kind === 'foreign' ? state.mountedSpaceSessions[spaceMountKey(occurrence.source.reference)] : undefined)
  const snapshot = useAppStore(state => occurrence.kind === 'foreign' ? state.mountedSpaceObservations[spaceMountKey(occurrence.source.reference)]?.snapshot : undefined)
  const observedRun = occurrence.kind === 'foreign' ? ordinaryMemberObservedRun(occurrence, metadata) : undefined
  const retainedRun = useRef<{ witness: string; runId: string } | undefined>(undefined)
  if (occurrence.kind === 'existing') return children
  if (occurrence.kind === 'unconfirmed') return <SurfaceState title="Original Agent reference unconfirmed" description={occurrence.issue}
    details={{ summary: 'Original reference', content: <dl><dt>Region</dt><dd><code>{regionId}</code></dd><dt>Session</dt><dd><code>{sessionId}</code></dd></dl> }} />
  const { expectedRun: _initialRun, ...member } = occurrence.member.target
  const witness = JSON.stringify([occurrence.member.hostId, member, occurrence.creationOperationId])
  const previous = retainedRun.current
  const selectedRun = observedRun ?? (previous && previous.witness === witness ? previous.runId : occurrence.member.target.expectedRun.runId)
  retainedRun.current = { witness, runId: selectedRun }
  const currentTarget = { ...occurrence.member, target: { ...member, expectedRun: { runId: selectedRun } } }
  return <section className="agent-surface ordinary-space-member" aria-label="Original Space member">
    <header className="ordinary-space-member__header"><MountedExecutionRelation member={occurrence.presentation} target={occurrence.source} occurrence={ordinaryMemberRouteOccurrence(occurrence, snapshot, metadata)} />
    <details className="ordinary-space-member__reference"><summary>Original Agent</summary><dl>
      <dt>Source Runtime</dt><dd><code>{occurrence.source.reference.runtimeId}</code></dd>
      <dt>Execution Runtime</dt><dd><code>{occurrence.member.target.runtimeId}</code></dd>
      <dt>Creation</dt><dd><code>{occurrence.creationOperationId}</code></dd>
      <dt>Session</dt><dd><code>{occurrence.member.target.agentSessionId}</code></dd>
    </dl></details></header>
    <SpaceMemberWorkface key={JSON.stringify([currentTarget,occurrence.creationOperationId])} target={currentTarget} privateInput={occurrence.source} onRefreshSource={refreshSource}
      mountKey={spaceMountKey(occurrence.source.reference)} tabId={tabId} visible={visible} active={active && activeRegion} />
  </section>
}
