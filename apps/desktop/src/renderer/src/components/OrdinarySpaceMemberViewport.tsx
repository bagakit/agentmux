import { useRef, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@agentmux/client-ui/components/Button'
import { ordinaryAgentSpaceMember, useAppStore } from '../store'
import { spaceMountKey } from '../../../shared/space-mount'
import { SpaceMemberWorkface } from './MountedSpaceAgent'
import { SurfaceState } from './SurfaceState'
import { ordinaryMemberObservation } from '../lib/ordinary-space-member'
import { MountedExecutionRelation } from './MountedExecutionRelation'
import { SpaceSourceReaders, useSpaceSourceReader } from './SpaceSourceReaders'
import { MountedCreationRecovery } from './MountedCreationRecovery'
import { OriginalSourceMemberMetadata } from './OriginalSourceMemberMetadata'
import { FullPageLoadingSurface } from './FullPageLoadingSurface'
import { confirmedMountedSessionState } from '../lib/space-mount-sessions'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import './mounted-space.css'
import './ordinary-space-member.css'

type MemberViewObservation = ReturnType<typeof ordinaryMemberObservation> & { sourceError: string | undefined }

/** An ordinary private Region keeps its layout; only its exact foreign IO source differs. */
export function OrdinarySpaceMemberViewport(props: {
  tabId: string; regionId: string; sessionId: string | null; visible: boolean; active: boolean; interactiveResize?: boolean; children: ReactNode
}) {
  return <SpaceSourceReaders><Viewport {...props} /></SpaceSourceReaders>
}
function Viewport({ tabId, regionId, sessionId, visible, active, interactiveResize = false, children }: {
  tabId: string; regionId: string; sessionId: string | null; visible: boolean; active: boolean; interactiveResize?: boolean; children: ReactNode
}) {
  const occurrence = useAppStore(() => ordinaryAgentSpaceMember({ tabId, regionId, sessionId }))
  const refreshSource = useSpaceSourceReader(occurrence.kind === 'foreign' ? occurrence.source : undefined, visible)
  const activeRegion = useAppStore(state => state.tabs[tabId]?.layout.activeRegionId === regionId)
  const mountKey = occurrence.kind === 'foreign' ? spaceMountKey(occurrence.source.reference) : ''
  const { current, last, stale, reading, observedRun, relation, sourceError } = useAppStore(useShallow((state): Partial<MemberViewObservation> => {
    if (occurrence.kind !== 'foreign') return {}
    const observation = state.mountedSpaceSessions[mountKey], source = state.mountedSpaceObservations[mountKey]
    return { ...ordinaryMemberObservation(occurrence, source?.snapshot, observation), sourceError: observation?.error ?? source?.error }
  }))
  const retainedRun = useRef<{ witness: string; runId: string } | undefined>(undefined)
  const retainedCreationRecovery = useRef<{ witness: string; active: boolean } | undefined>(undefined)
  const retainedSessionRecovery = useRef<{ witness: string; active: boolean } | undefined>(undefined)
  const sourceProjection = sessionId?.startsWith('original-source-member:') ?? false
  const confirmedSession = confirmedMountedSessionState(current, last, stale)
  if (occurrence.kind === 'existing') return children
  if (occurrence.kind === 'unconfirmed') return <SurfaceState title="Original Agent reference unconfirmed" description={occurrence.issue}
    details={{ summary: 'Original reference', content: <dl><dt>Region</dt><dd><code>{regionId}</code></dd><dt>Session</dt><dd><code>{sessionId}</code></dd></dl> }} />
  const reference = <dl><div><dt>Source Runtime</dt><dd><code>{occurrence.source.reference.runtimeId}</code></dd></div>
    <div><dt>Agent reference</dt><dd><code>{occurrence.member.target.agentSessionId}</code></dd></div>
    <div><dt>Execution Runtime</dt><dd><code>{occurrence.member.target.runtimeId}</code></dd></div>
    <div><dt>Creation</dt><dd><code>{occurrence.creationOperationId}</code></dd></div></dl>
  const recoveryWitness = JSON.stringify([occurrence.source, occurrence.presentation.key, occurrence.creationOperationId])
  const sessionState = current?.state
  const priorSessionRecovery = retainedSessionRecovery.current
  const recoverSession = sourceProjection && !observedRun && (sessionState?.status === 'missing' ||
    Boolean(priorSessionRecovery && priorSessionRecovery.witness === recoveryWitness && priorSessionRecovery.active))
  retainedSessionRecovery.current = { witness: recoveryWitness, active: recoverSession }
  const priorRecovery = retainedCreationRecovery.current
  const recoverCreation = sourceProjection && !observedRun && (!occurrence.member.target.expectedRun.runId ||
    Boolean(priorRecovery && priorRecovery.witness === recoveryWitness && priorRecovery.active))
  retainedCreationRecovery.current = { witness: recoveryWitness, active: recoverCreation }
  const issue = sourceError ?? (sessionState?.status === 'unknown' || sessionState?.status === 'unavailable' ? sessionState.issue.message : undefined)
  const checking = !issue && (reading === true || sessionState?.status === 'pending')
  const runtimeRecovery = recoverSession ? (layout: 'inline' | 'surface') => layout === 'surface'
    ? <FullPageLoadingSurface scope="region" visible={visible} phase={checking ? 'loading' : 'parked'} eyebrow="Session connection"
      title={checking ? 'Checking the original session' : sessionState?.status === 'missing' ? 'Original session unavailable' : 'Session connection unconfirmed'}
      description={checking ? 'Reading this session from its original device.' : sessionState?.status === 'missing'
        ? 'The original device did not return this session. Its current state is still unknown.' : 'The original session cannot be read through this connection yet.'}
      detail="Your workspace, original conversation and draft are kept."
      actions={<Button type="button" variant="primary" onClick={refreshSource}>Check again</Button>}
      details={{ summary: 'Connection details', content: <>{issue ? <p>{issue}</p> : null}{reference}</> }} />
    : <ServiceWindowNotice disclosure={{ scope: recoveryWitness, id: 'session-observation', cause: issue ?? sessionState?.status ?? 'unconfirmed', visible }}
      notice={{ kind: 'indeterminate', notice: { step: checking ? 'Checking the original session' : 'Session connection unconfirmed',
        mode: issue ?? 'The original Session observation is unconfirmed. Its conversation is read through its own original source.',
        restore: 'Check the execution device, then refresh this observation. Your draft is kept.' } }}
      actions={<Button type="button" onClick={refreshSource}>Check again</Button>} />
    : recoverCreation ? (layout: 'inline' | 'surface') => <MountedCreationRecovery target={occurrence.source} member={occurrence.presentation}
      visible={visible} onRefresh={refreshSource} reference={reference} sessionIssue={sourceError} layout={layout} /> : undefined
  const { expectedRun: _initialRun, ...member } = occurrence.member.target
  const witness = JSON.stringify([occurrence.member.hostId, member, occurrence.creationOperationId])
  const previous = retainedRun.current
  const selectedRun = observedRun ?? (previous && previous.witness === witness ? previous.runId : occurrence.member.target.expectedRun.runId)
  retainedRun.current = { witness, runId: selectedRun }
  const currentTarget = { ...occurrence.member, target: { ...member, expectedRun: { runId: selectedRun } } }
  return <section className="agent-surface ordinary-space-member" aria-label="Original Space member">
    <header className="ordinary-space-member__header"><MountedExecutionRelation member={occurrence.presentation} target={occurrence.source} occurrence={relation} />
    <details className="ordinary-space-member__reference"><summary>Original Agent</summary>{reference}
      {sourceProjection ? <OriginalSourceMemberMetadata current={current} last={last} stale={stale} error={sourceError} /> : null}</details></header>
    <SpaceMemberWorkface key={witness} target={currentTarget} privateInput={occurrence.source} sourceTabId={occurrence.presentation.tab.tabId} onRefreshSource={refreshSource} runtimeRecovery={runtimeRecovery}
      sessionMetadata={confirmedSession ? { providerId: confirmedSession.session.providerId, workspacePath: confirmedSession.session.workspacePath, run: confirmedSession.session.run } : undefined}
      visible={visible} active={active && activeRegion} interactiveResize={interactiveResize} />
  </section>
}
