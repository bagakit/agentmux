import { createContext, Fragment, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { WorkbenchDocumentContext } from '../lib/workbench-document'
import { WorkbenchPresentationContext, WorkbenchBrowserTargetsContext } from '../lib/workbench-presentation'
import { WorkbenchProjectionContext } from '../lib/workbench-projection'
import { MoteWorkfaceContext } from '../lib/mote-workface'
import { MoteDialogueViewContext } from '../lib/mote-dialogue-view'

type Entry = { content: ReactNode; listeners: Set<() => void> }
type Register = (regionId: string, entry: Entry) => () => void
const RegionOwners = createContext<Register | null>(null)
function RegionContent({ entry }: { entry: Entry }) {
  const subscribe = useCallback((listener: () => void) => { entry.listeners.add(listener); return () => { entry.listeners.delete(listener) } }, [entry])
  const snapshot = useCallback(() => entry.content, [entry])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** Window-local React ownership only. Moving a durable Region changes its slots and props, never its content tree. */
export function WorkbenchRegionOwners({ children }: { children: ReactNode }) {
  const entries = useRef(new Map<string, Entry>())
  const [, changed] = useState(0)
  const register = useCallback<Register>((regionId, entry) => {
    entries.current.set(regionId, entry); changed(value => value + 1)
    return () => {
      if (entries.current.get(regionId) !== entry) return
      entries.current.delete(regionId); changed(value => value + 1)
    }
  }, [])
  return <RegionOwners.Provider value={register}>{children}
    {[...entries.current].map(([regionId, entry]) => <Fragment key={regionId}><RegionContent entry={entry} /></Fragment>)}
  </RegionOwners.Provider>
}

/** Carry the original presentation contexts across the window's stable Region owner. No topology or resource copy is stored. */
export function WorkbenchRegionOwner({ regionId, children }: { regionId: string; children: ReactNode }) {
  const register = useContext(RegionOwners), document = useContext(WorkbenchDocumentContext)
  const presentation = useContext(WorkbenchPresentationContext), targets = useContext(WorkbenchBrowserTargetsContext)
  const projection = useContext(WorkbenchProjectionContext), mote = useContext(MoteWorkfaceContext)
  const dialogue = useContext(MoteDialogueViewContext)
  const [entry] = useState<Entry>(() => ({ content: null, listeners: new Set() }))
  const content = useMemo(() => <WorkbenchDocumentContext.Provider value={document}>
    <WorkbenchPresentationContext.Provider value={presentation}><WorkbenchBrowserTargetsContext.Provider value={targets}>
      <WorkbenchProjectionContext.Provider value={projection}><MoteWorkfaceContext.Provider value={mote}>
        <MoteDialogueViewContext.Provider value={dialogue}>{children}</MoteDialogueViewContext.Provider>
      </MoteWorkfaceContext.Provider></WorkbenchProjectionContext.Provider>
    </WorkbenchBrowserTargetsContext.Provider></WorkbenchPresentationContext.Provider>
  </WorkbenchDocumentContext.Provider>, [document, presentation, targets, projection, mote, dialogue, children])
  useLayoutEffect(() => register?.(regionId, entry), [register, regionId, entry])
  useLayoutEffect(() => { entry.content = content; for (const listener of entry.listeners) listener() }, [entry, content])
  // Standalone workbench clients can own their one tree directly; App supplies the window-wide owner.
  return register ? null : children
}
