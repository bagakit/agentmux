import { useSpaceSourceReader as useMountedSpaceReader } from './SpaceSourceReaders'
import { MountedSpaceAgent } from './MountedSpaceAgent'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Panel, PanelGroup, type ImperativePanelGroupHandle } from 'react-resizable-panels'
import { MIN_SPLIT_PERCENT, regionIds, groupIds, setSplitRatio, setWorkbenchRegionSplitRatio, type TabGroupLayoutNode, type WorkbenchRegionLayoutNode } from '@agentmux/layout'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { mountedSpaceInput, mountedSpaceTarget, mountedSpaceRegions, mountedRegionKey, projectMountedSpaceView, type MountedSpaceRegion } from '../lib/space-mount-view'
import { MountedExecutionRelation } from './MountedExecutionRelation'
import { MountedSpaceLauncher } from './MountedSpaceLauncher'
import { WorkbenchTabStrip } from './WorkbenchTabStrip'
import { SurfaceState } from './SurfaceState'
import { WorkbenchEmptyState } from './WorkbenchEmptyState'
import { WorkbenchSplitHandle } from './WorkbenchSplitHandle'
import { SplitRatioCommitter, synchronizeSplitLayout } from '../lib/split-ratio-commit'
import { useWorkbenchDocument } from '../lib/workbench-document'
import { useWorkbenchDocumentVisibility } from '../lib/workbench-window-registry'
import { mountedSessionFacts, type MountedSessionFact, type MountedRegionSessionFact } from '../lib/space-mount-sessions'
import type { SpaceMountRecord, SpaceMountView } from '../../../shared/space-mount'
import './mounted-space.css'

const FolderIcon = semanticIconComponent('object.folder')
const AgentIcon = semanticIconComponent('object.agent')
const RefreshIcon = semanticIconComponent('action.refresh')

/** One visible reader per source Scope, shared by its Workbench and Focus presentation. */
export { useSpaceSourceReader as useMountedSpaceReader } from './SpaceSourceReaders'
/** The original panel/ratio gesture owner, writing only this client's qualified private view. */
function MountedRegionSplit({ node, path, source, visible, commit, children }: {
  node: { ratio: number; direction: 'horizontal' | 'vertical' }; path: string; source: string; visible: boolean
  commit(path: string, ratio: number): void; children: [ReactNode, ReactNode]
}) {
  const group = useRef<ImperativePanelGroupHandle>(null), latest = useRef({ visible, commit, path })
  latest.current = { visible, commit, path }
  const [dragging, setDragging] = useState(false), [committer] = useState(() => new SplitRatioCommitter(node.ratio, ratio => {
    const current = latest.current
    if (current.visible) current.commit(current.path, ratio)
  }))
  committer.synchronizePersistedRatio(node.ratio)
  useLayoutEffect(() => { if (!dragging && group.current) synchronizeSplitLayout(group.current, node.ratio) }, [node.ratio, dragging, visible])
  return <PanelGroup ref={group} direction={node.direction} className="workbench-region-split" onLayout={sizes => committer.observeLayout(sizes)}>
    <Panel minSize={MIN_SPLIT_PERCENT} defaultSize={node.ratio * 100}>{children[0]}</Panel>
    <WorkbenchSplitHandle className="workbench-region-resize-handle" group={group} committer={committer} ratio={node.ratio}
      sourceKey={JSON.stringify([source, path, node.direction])} disabled={!visible} onDragging={setDragging} />
    <Panel minSize={MIN_SPLIT_PERCENT} defaultSize={(1 - node.ratio) * 100}>{children[1]}</Panel>
  </PanelGroup>
}

/** Metadata and private draft only until an exact original Session control is supplied. */
function MountedSessionMetadata({ current, last, stale, error }: { current?: MountedSessionFact | undefined; last?: MountedSessionFact | undefined; stale?: boolean | undefined; error?: string | undefined }) {
  const state = current?.state, confirmed = state?.status === 'observed' && !stale ? state : last?.state.status === 'observed' ? last.state : undefined
  const currentObserved = state?.status === 'observed' && !stale
  const issue = error ?? (state?.status === 'unknown' || state?.status === 'unavailable' ? state.issue.message : undefined)
  return <div className="mounted-session-metadata" role="status">
    {!currentObserved ? <strong>{confirmed ? 'Last confirmed Session metadata' : state?.status === 'missing' ? 'Original Session not returned by its Core' : 'Original Session metadata unconfirmed'}</strong> : null}
    {confirmed ? <span>{confirmed.session.providerId} · {confirmed.session.semanticStatus?.state ?? 'Semantic state not observed'}</span> : null}
    {issue ? <p>{issue}</p> : null}
    {confirmed ? <details><summary>Session observation</summary><dl><div><dt>Original Core</dt><dd><code>{confirmed.authority.runtimeId}</code></dd></div><div><dt>Original Run</dt><dd><code>{confirmed.session.run.runId}</code></dd></div></dl></details> : null}
  </div>
}
function MountedSpaceRegionView({ member, draft, onDraft, session, sessionError, target, mountKey, active, visible }: { visible?: boolean; target?: SpaceMountRecord | undefined; mountKey?: string; active?: boolean; member: MountedSpaceRegion; draft?: string; onDraft?: (value: string) => void; session?: MountedRegionSessionFact | undefined; sessionError?: string | undefined }) {
  const original = member.region
  const fact = session?.current?.state.status === 'observed' ? session.current : session?.last?.state.status === 'observed' ? session.last : undefined
  const known = fact?.state.status === 'observed' ? fact.state : undefined
  const runtimeId = original.execution?.runtimeId ?? fact?.member.runtimeId
  const memberTarget = target && original.agentSessionId && known && runtimeId && known.authority.runtimeId === runtimeId && fact?.member.agentSessionId === original.agentSessionId
    ? { hostId: target.hostId, target: { reference: member.reference, regionId: original.regionId, runtimeId,
      agentSessionId: original.agentSessionId, expectedRun: known.session.run } } : undefined
  return <section className="mounted-space-region" data-source-region={member.key}>
    <header>{original.agentSessionId ? <MountedExecutionRelation member={member} target={target} occurrence={session?.occurrence} /> : <AgentIcon size={14} aria-hidden="true" />}<strong>{original.kind === 'agent' ? 'Original Agent' : original.kind === 'launcher' ? 'New work' : original.kind}</strong></header>
    <details><summary>Original reference</summary><dl><div><dt>Source Runtime</dt><dd><code>{member.reference.runtimeId}</code></dd></div>
      <div><dt>Agent reference</dt><dd><code>{original.agentSessionId ?? 'Not created'}</code></dd></div>
      <div><dt>Source Host alias</dt><dd>{original.execution?.hostId ?? 'Unconfirmed'}</dd></div>
      <div><dt>Execution Runtime</dt><dd><code>{original.execution?.runtimeId ?? 'Unconfirmed'}</code></dd></div>
    </dl></details>
    {original.agentSessionId ? <MountedSessionMetadata {...session} error={sessionError} /> : null}
    {!memberTarget ? <p className="settings-group-note" role="status">{original.agentSessionId ? 'Original Session control is unconfirmed. Its identity and your draft are kept.' : 'No Agent is attached to this original Region. Your unsent task stays private.'}</p> : null}
    {memberTarget && mountKey ? <MountedSpaceAgent target={memberTarget} visible={!!visible} active={!!active} mountKey={mountKey} tabId={member.tab.tabId} /> : null}
    {onDraft && !memberTarget ? <label><span>Private task draft</span><textarea aria-label="Mounted Space task draft" value={draft ?? ''} onChange={event => onDraft(event.target.value)} /></label> : null}
    {original.kind === 'launcher' && target && mountKey ? <MountedSpaceLauncher target={target} project={member.zone} slot={{ kind: 'region', tabId: member.tab.tabId, regionId: member.region.regionId }} mountKey={mountKey} active={!!active} draft={draft ?? ''} /> : null}
  </section>
}
export const MountedSpaceWorkbench = memo(function MountedSpaceWorkbench({ mountKey, visible, projection }: { mountKey: string; visible: boolean; projection?: { tabId: string; regionId: string; regionOnly: boolean } }) {
  const [newWork, setNewWork] = useState(false)
  const inputs = useAppStore(state => state.mountedSpaceInputs), observation = useAppStore(state => state.mountedSpaceObservations[mountKey]), hosts = useAppStore(state => state.config?.hosts)
  const sessionObservation = useAppStore(state => state.mountedSpaceSessions[mountKey])
  let target: ReturnType<typeof mountedSpaceTarget>, entry: ReturnType<typeof mountedSpaceInput>, issue: string | undefined
  try { target = mountedSpaceTarget(inputs, mountKey) } catch (error) { issue = error instanceof Error ? error.message : String(error) }
  try { entry = mountedSpaceInput(inputs, mountKey) } catch (error) { issue = error instanceof Error ? error.message : String(error) }
  const refresh = useMountedSpaceReader(target, visible)
  const missing = observation?.snapshot?.scope.space === null
  const snapshot = missing ? observation?.lastPresentSnapshot ?? observation?.snapshot : observation?.snapshot
  const members = useMemo(() => snapshot ? mountedSpaceRegions(snapshot) : [], [snapshot])
  const sessions = useMemo(() => mountedSessionFacts(snapshot, sessionObservation), [snapshot, sessionObservation])
  const currentView = useMemo(() => snapshot ? projectMountedSpaceView(entry?.view, snapshot) : entry?.view, [entry?.view, snapshot])
  const tabs = new Map(snapshot?.scope.tabs.map(tab => [tab.tabId, tab]))
  const memberIndex = new Map(members.map(member => [member.key, member]))
  const groups = new Map(currentView?.composition.groups.map(group => [group.id, group]))
  const carrier = hosts?.find(host => host.id === target?.hostId)
  function selectTab(groupId: string, id: string, regionId?: string) {
    if (!currentView) return
    const region = regionId ?? currentView.tabLayouts[id]?.activeRegionId ?? tabs.get(id)?.regionIds[0]
    if (!region) return
    const group = groups.get(groupId)
    if (!group?.tabOrder.includes(id)) return
    if (currentView.selection?.groupId === group.id && currentView.selection.tabId === id && currentView.selection.regionId === region) return
    const view: SpaceMountView = { ...currentView, composition: { ...currentView.composition, activeGroupId: group.id,
      groups: currentView.composition.groups.map(item => item.id === group.id ? { ...item, activeTabId: id } : item) }, selection: { groupId: group.id, tabId: id, regionId: region } }
    useAppStore.getState().editSpaceMountView(mountKey, view)
  }
  function renderRegion(node: WorkbenchRegionLayoutNode, tabId: string, groupId: string, path = ''): ReactNode {
    if (node.type === 'leaf') {
      const privateKey = entry && mountedRegionKey(entry.target.reference, tabId, node.regionId), member = privateKey && memberIndex.get(privateKey)
      const changeDraft = (value: string) => useAppStore.getState().editSpaceMountDraft(mountKey, tabId, node.regionId, value, currentView)
      return member ? <div className="mounted-space-region-slot" data-mounted-active={currentView?.selection?.groupId === groupId && currentView.selection.regionId === node.regionId ? 'true' : undefined} onFocusCapture={() => selectTab(groupId, tabId, node.regionId)}>
        <MountedSpaceRegionView target={target} mountKey={mountKey} visible={visible} active={visible && currentView?.selection?.groupId === groupId && currentView.selection.tabId === tabId && currentView.selection.regionId === node.regionId} member={member} draft={entry?.drafts[member.key] ?? ''} onDraft={changeDraft} session={sessions.get(member.key)} sessionError={sessionObservation?.error} /></div>
        : <SurfaceState layout="inline" title="Original Region kept" description="Source observation unavailable. Your unsent task is kept."
          details={{ summary: 'Original reference', content: <code>{entry?.target.reference.runtimeId} / {node.regionId}</code> }}
          body={<div className="mounted-space-retained-input">
            <label>Private task draft<textarea aria-label="Mounted Space task draft" value={privateKey ? entry?.drafts[privateKey] ?? '' : ''} onChange={event => changeDraft(event.target.value)} /></label></div>} />
    }
    return <MountedRegionSplit node={node} path={path} source={JSON.stringify([mountKey, tabId, regionIds(node)])} visible={visible} commit={(nodePath, ratio) => {
      if (!currentView || !tabId || !currentView.tabLayouts[tabId]) return
      useAppStore.getState().editSpaceMountView(mountKey, { ...currentView, tabLayouts: { ...currentView.tabLayouts, [tabId]: setWorkbenchRegionSplitRatio(currentView.tabLayouts[tabId]!, nodePath, ratio) } })
    }}>{[renderRegion(node.first, tabId, groupId, path ? `${path}.first` : 'first'), renderRegion(node.second, tabId, groupId, path ? `${path}.second` : 'second')]}</MountedRegionSplit>
  }
  function renderGroup(node: TabGroupLayoutNode, path = ''): ReactNode {
    if (node.type === 'leaf') {
      const group = groups.get(node.groupId), tabId = group?.activeTabId, layout = tabId && currentView?.tabLayouts[tabId]
      return group ? <section className="pane-group mounted-space-group" data-mounted-group={group.id}>
        <header className="pane-tabbar"><WorkbenchTabStrip activeTabId={tabId ?? null} visible={visible} tabIds={group.tabOrder}>{group.tabOrder.map(id => <button key={id} type="button" className={`workbench-tab${id === tabId ? ' workbench-tab--active' : ''}`} data-workbench-tab-id={id} onClick={() => selectTab(group.id, id)}><span className="workbench-tab__label">{tabs.get(id)?.name ?? 'Original Tab'}</span></button>)}</WorkbenchTabStrip></header>
        {tabId && layout ? <div className="mounted-space-regions">{renderRegion(layout.root, tabId, group.id)}</div>
          : <WorkbenchEmptyState heading="No original member is selected" description="The exact source reference and private view are retained." action={null} />}
      </section> : <SurfaceState title="The original private Group is unavailable" description="Its original input is retained." />
    }
    return <MountedRegionSplit node={node} path={path} source={JSON.stringify([mountKey, groupIds(node)])} visible={visible} commit={(nodePath, ratio) => {
      if (currentView) useAppStore.getState().editSpaceMountView(mountKey, { ...currentView, composition: setSplitRatio(currentView.composition, nodePath, ratio) })
    }}>{[renderGroup(node.first, path ? `${path}.first` : 'first'), renderGroup(node.second, path ? `${path}.second` : 'second')]}</MountedRegionSplit>
  }
  return <section className="mounted-space-workbench" hidden={!visible} data-mounted-space={mountKey}>
    {!projection ? <header className="mounted-space-heading"><div><FolderIcon size={17} aria-hidden="true" /><strong>{snapshot?.scope.space?.name ?? 'Mounted Space'}</strong><small>Via {carrier?.label ?? target?.hostId ?? 'unconfirmed route'}</small></div>
      <div><button type="button" className="small-button" aria-expanded={newWork} onClick={() => setNewWork(value => !value)}>New work</button><button type="button" className="small-button" onClick={refresh}><RefreshIcon size={12} />Refresh source</button>
        <button type="button" className="small-button" onClick={() => useAppStore.getState().selectSpaceMount(null)}>Return to local workface</button></div></header> : null}
    {newWork && target ? <div className="mounted-space-new-work"><MountedSpaceLauncher target={target}
      project={snapshot?.scope.zones.find(zone => zone.zoneId === target.zoneId && zone.workspaceId === target.workspaceId)} slot={{ kind: 'new-work', zoneId: target.zoneId }}
      mountKey={mountKey} active={visible} /></div> : null}
    {issue || observation?.error ? <p className="mounted-space-issue" role="status">{issue ?? observation?.error} {snapshot ? `Last confirmed source revision ${snapshot.revision} is kept.` : 'The original source reference is kept.'}</p> : null}
    {missing ? <p className="mounted-space-issue" role="status">The original Space is not currently present at its source. Its last confirmed members and private input are kept.</p> : null}
    {projection && currentView ? (() => {
      const group = [...groups.values()].find(group => group.tabOrder.includes(projection.tabId)), layout = currentView.tabLayouts[projection.tabId]
      return group && layout ? <div className="mounted-space-regions">{renderRegion(projection.regionOnly ? { type: 'leaf', regionId: projection.regionId } : layout.root, projection.tabId, group.id)}</div>
        : <SurfaceState title="Original workface retained" description="Its exact Tab and Region are not currently observed. Refresh the original project to check its locations." />
    })() : snapshot || currentView ? <>
      {!entry && target ? <div className="mounted-space-regions">{members.map(member => <MountedSpaceRegionView key={member.key} visible={visible} target={target} member={member} session={sessions.get(member.key)} sessionError={sessionObservation?.error} />)}</div> : currentView ? <div className="mounted-space-composition">{renderGroup(currentView.composition.root)}</div>
        : <WorkbenchEmptyState heading={snapshot?.scope.space ? 'No original member is selected' : 'The original Space is not currently present'} description="The exact source reference and private view are retained." action={null} />}
    </> : <SurfaceState title={observation?.reading ? 'Reading the original Space…' : 'Original Space observation unavailable'} description="Your original workface and this source reference are retained. Refresh its source to try the same reader again." />}
  </section>
})
