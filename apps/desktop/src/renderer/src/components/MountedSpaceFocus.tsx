import { memo, useMemo } from 'react'
import { mountedSpaceInput, mountedSpaceTarget, mountedSpaceInputs, mountedSpaceRegions, projectMountedSpaceView } from '../lib/space-mount-view'
import type { SpaceMountRecord } from '../../../shared/space-mount'
import { mountedSessionFacts } from '../lib/space-mount-sessions'
import { useAppStore } from '../store'
import { useMountedSpaceReader } from './MountedSpaceWorkbench'
import { MountedExecutionRelation } from './MountedExecutionRelation'
import { SurfaceState } from './SurfaceState'
import './mounted-space.css'

const MountedSpaceFocusEntry = memo(function MountedSpaceFocusEntry({ mountKey, target, value, visible, query }: { mountKey: string; target: SpaceMountRecord; value: unknown; visible: boolean; query: string }) {
  let input: ReturnType<typeof mountedSpaceInput>, issue: string | undefined
  try { input = mountedSpaceInput({ [mountKey]: value }, mountKey) } catch (cause) { issue = cause instanceof Error ? cause.message : String(cause) }
  const refresh = useMountedSpaceReader(target, visible), observation = useAppStore(state => state.mountedSpaceObservations[mountKey])
  const sessionObservation = useAppStore(state => state.mountedSpaceSessions[mountKey])
  const missing = observation?.snapshot?.scope.space === null
  const snapshot = missing ? observation?.lastPresentSnapshot ?? observation?.snapshot : observation?.snapshot, regions = useMemo(() => snapshot ? mountedSpaceRegions(snapshot) : [], [snapshot])
  const sessions = useMemo(() => mountedSessionFacts(snapshot, sessionObservation), [snapshot, sessionObservation])
  const matches = regions.filter(member => !query || [snapshot?.scope.space?.name, member.region.agentSessionId, member.region.execution?.hostId, member.region.execution?.runtimeId, member.reference.runtimeId]
    .some(value => value?.toLocaleLowerCase().includes(query.toLocaleLowerCase())))
  function open(tabId?: string, regionId?: string) {
    const view = input && (snapshot ? projectMountedSpaceView(input.view, snapshot) : input.view)
    if (view && tabId && regionId) {
      const group = view.composition.groups.find(group => group.tabOrder.includes(tabId))
      if (group) useAppStore.getState().editSpaceMountView(mountKey, { ...view, selection: { groupId: group.id, tabId, regionId },
        composition: { ...view.composition, activeGroupId: group.id, groups: view.composition.groups.map(item => item.id === group.id ? { ...item, activeTabId: tabId } : item) } })
    }
    useAppStore.getState().selectSpaceMount(mountKey)
  }
  if (query && !matches.length) return null
  return <section className="mounted-space-focus__source" data-mounted-focus-source={mountKey}>
    <header><strong>{snapshot?.scope.space?.name ?? 'Original Space'}</strong><small>Source {target.reference.runtimeId}</small>
      <button type="button" className="small-button" onClick={() => open()}>Open original Space</button></header>
    {observation?.error ? <p role="status" className="mounted-space-issue">{observation.error} {snapshot ? `Last confirmed membership at revision ${snapshot.revision} is kept.` : 'The original reference is kept.'} <button type="button" className="small-button" onClick={refresh}>Refresh source</button></p> : null}
    {issue ? <p role="status" className="mounted-space-issue">{issue}</p> : null}
    {missing ? <p role="status" className="mounted-space-issue">The original Space is currently absent. Last confirmed members and private input are kept.</p> : null}
    {matches.length ? <ul>{matches.map(member => { const fact = sessions.get(member.key), state = fact?.current?.state; return <li key={member.key}>
      <button type="button" className="mounted-space-focus__member" onClick={() => open(member.tab.tabId, member.region.regionId)}>
        <strong>{member.region.agentSessionId ? <MountedExecutionRelation member={member} target={target} /> : null}{member.tab.name ?? 'Original work'} · {member.region.kind === 'agent' ? 'Agent' : member.region.kind}</strong>
        <small>{member.region.agentSessionId ?? 'No Agent started'} · Execution {member.region.execution?.runtimeId ?? 'unconfirmed'}</small>
        <span>{member.region.agentSessionId ? state?.status === 'observed' && !fact?.stale ? `Observed · ${state.session.semanticStatus?.state ?? 'Semantic state not observed'}` : 'Original Session state not yet confirmed' : 'Original project · private task draft'}</span>
      </button>
    </li> })}</ul> : <SurfaceState layout="inline" title={observation?.reading ? 'Reading original membership…' : 'No original member currently observed'}
      description="The source reference, private composition and drafts are retained." />}
  </section>
})
/** A separate qualified source branch; raw foreign IDs never enter the local Focus Session map. */
export const MountedSpaceFocus = memo(function MountedSpaceFocus({ visible, query }: { visible: boolean; query: string }) {
  const raw = useAppStore(state => state.mountedSpaceInputs)
  const inputs = useMemo(() => {
    const result: Array<{ key: string; target: SpaceMountRecord; value: unknown }> = []
    try { for (const key of Object.keys(mountedSpaceInputs(raw))) {
      try { const target = mountedSpaceTarget(raw, key); if (target) result.push({ key, target, value: mountedSpaceInputs(raw)[key] }) } catch { /* Retain other unreadable/future fragments without adopting them as local objects. */ }
    } } catch { /* The original user-document owner reports its storage issue; local Focus remains usable. */ }
    return result
  }, [raw])
  return inputs.length ? <section className="mounted-space-focus" aria-label="Mounted Spaces">
    {inputs.map(({ key, target, value }) => <MountedSpaceFocusEntry key={key} mountKey={key} target={target} value={value} visible={visible} query={query} />)}
  </section> : null
})
