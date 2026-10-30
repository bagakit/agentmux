import { MoteDialogueViewProvider } from '../lib/mote-dialogue-view'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { type MoteWorkfaceScope, useMoteWorkfaceScope } from '../lib/mote-workface'
import { useSpaceContentPresentation } from '../lib/space-content-presentation'
import { MoteFirstCooperation } from './MoteFirstCooperation'
import { SidebarToggleChrome, WindowSidebarLayoutContext } from './TopRowChrome'
import { useAppStore } from '../store'
import { SurfaceModeSwitch } from './SurfaceModeSwitch'
import { showMoteConversation } from '../lib/mote-conversation-mode'
import { MoteCooperation } from './MoteCooperation'

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
  return <MoteDialogueViewProvider scope={scope} active={visible}><MoteSpaceContext.Provider value={scope && presentation ? { topicId: scope.topic.id, section, select } : null}>
    <WindowSidebarLayoutContext.Provider value={sidebars ? { ...sidebars, chromeInFrame: visible } : null}>
    <div className="mote-space-frame" data-mote-space={visible ? scope.topic.id : undefined} data-mote-page={visible ? section : undefined}>
      {scope && presentation ? <header className="mote-space-frame__header" hidden={!visible}>
        <div className="mote-space-frame__navigation">
        {!projectRailOpen ? <SidebarToggleChrome /> : null}
        <span className="mote-space-frame__name" title={scope.topic.title}>{scope.topic.title}</span>
        <SurfaceModeSwitch value={section} active={visible} ariaLabel="Mote pages" onChange={select}
          options={[{ value: 'profile', label: 'Profile' }, { value: 'discussion', label: 'Discussion' }, { value: 'ideas', label: 'Ideas' }, { value: 'calendar', label: 'Calendar' }]} />
        </div>
        <MoteSpaceActions key={owner} scope={scope} active={visible} section={section} onDiscussion={() => select('discussion')} />
      </header> : null}
      {children}
    </div>
    </WindowSidebarLayoutContext.Provider>
  </MoteSpaceContext.Provider></MoteDialogueViewProvider>
}

/** Entry controls navigate original work; the shared Composer remains its only input. */
function MoteSpaceActions({ scope, active, section, onDiscussion }: {
  scope: MoteWorkfaceScope; active: boolean; section: MoteSpaceSection; onDiscussion(): void
}) {
  const selected = useAppStore(state => active ? state.workbenchSpaceSelection : null)
  const selectedReference = selected?.groupId && selected.tabId && selected.regionId
    ? { displayWorkspaceId: selected.workspaceId, groupId: selected.groupId, tabId: selected.tabId, regionId: selected.regionId } : null
  return <MoteCooperation scope={scope} active={active} presentation="navigation" reference={section === 'discussion' ? selectedReference : null}
    onSelect={reference => {
      const state = useAppStore.getState()
      if (!state.selectMainRegion(reference, state.workbenchSpaceSelection)) return false
      onDiscussion(); showMoteConversation(scope, { reference }); return true
    }} actions={<MoteFirstCooperation scope={scope} disclosure />} />
}
