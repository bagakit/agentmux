import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { MoteDialogueViewProvider } from '../lib/mote-dialogue-view'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { moteConnectionTarget } from '../lib/mote-connection-default'
import { useMoteWorkfaceScope } from '../lib/mote-workface'
import { useSpaceContentPresentation } from '../lib/space-content-presentation'
import { SidebarToggleChrome, WindowSidebarLayoutContext } from './TopRowChrome'
import { useAppStore } from '../store'
import { SurfaceModeSwitch } from './SurfaceModeSwitch'
import { MoteConversationIdentity } from './MoteConversationIdentity'

const ThreadsIcon = semanticIconComponent('object.conversations')

export type MoteContentSection = 'profile' | 'ideas' | 'calendar'
export type MoteSpaceSection = MoteContentSection | 'discussion' | 'threads'
const MoteSpaceContext = createContext<{
  actionsHost: HTMLSpanElement | null
  topicId: string
  section: MoteSpaceSection
  entryToken?: string | undefined
  threadReference?: WorkbenchProjectionSelection | undefined
  threadEvent?: { eventId: string; token: string } | undefined
  navigationRevision: number
  select(section: MoteSpaceSection, reference?: WorkbenchProjectionSelection): void
} | null>(null)
export const useMoteSpace = () => useContext(MoteSpaceContext)

/** Local presentation only. The original workbench subtree stays in place in every mode. */
export function MoteSpaceFrame({ workspaceId, active, children }: {
  workspaceId: string | undefined; active: boolean; children: ReactNode
}) {
  const [actionsHost, setActionsHost] = useState<HTMLSpanElement | null>(null)
  const scope = useMoteWorkfaceScope(workspaceId, undefined, active)
  const presentation = useSpaceContentPresentation()
  const bindings = useAppStore(state => state.spaceZoneBindings)
  const objectTarget = scope ? moteConnectionTarget(scope, bindings) : null
  const preferredProjects = useAppStore(state => state.projectRailOpen)
  const sidebars = useContext(WindowSidebarLayoutContext)
  const projectRailOpen = sidebars?.projectRailOpen ?? preferredProjects
  const owner = scope ? JSON.stringify([scope.workspace.hostId, scope.workspace.id, scope.workspace.path, scope.topic.id, scope.rootPath]) : ''
  const [content, setContent] = useState<{ owner: string; section: MoteSpaceSection; revision: number; entryToken?: string; threadReference?: WorkbenchProjectionSelection; threadEvent?: { eventId: string; token: string } }>({ owner, section: 'discussion', revision: 0 })
  const consumedEntry = useRef<string | undefined>(undefined)
  const explicitEntry = useAppStore(state => state.moteDiscussionEntry)
  useEffect(() => {
    if (!active || !scope || explicitEntry?.workspaceId !== scope.workspace.id || explicitEntry.topicId !== scope.topic.id || consumedEntry.current === explicitEntry.token) return
    consumedEntry.current = explicitEntry.token
    setContent(previous => ({ owner, section: explicitEntry.memberReference || explicitEntry.eventId !== undefined ? 'threads' : 'discussion', revision: previous.revision + 1,
      ...(explicitEntry.memberReference ? { threadReference: explicitEntry.memberReference } : explicitEntry.eventId !== undefined ? { threadEvent: { eventId: explicitEntry.eventId, token: explicitEntry.token } } : { entryToken: explicitEntry.token }) }))
    presentation?.collapse()
  }, [explicitEntry?.token, owner, active])
  const section: MoteSpaceSection = presentation?.expanded ? content.owner === owner && !['discussion', 'threads'].includes(content.section) ? content.section : 'profile' : content.owner === owner && content.section === 'threads' ? 'threads' : 'discussion'
  const select = (next: MoteSpaceSection, reference?: WorkbenchProjectionSelection) => {
    setContent(previous => ({ owner, section: next, revision: previous.revision + 1, ...(next === 'discussion' ? { entryToken: crypto.randomUUID() } : {}),
      ...(next === 'threads' && reference ? { threadReference: reference } : {}) }))
    if (next === 'discussion' || next === 'threads') presentation?.collapse()
    else presentation?.expand()
  }
  const visible = active && scope !== null && presentation !== null
  return <MoteDialogueViewProvider scope={scope} active={visible}><MoteSpaceContext.Provider value={scope && presentation ? { actionsHost, topicId: scope.topic.id, section, select, navigationRevision: content.revision, threadReference: content.owner === owner && section === 'threads' ? content.threadReference : undefined, threadEvent: content.owner === owner && section === 'threads' ? content.threadEvent : undefined, entryToken: content.owner === owner && section === 'discussion' ? content.entryToken : undefined } : null}>
    <WindowSidebarLayoutContext.Provider value={sidebars ? { ...sidebars, chromeInFrame: visible } : null}>
    <div className="mote-space-frame" data-mote-space={visible ? scope.topic.id : undefined} data-mote-space-id={visible ? objectTarget?.spaceId : undefined} data-mote-page={visible ? section : undefined}>
      {scope && presentation ? <header className="mote-space-frame__header" hidden={!visible}>
        <div className="mote-space-frame__navigation">
        {!projectRailOpen ? <SidebarToggleChrome /> : null}
        <MoteConversationIdentity scope={scope} visible={visible} />
        <SurfaceModeSwitch value={section} active={visible} ariaLabel="Mote pages" onChange={next => select(next)}
          options={[{ value: 'profile', label: 'Profile' }, { value: 'discussion', label: 'Discussion' }, { value: 'threads', label: <><ThreadsIcon size={13} aria-hidden="true" />Threads</> }, { value: 'ideas', label: 'Ideas' }, { value: 'calendar', label: 'Calendar' }]} />
        </div>
        <span className="mote-main-slot" ref={setActionsHost} />
      </header> : null}
      {children}
    </div>
    </WindowSidebarLayoutContext.Provider>
  </MoteSpaceContext.Provider></MoteDialogueViewProvider>
}
