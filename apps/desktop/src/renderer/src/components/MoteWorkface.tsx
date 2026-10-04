import { groupIds } from '@agentmux/layout'
import { BookOpen, FileText } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { MOTE_SOUL_PATH } from '../../../shared/scratch-topics'
import { useAppStore } from '../store'
import { MoteWorkfaceContext, useMoteWorkfaceScope } from '../lib/mote-workface'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { useMoteMaterialsActions } from '../lib/mote-materials-actions'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { WorkspaceFilesTool } from './SurfaceToolDock'

/** Mote supplies object context. The original workbench and file panel own their controls. */
export function MoteWorkface({ workspaceId, topicId, floating = false, visible = true, onTabSelect, materialsRequest, reference, onReferenceSelect, empty = false, children }: {
  workspaceId: string; topicId?: string | undefined; floating?: boolean; visible?: boolean
  reference?: WorkbenchProjectionSelection | null | undefined
  empty?: boolean | undefined
  onReferenceSelect?: ((reference: WorkbenchProjectionSelection) => void) | undefined
  onTabSelect?: ((tabId: string, groupId?: string) => void) | undefined; children: ReactNode
  materialsRequest?: { topicId: string; token: object } | null | undefined
}) {
  const scope = useMoteWorkfaceScope(workspaceId, topicId)
  const [filesOpen, setFilesOpen] = useState(false)
  const layouts = useAppStore(state => state.layouts)
  const workspaces = useAppStore(state => state.config?.workspaces)
  const [destination, setDestination] = useState<Pick<WorkbenchProjectionSelection, 'displayWorkspaceId' | 'groupId'> | null>(null)
  const [destinationIssue, setDestinationIssue] = useState(false)
  const destinations = useMemo(() => (workspaces ?? []).flatMap(workspace => {
    const layout = layouts[workspace.id]
    const visibleGroups = layout ? new Set(groupIds(layout.root)) : new Set<string>()
    return (layout?.groups.filter(group => visibleGroups.has(group.id)) ?? []).map((group, index) => ({
      displayWorkspaceId: workspace.id, groupId: group.id, label: workspace.name + ' · Pane ' + (index + 1)
    }))
  }), [workspaces, layouts])
  useEffect(() => { setDestination(null); setDestinationIssue(false) }, [scope?.topic.id, empty, visible])
  const materials = useMoteMaterialsActions(visible ? scope : null, { floating, reference, onTabSelect, onReferenceSelect, destination: empty ? destination : undefined, onOpened: () => setFilesOpen(false) })
  const open = async (path: string) => {
    if (floating && empty && !destination) { setFilesOpen(true); setDestinationIssue(true); return }
    setDestinationIssue(false); return materials.open(path)
  }
  const terminal = async (path: string) => {
    if (floating && empty && !destination) { setDestinationIssue(true); return }
    setDestinationIssue(false); return materials.terminal(path)
  }
  const context = useMemo(() => scope ? { ...scope, floating,
    selectTab: (tabId: string, groupId: string) => onTabSelect ? onTabSelect(tabId, groupId) : useAppStore.getState().activateTab(workspaceId, groupId, tabId)
  } : null, [scope, floating, onTabSelect, workspaceId])
  useEffect(() => { setFilesOpen(false) }, [scope?.topic.id, visible])
  useEffect(() => { if (visible && scope?.topic.id === materialsRequest?.topicId) setFilesOpen(true) }, [materialsRequest, scope?.topic.id, visible])
  const notice = scope?.issue ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: {
    step: 'Mote directory unconfirmed', mode: scope.issue, restore: 'Retry this Mote directory. Its original Agents and drafts remain available.' } }} /> : null
  if (!floating) return <MoteWorkfaceContext.Provider value={context}>{notice}{children}</MoteWorkfaceContext.Provider>
  return <MoteWorkfaceContext.Provider value={context}>
    <div className="mote-workface" data-mote-workface={scope?.topic.id}>
      {notice}
      {scope && floating ? <div className="mote-workface__tools">
        <button type="button" className="small-button" aria-label="Mote files" aria-expanded={filesOpen} onClick={() => setFilesOpen(value => !value)}><BookOpen size={13} /> Files</button>
        <button type="button" className="small-button" onClick={() => void open(scope.rootPath + '/' + MOTE_SOUL_PATH)}><FileText size={13} /> Edit persona</button>
      </div> : null}
      {scope && filesOpen && visible && empty ? <label className="mote-file-destination">Open files in
        <select aria-label="File opening location" value={destination ? JSON.stringify([destination.displayWorkspaceId, destination.groupId]) : ''}
          onChange={event => { const chosen = destinations.find(item => JSON.stringify([item.displayWorkspaceId, item.groupId]) === event.target.value); setDestination(chosen ?? null); setDestinationIssue(false) }}>
          <option value="">Choose a location</option>
          {destinations.map(item => <option key={JSON.stringify([item.displayWorkspaceId,item.groupId])} value={JSON.stringify([item.displayWorkspaceId,item.groupId])}>{item.label}</option>)}
        </select>
        {destinationIssue ? <span role="status">Choose where to open this file. Your Mote and its files are kept.</span> : null}
      </label> : null}
      <div className="mote-workface__body">
        {scope && floating && filesOpen && visible ? <aside className="mote-workface__files" aria-label={scope.topic.title + ' files'}>
          <WorkspaceFilesTool workspace={scope.workspace} isScratch visible={visible} topicId={scope.topic.id} onOpenPath={open} onOpenTerminal={terminal} reference={reference} />
        </aside> : null}
        <div className="mote-workface__original">{children}</div>
      </div>
    </div>
  </MoteWorkfaceContext.Provider>
}
