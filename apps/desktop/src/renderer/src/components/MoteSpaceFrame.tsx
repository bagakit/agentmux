import { createContext, useContext, useState, type ReactNode } from 'react'
import { useMoteWorkfaceScope } from '../lib/mote-workface'
import { useSpaceContentPresentation } from '../lib/space-content-presentation'
import { MoteFirstCooperation } from './MoteFirstCooperation'
import { SidebarToggleChrome, WindowSidebarLayoutContext } from './TopRowChrome'
import { useAppStore } from '../store'
import { SurfaceModeSwitch } from './SurfaceModeSwitch'

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
        <div className="mote-space-frame__question">
          <MoteFirstCooperation key={owner} scope={scope} />
        </div>
      </header> : null}
      {children}
    </div>
    </WindowSidebarLayoutContext.Provider>
  </MoteSpaceContext.Provider>
}
