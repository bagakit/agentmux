import { memo, useMemo } from 'react'
import { FocusStateMark } from '@agentmux/client-ui/components/FocusStateMark'
import { EMPTY_FOCUS_FILTERS, type FocusFilters } from '../lib/focus-filters'
import { mountedFocusActivity, mountedFocusMatches, mountedFocusTextMatches } from '../lib/mounted-focus-presentation'
import { mountedSpaceInput, mountedSpaceTarget, mountedSpaceInputs, mountedSpaceRegions, projectMountedSpaceView } from '../lib/space-mount-view'
import type { SpaceMountRecord } from '../../../shared/space-mount'
import { mountedSessionFacts } from '../lib/space-mount-sessions'
import { useAppStore } from '../store'
import { useMountedSpaceReader } from './MountedSpaceWorkbench'
import { MountedExecutionRelation } from './MountedExecutionRelation'
import { SurfaceState } from './SurfaceState'
import './mounted-space.css'

const MountedSpaceFocusEntry = memo(function MountedSpaceFocusEntry({ mountKey, target, value, visible, query, filters, now }: { mountKey: string; target: SpaceMountRecord; value: unknown; visible: boolean; query: string; filters: FocusFilters; now: number }) {
  let input: ReturnType<typeof mountedSpaceInput>, issue: string | undefined
  try { input = mountedSpaceInput({ [mountKey]: value }, mountKey) } catch (cause) { issue = cause instanceof Error ? cause.message : String(cause) }
  const refresh = useMountedSpaceReader(target, visible), observation = useAppStore(state => state.mountedSpaceObservations[mountKey])
  const sessionObservation = useAppStore(state => state.mountedSpaceSessions[mountKey])
  const missing = observation?.snapshot?.scope.space === null
  const snapshot = missing ? observation?.lastPresentSnapshot ?? observation?.snapshot : observation?.snapshot, regions = useMemo(() => snapshot ? mountedSpaceRegions(snapshot) : [], [snapshot])
  const sessions = useMemo(() => mountedSessionFacts(snapshot, sessionObservation), [snapshot, sessionObservation])
  const matches = regions.filter(member => mountedFocusTextMatches(member, snapshot, query))
  const agents = matches.filter(member => member.region.agentSessionId && mountedFocusMatches(filters, target, snapshot, mountedFocusActivity(sessions.get(member.key), now)))
  const resources = mountedFocusMatches(filters, target, snapshot) ? matches.filter(member => !member.region.agentSessionId) : []
  function open(tabId?: string, regionId?: string) {
    const view = input && (snapshot ? projectMountedSpaceView(input.view, snapshot) : input.view)
    if (view && tabId && regionId) {
      const group = view.composition.groups.find(group => group.tabOrder.includes(tabId))
      if (group) useAppStore.getState().editSpaceMountView(mountKey, { ...view, selection: { groupId: group.id, tabId, regionId },
        composition: { ...view.composition, activeGroupId: group.id, groups: view.composition.groups.map(item => item.id === group.id ? { ...item, activeTabId: tabId } : item) } })
    }
    useAppStore.getState().selectSpaceMount(mountKey)
  }
  if ((query || filters.projects.length || filters.states.length || filters.types.length) && !agents.length && !resources.length) return null
  return <section className="mounted-space-focus__source" data-mounted-focus-source={mountKey}>
    <header><strong>{snapshot?.scope.space?.name ?? 'Original Space'}</strong><details className="mounted-space-focus__source-details"><summary>Connected Space</summary><small>Source {target.reference.runtimeId}</small></details>
      <button type="button" className="small-button" onClick={() => open()}>Open original Space</button></header>
    {observation?.error ? <p role="status" className="mounted-space-issue">{observation.error} {snapshot ? `Last confirmed membership at revision ${snapshot.revision} is kept.` : 'The original reference is kept.'} <button type="button" className="small-button" onClick={refresh}>Refresh source</button></p> : null}
    {issue ? <p role="status" className="mounted-space-issue">{issue}</p> : null}
    {missing ? <p role="status" className="mounted-space-issue">The original Space is currently absent. Last confirmed members and private input are kept.</p> : null}
    {sessionObservation?.error ? <p role="status" className="mounted-space-issue">Session activity could not be checked. {sessionObservation.error} <button type="button" className="small-button" onClick={refresh}>Refresh source</button></p> : null}
    {agents.length ? <ul className="mounted-space-focus__agents">{agents.map(member => {
      const fact = sessions.get(member.key), activity = mountedFocusActivity(fact, now)
      const source = fact?.current?.state, provider = source?.status === 'observed' ? source.session.providerId : undefined
      const name = member.tab.name ?? `${provider ?? 'Agent'} · ${member.region.agentSessionId!.slice(-6)}`
      return <li key={member.key}>
        <button type="button" className="mounted-space-focus__member focus-context focus-context--card" data-focus-state={activity.mark} onClick={() => open(member.tab.tabId, member.region.regionId)}>
          <span className="focus-context__copy"><span className="focus-context__identity"><strong>{name}</strong><span className="focus-context__state"><FocusStateMark kind={activity.mark} /><small>{activity.label}</small></span></span>
          <span className="focus-context__detail">{activity.issue ?? (activity.status ? `Last observed · ${new Date(activity.status.observedAt).toLocaleString()}` : 'No current activity observation')}</span></span>
        </button>
        <details className="mounted-space-focus__identity"><summary>Source &amp; execution details</summary>
          <MountedExecutionRelation member={member} target={target} occurrence={fact?.occurrence} />
          <small>Source {target.reference.runtimeId}</small><small>Session {member.region.agentSessionId}</small><small>Execution {member.region.execution?.runtimeId ?? 'not observed'}</small>
        </details>
      </li>
    })}</ul> : null}
    {resources.length ? <details className="mounted-space-focus__resources" open={query ? true : undefined}>
      <summary>Resources · {resources.length}</summary><ul>{resources.map(member => <li key={member.key}>
        <button type="button" className="mounted-space-focus__resource" data-mounted-focus-region={member.region.regionId} title={`Tab ${member.tab.tabId} · Region ${member.region.regionId}`} onClick={() => open(member.tab.tabId, member.region.regionId)}><strong>{member.tab.name ?? `${member.region.kind} · ${member.region.regionId.slice(-6)}`}</strong><small>{member.region.kind}</small></button>
      </li>)}</ul>
    </details> : null}
    {!agents.length && !resources.length ? <SurfaceState layout="inline" title={observation?.reading ? 'Reading Space members…' : 'No member currently observed'} description="The source reference, private composition and drafts are retained." /> : null}

  </section>
})
/** A separate qualified source branch; raw foreign IDs never enter the local Focus Session map. */
export const MountedSpaceFocus = memo(function MountedSpaceFocus({ visible, query, filters = EMPTY_FOCUS_FILTERS, now = Date.now() }: { visible: boolean; query: string; filters?: FocusFilters; now?: number }) {
  const raw = useAppStore(state => state.mountedSpaceInputs)
  const inputs = useMemo(() => {
    const result: Array<{ key: string; target: SpaceMountRecord; value: unknown }> = []
    try { for (const key of Object.keys(mountedSpaceInputs(raw))) {
      try { const target = mountedSpaceTarget(raw, key); if (target) result.push({ key, target, value: mountedSpaceInputs(raw)[key] }) } catch { /* Retain other unreadable/future fragments without adopting them as local objects. */ }
    } } catch { /* The original user-document owner reports its storage issue; local Focus remains usable. */ }
    return result
  }, [raw])
  return inputs.length ? <section className="mounted-space-focus" aria-label="Mounted Spaces">
    {inputs.map(({ key, target, value }) => <MountedSpaceFocusEntry key={key} mountKey={key} target={target} value={value} visible={visible} query={query} filters={filters} now={now} />)}
  </section> : null
})
