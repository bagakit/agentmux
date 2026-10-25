import { createContext, useContext, useRef, useState, type ReactNode } from 'react'
import { type MoteWorkfaceScope, useMoteWorkfaceScope } from '../lib/mote-workface'
import { useSpaceContentPresentation } from '../lib/space-content-presentation'
import { MoteFirstCooperation } from './MoteFirstCooperation'
import { SidebarToggleChrome, WindowSidebarLayoutContext } from './TopRowChrome'
import { useAppStore } from '../store'
import { SurfaceModeSwitch } from './SurfaceModeSwitch'
import { MoteQuickModeDialog } from './MoteQuickMode'
import { moteConversationReference, moteDefaultConversation, useMoteDefaultConversation } from '../lib/mote-quick-preferences'
import { openMoteMaterial } from '../lib/mote-materials-actions'
import { scratchTopicsForWorkspace } from '../lib/scratch-topic-snapshots'
import { showMoteConversation } from '../lib/mote-conversation-mode'
import { sameWorkbenchProjectionSelection } from '../lib/workbench-projection'

export type MoteContentSection = 'profile' | 'ideas' | 'calendar'
export type MoteSpaceSection = MoteContentSection | 'discussion'
const MoteSpaceContext = createContext<{
  topicId: string
  section: MoteSpaceSection
  select(section: MoteSpaceSection): void
} | null>(null)
export const useMoteSpace = () => useContext(MoteSpaceContext)

/** Local presentation only. The original workbench subtree stays in place in every mode. */
export function MoteSpaceFrame({ workspaceId, active, children }: {
  workspaceId: string | undefined; active: boolean; children: ReactNode
}) {
  const scope = useMoteWorkfaceScope(workspaceId, undefined, active)
  const presentation = useSpaceContentPresentation()
  const preferredProjects = useAppStore(state => state.projectRailOpen)
  const sidebars = useContext(WindowSidebarLayoutContext)
  const projectRailOpen = sidebars?.projectRailOpen ?? preferredProjects
  const owner = scope ? JSON.stringify([scope.workspace.hostId, scope.workspace.id, scope.workspace.path, scope.topic.id, scope.rootPath]) : ''
  const [content, setContent] = useState<{ owner: string; section: MoteContentSection }>({ owner, section: 'profile' })
  const section: MoteSpaceSection = presentation?.expanded ? content.owner === owner ? content.section : 'profile' : 'discussion'
  const select = (next: MoteSpaceSection) => {
    if (next === 'discussion') presentation?.collapse()
    else { setContent({ owner, section: next }); presentation?.expand() }
  }
  const visible = active && scope !== null && presentation !== null
  return <MoteSpaceContext.Provider value={scope && presentation ? { topicId: scope.topic.id, section, select } : null}>
    <WindowSidebarLayoutContext.Provider value={sidebars ? { ...sidebars, chromeInFrame: visible } : null}>
    <div className="mote-space-frame" data-mote-space={visible ? scope.topic.id : undefined}>
      {scope && presentation ? <header className="mote-space-frame__header" hidden={!visible}>
        <div className="mote-space-frame__navigation">
        {!projectRailOpen ? <SidebarToggleChrome /> : null}
        <SurfaceModeSwitch value={section} active={visible} ariaLabel="Mote pages" onChange={select}
          options={[{ value: 'profile', label: 'Profile' }, { value: 'discussion', label: 'Discussion' }, { value: 'ideas', label: 'Ideas' }, { value: 'calendar', label: 'Calendar' }]} />
        </div>
        <MoteSpaceActions key={owner} scope={scope} active={visible} section={section} onDiscussion={() => select('discussion')} />
      </header> : null}
      {children}
    </div>
    </WindowSidebarLayoutContext.Provider>
  </MoteSpaceContext.Provider>
}

/** Entry controls navigate original work; the shared Composer remains its only input. */
function MoteSpaceActions({ scope, active, section, onDiscussion }: {
  scope: MoteWorkfaceScope; active: boolean; section: MoteSpaceSection; onDiscussion(): void
}) {
  const primary = useMoteDefaultConversation(scope.topic, scope.workspace.id, active)
  const selected = useAppStore(state => active ? state.workbenchSpaceSelection : null)
  const [editing, setEditing] = useState(false), [issue, setIssue] = useState('')
  const invoker = useRef<HTMLElement | null>(null)
  const selectedReference = selected?.groupId && selected.tabId && selected.regionId
    ? { displayWorkspaceId: selected.workspaceId, groupId: selected.groupId, tabId: selected.tabId, regionId: selected.regionId } : null
  const atPrimary = section === 'discussion' && primary.conversation && selectedReference &&
    sameWorkbenchProjectionSelection(selectedReference, primary.conversation)
  const edit = (node: HTMLElement) => { invoker.current = node; setEditing(true) }
  const returnToPrimary = () => {
    const state = useAppStore.getState()
    const latest = scratchTopicsForWorkspace(state.scratchTopicSnapshots, scope.workspace)?.find(item => item.id === scope.topic.id)
    const topic = latest && !latest.readError ? latest : scope.topic
    const current = moteDefaultConversation(state, topic, scope.workspace.id)
    if (!current.conversation) {
      setIssue(current.issue ?? 'The main Agent’s original location is not confirmed. Your current work is kept; review its saved reference.')
      return
    }
    const reference = moteConversationReference(current.conversation)
    if (!state.selectMainRegion(reference, state.workbenchSpaceSelection)) {
      setIssue('The main Agent’s original location could not be opened. Your current work is kept; review its saved reference.')
      return
    }
    setIssue(''); onDiscussion(); showMoteConversation(scope, { reference })
  }
  return <div className="mote-space-frame__actions">
    {primary.conversation ? !atPrimary ? <button type="button" className="mote-space-frame__primary" onClick={returnToPrimary}>Return to main Agent</button> : null
      : <button type="button" className="mote-space-frame__primary" onClick={event => edit(event.currentTarget)}>{primary.issue ? 'Review main Agent' : 'Choose main Agent'}</button>}
    <MoteFirstCooperation scope={scope} disclosure />
    {issue ? <p className="mote-details__issue mote-space-frame__issue" role="status">{issue}
      {primary.conversation ? <button type="button" className="small-button" onClick={event => edit(event.currentTarget)}>Review main Agent</button> : null}
    </p> : null}
    {editing ? <MoteQuickModeDialog scope={scope} onOpenPath={path => openMoteMaterial(scope, path)} onClose={() => setEditing(false)}
      returnFocus={() => invoker.current?.isConnected ? invoker.current : null} /> : null}
  </div>
}
