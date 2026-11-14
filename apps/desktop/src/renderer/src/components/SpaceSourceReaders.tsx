import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { SpaceMountRecord } from '../../../shared/space-mount'
import { WorkbenchDocumentContext, type WorkbenchDocument } from '../lib/workbench-document'
import { useMountedSpaceReader } from '../lib/use-space-mount-reader'
import { useWorkbenchDocumentVisibility } from '../lib/workbench-window-registry'

type Consumer = { key: string; target: SpaceMountRecord; document: WorkbenchDocument }
type Registration = { refresh(): void; release(): void }
type Readers = { register(target: SpaceMountRecord, document: WorkbenchDocument): Registration }
const Context = createContext<Readers | null>(null)
const sourceKey = (target: SpaceMountRecord) => JSON.stringify([target.hostId, target.reference.runtimeId, target.reference.spaceId])
const Source = memo(function Source({ entry, handles }: { entry: Consumer; handles: Map<string, () => void> }) {
  return <WorkbenchDocumentContext.Provider value={entry.document}><SourceReader entry={entry} handles={handles} /></WorkbenchDocumentContext.Provider>
})
function SourceReader({ entry, handles }: { entry: Consumer; handles: Map<string, () => void> }) {
  // The original hook reads the whole Source; a different visible Region must
  // not replace that same transport scope just because its input object differs.
  const target = useMemo(() => ({ ...entry.target, reference: { runtimeId: entry.target.reference.runtimeId, spaceId: entry.target.reference.spaceId } }), [entry.key])
  const refresh = useMountedSpaceReader(target, true)
  useLayoutEffect(() => {
    handles.set(entry.key, refresh)
    return () => { if (handles.get(entry.key) === refresh) handles.delete(entry.key) }
  }, [entry.key, handles, refresh])
  return null
}
function Owner({ children }: { children: ReactNode }) {
  // Reader custody only: no Session, policy, grant, Run or persistent facts live here.
  const [consumers, setConsumers] = useState(new Map<symbol, Consumer>())
  const handles = useRef(new Map<string, () => void>())
  const register = useCallback((target: SpaceMountRecord, document: WorkbenchDocument): Registration => {
    const key = sourceKey(target), token = Symbol('visible-source-reader')
    const entry: Consumer = { key, target, document }
    setConsumers(current => new Map(current).set(token, entry))
    return { refresh: () => handles.current.get(key)?.(), release: () => setConsumers(current => {
      if (!current.has(token)) return current
      const next = new Map(current); next.delete(token); return next
    }) }
  }, [])
  const value = useMemo(() => ({ register }), [register])
  const sources = useMemo(() => {
    const unique = new Map<string, Consumer>()
    for (const entry of consumers.values()) if (!unique.has(entry.key)) unique.set(entry.key, entry)
    return [...unique.values()]
  }, [consumers])
  return <Context.Provider value={value}>{sources.map(entry => <Source key={entry.key} entry={entry} handles={handles.current} />)}{children}</Context.Provider>
}
/** Share the original hook per visible source across ordinary and mounted Views. */
export function SpaceSourceReaders({ children }: { children: ReactNode }) {
  return useContext(Context) ? children : <Owner>{children}</Owner>
}
export function useSpaceSourceReader(target: SpaceMountRecord | undefined, visible: boolean): () => void {
  const owner = useContext(Context), documentContext = useContext(WorkbenchDocumentContext)
  const unsharedRefresh = useMountedSpaceReader(owner ? undefined : target, visible)
  const doc = documentContext?.document ?? document, key = target && sourceKey(target)
  const foreground = useWorkbenchDocumentVisibility(doc)
  const current = useRef<Registration | undefined>(undefined)
  useEffect(() => {
    if (!owner || !target || !visible || !foreground) return
    const registration = owner.register(target, documentContext ?? { document: doc, window: null })
    current.current = registration
    return () => { if (current.current === registration) current.current = undefined; registration.release() }
  }, [owner, key, visible, foreground, doc, documentContext])
  return useCallback(() => owner ? current.current?.refresh() : unsharedRefresh(), [owner, unsharedRefresh])
}
