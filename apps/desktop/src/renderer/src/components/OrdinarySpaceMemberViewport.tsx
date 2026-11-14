import { useMemo, useRef, type ReactNode } from 'react'
import { ordinaryAgentSpaceMember, useAppStore } from '../store'
import { spaceMountKey } from '../../../shared/space-mount'
import { SpaceMemberWorkface } from './MountedSpaceAgent'
import { SurfaceState } from './SurfaceState'
import { ordinaryMemberObservedRun, ordinaryMemberRouteOccurrence } from '../lib/ordinary-space-member'
import { MountedExecutionRelation } from './MountedExecutionRelation'
import { SpaceSourceReaders, useSpaceSourceReader } from './SpaceSourceReaders'
import { MountedCreationRecovery } from './MountedCreationRecovery'
import { OriginalSourceMemberMetadata } from './OriginalSourceMemberMetadata'
import { FullPageLoadingSurface } from './FullPageLoadingSurface'
import { mountedSessionFacts } from '../lib/space-mount-sessions'
import './mounted-space.css'
import './ordinary-space-member.css'

/** An ordinary private Region keeps its layout; only its exact foreign IO source differs. */
export function OrdinarySpaceMemberViewport(props: {
  tabId: string; regionId: string; sessionId: string; visible: boolean; active: boolean; interactiveResize?: boolean; children: ReactNode
}) {
  return <SpaceSourceReaders><Viewport {...props} /></SpaceSourceReaders>
}
function Viewport({ tabId, regionId, sessionId, visible, active, interactiveResize = false, children }: {
  tabId: string; regionId: string; sessionId: string; visible: boolean; active: boolean; interactiveResize?: boolean; children: ReactNode
}) {
  const occurrence = useAppStore(() => ordinaryAgentSpaceMember({ tabId, regionId, sessionId }))
  const refreshSource = useSpaceSourceReader(occurrence.kind === 'foreign' ? occurrence.source : undefined, visible)
  const activeRegion = useAppStore(state => state.tabs[tabId]?.layout.activeRegionId === regionId)
  const mountKey = occurrence.kind === 'foreign' ? spaceMountKey(occurrence.source.reference) : ''
  const metadata = useAppStore(state => occurrence.kind === 'foreign' ? state.mountedSpaceSessions[mountKey] : undefined)
  const snapshot = useAppStore(state => occurrence.kind === 'foreign' ? state.mountedSpaceObservations[mountKey]?.snapshot : undefined)
  const observedRun = occurrence.kind === 'foreign' ? ordinaryMemberObservedRun(occurrence, metadata) : undefined
  const retainedRun = useRef<{ witness: string; runId: string } | undefined>(undefined)
  const retainedCreationRecovery = useRef<{ witness: string; active: boolean } | undefined>(undefined)
  const retainedSessionRecovery = useRef<{ witness: string; active: boolean } | undefined>(undefined)
  const sourceProjection = sessionId.startsWith('original-source-member:')
  const relationFact = useMemo(() => occurrence.kind === 'foreign' && snapshot ? mountedSessionFacts(snapshot, metadata).get(occurrence.presentation.key) : undefined,
    [occurrence, snapshot, metadata])
  const sourceError = useAppStore(state => occurrence.kind === 'foreign' ? state.mountedSpaceSessions[mountKey]?.error ?? state.mountedSpaceObservations[mountKey]?.error : undefined)
  const draft = useAppStore(state => {
    if (occurrence.kind !== 'foreign') return undefined
    const inputs = state.mountedSpaceInputs as Record<string, { drafts?: Record<string, string> }>
    return inputs[mountKey]?.drafts?.[occurrence.presentation.key]
  })
  if (occurrence.kind === 'existing') return children
  if (occurrence.kind === 'unconfirmed') return <SurfaceState title="Original Agent reference unconfirmed" description={occurrence.issue}
    details={{ summary: 'Original reference', content: <dl><dt>Region</dt><dd><code>{regionId}</code></dd><dt>Session</dt><dd><code>{sessionId}</code></dd></dl> }} />
  const relation = ordinaryMemberRouteOccurrence(occurrence, snapshot, metadata)
  const reference = <dl><div><dt>Source Runtime</dt><dd><code>{occurrence.source.reference.runtimeId}</code></dd></div>
    <div><dt>Agent reference</dt><dd><code>{occurrence.member.target.agentSessionId}</code></dd></div>
    <div><dt>Execution Runtime</dt><dd><code>{occurrence.member.target.runtimeId}</code></dd></div>
    <div><dt>Creation</dt><dd><code>{occurrence.creationOperationId}</code></dd></div></dl>
  const privateDraft = <details className="mounted-space-session-draft" open={Boolean(draft)}><summary>Unsent draft</summary>
    <label><span>Private task draft</span><textarea aria-label="Original Space task draft" value={draft ?? ''} onChange={event => useAppStore.getState().editSpaceMountDraft(mountKey, tabId, regionId, event.target.value)} /></label>
  </details>
  const recoveryWitness = JSON.stringify([occurrence.source, occurrence.presentation.key, occurrence.creationOperationId])
  const sessionState = relationFact?.current?.state
  const priorSessionRecovery = retainedSessionRecovery.current
  const recoverSession = sourceProjection && !observedRun && (sessionState?.status === 'missing' ||
    Boolean(priorSessionRecovery && priorSessionRecovery.witness === recoveryWitness && priorSessionRecovery.active))
  retainedSessionRecovery.current = { witness: recoveryWitness, active: recoverSession }
  if (recoverSession) {
    const issue = sourceError ?? (sessionState?.status === 'unknown' || sessionState?.status === 'unavailable' ? sessionState.issue.message : undefined)
    const checking = !issue && (metadata?.reading === true || sessionState?.status === 'pending')
    return <section className="agent-surface ordinary-space-member" aria-label="Original Space member">
      <FullPageLoadingSurface scope="region" visible={visible} phase={checking ? 'loading' : 'parked'} eyebrow="Session connection"
        title={checking ? 'Checking the original session' : sessionState?.status === 'missing' ? 'Original session unavailable' : 'Session connection unconfirmed'}
        description={checking ? 'Reading this session from its original device.' : sessionState?.status === 'missing'
          ? 'The original device did not return this session. Its current state is still unknown.' : 'The original session cannot be read through this connection yet.'}
        detail={checking ? 'Your workspace and draft stay here while the original session is checked.' : 'Check the execution device, then try again. Your workspace and draft are kept.'}
        actions={<button type="button" className="primary-button" onClick={refreshSource}>Check again</button>}
        details={{ summary: 'Connection details', content: <>{issue ? <p>{issue}</p> : null}{reference}</> }} supplement={privateDraft} />
    </section>
  }
  const priorRecovery = retainedCreationRecovery.current
  const recoverCreation = sourceProjection && !observedRun && (!occurrence.member.target.expectedRun.runId ||
    Boolean(priorRecovery && priorRecovery.witness === recoveryWitness && priorRecovery.active))
  retainedCreationRecovery.current = { witness: recoveryWitness, active: recoverCreation }
  if (recoverCreation) return <section className="agent-surface ordinary-space-member" aria-label="Original Space member">
    <header className="ordinary-space-member__header"><MountedExecutionRelation member={occurrence.presentation} target={occurrence.source} occurrence={relation} />
      <details className="ordinary-space-member__reference"><summary>Original Agent</summary>{reference}</details></header>
    <MountedCreationRecovery target={occurrence.source} member={occurrence.presentation} visible={visible} onRefresh={refreshSource}
      reference={reference} supplement={privateDraft} sessionIssue={sourceError} />
  </section>
  const { expectedRun: _initialRun, ...member } = occurrence.member.target
  const witness = JSON.stringify([occurrence.member.hostId, member, occurrence.creationOperationId])
  const previous = retainedRun.current
  const selectedRun = observedRun ?? (previous && previous.witness === witness ? previous.runId : occurrence.member.target.expectedRun.runId)
  retainedRun.current = { witness, runId: selectedRun }
  const currentTarget = { ...occurrence.member, target: { ...member, expectedRun: { runId: selectedRun } } }
  return <section className="agent-surface ordinary-space-member" aria-label="Original Space member">
    <header className="ordinary-space-member__header"><MountedExecutionRelation member={occurrence.presentation} target={occurrence.source} occurrence={relation} />
    <details className="ordinary-space-member__reference"><summary>Original Agent</summary>{reference}
      {sourceProjection ? <OriginalSourceMemberMetadata current={relationFact?.current} last={relationFact?.last} error={sourceError} /> : null}</details></header>
    <SpaceMemberWorkface key={JSON.stringify([currentTarget,occurrence.creationOperationId])} target={currentTarget} privateInput={occurrence.source} onRefreshSource={refreshSource}
      mountKey={mountKey} tabId={tabId} visible={visible} active={active && activeRegion} interactiveResize={interactiveResize} />
  </section>
}
