import type { AgentSessionHistoryDescriptor } from '@agentmux/core'
import { Button } from '@agentmux/client-ui/components/Button'
import type { searchFocus, FocusSearchLocation } from '../lib/focus-search'

type SearchResult = ReturnType<typeof searchFocus>
const kindName = (kind: string) => kind.charAt(0).toUpperCase() + kind.slice(1)
/** Known identity equality only demotes a display fallback; it never changes matching. */
export const focusSearchResultName = (name: string | undefined, ids: readonly (string | null)[]) => name?.trim() && !ids.includes(name) ? name : undefined

/** Original object results share one reading area; details never change their targets. */
export function FocusSearchLocations({ result, onSelect, onRead, describeLocation, nameLocation, nameSource, nameUnplaced }: {
 describeLocation(location: FocusSearchLocation): string
 nameLocation?(location: FocusSearchLocation): string | undefined
 nameSource?(source: AgentSessionHistoryDescriptor): string | undefined
 nameUnplaced?(object: SearchResult['unplaced'][number]): string | undefined
 result: SearchResult; onSelect(location: FocusSearchLocation): void
 onRead?: (source: AgentSessionHistoryDescriptor) => void
}) {
 const count = result.locations.length + result.unplaced.length + result.sources.length
 if (!count && !result.issue) return null
 return <section className="focus-search-results" aria-label="Search results">
  <header><strong>Search results</strong><span>{count}</span><small>Independent of context filters</small></header>
  {result.issue ? <p role="status" className="focus-search-results__issue">{result.issue}</p> : null}
  {count ? <div className="focus-search-locations">
   {result.locations.length ? <section className="focus-search-section" aria-label="Matching original locations"><h3>Open locations <span>{result.locations.length}</span></h3>{result.locations.map(location => <article className="focus-search-result" data-focus-search-result="location" data-focus-search-address={location.address} key={location.address}>
    <button type="button" className="focus-location-choice" onClick={() => onSelect(location)}><span><strong>{focusSearchResultName(nameLocation?.(location), [location.reference.regionId, location.reference.tabId, location.sessionId]) ?? focusSearchResultName(location.name, [location.reference.regionId, location.reference.tabId, location.sessionId]) ?? kindName(location.kind)}</strong><small>{describeLocation(location)} · {kindName(location.kind)}</small></span><span className="focus-search-result__action">Open</span></button>
    <details className="focus-search-details"><summary>Location details</summary><dl>
     <div><dt>Original name</dt><dd>{location.name}</dd></div><div><dt>Address</dt><dd>{location.address}</dd></div>
     <div><dt>Workspace</dt><dd>{location.reference.displayWorkspaceId}</dd></div><div><dt>Group</dt><dd>{location.reference.groupId}</dd></div>
     <div><dt>Tab</dt><dd>{location.reference.tabId}</dd></div><div><dt>Region</dt><dd>{location.reference.regionId}</dd></div>
     {location.sessionId ? <div><dt>Session</dt><dd>{location.sessionId}</dd></div> : null}
    </dl></details>
   </article>)}</section> : null}
   {result.unplaced.length ? <section className="focus-search-section" aria-label="Objects without confirmed locations"><h3>No confirmed location <span>{result.unplaced.length}</span></h3>{result.unplaced.map(object => <article className="focus-search-result" data-focus-search-result="unplaced" key={`${object.kind}:${object.id}`}>
    <div className="focus-search-result__identity"><strong>{focusSearchResultName(nameUnplaced?.(object) ?? object.name, [object.id]) ?? kindName(object.kind)}</strong><small>{kindName(object.kind)} · No confirmed open location</small></div>
    <details className="focus-search-details"><summary>Object details</summary><dl><div><dt>Original name</dt><dd>{object.name}</dd></div><div><dt>Kind</dt><dd>{object.kind}</dd></div><div><dt>Original ID</dt><dd>{object.id}</dd></div></dl></details>
   </article>)}</section> : null}
   {result.sources.length ? <section className="focus-search-section" aria-label="Matching retained conversations"><h3>Recorded conversations <span>{result.sources.length}</span></h3>{result.sources.map(source => <article className="focus-search-result" data-focus-search-result="conversation" data-focus-search-source={JSON.stringify([source.hostId, source.agentSessionId])} key={JSON.stringify([source.hostId, source.agentSessionId])}>
    <div className="focus-search-result__identity"><strong>{focusSearchResultName(nameSource?.(source), [source.agentSessionId]) ?? 'Recorded conversation'}</strong><small>{source.hostId} · {source.state} · {source.history?.workspacePath ?? 'Original path unrecorded'}</small></div>
    <details className="focus-search-details"><summary>Source details</summary><dl>
     <div><dt>Host</dt><dd>{source.hostId}</dd></div><div><dt>Session</dt><dd>{source.agentSessionId}</dd></div>
     <div><dt>Workspace</dt><dd>{source.history?.workspacePath ?? 'Unrecorded'}</dd></div>
     <div><dt>Current native</dt><dd>{source.history?.nativeHandle?.sessionId ?? 'Unavailable'}</dd></div>
     {source.history?.observedNativeHandle ? <div><dt>Observed native</dt><dd>{source.history.observedNativeHandle.sessionId}</dd></div> : null}
     {source.history?.previousNativeHandle ? <div><dt>Previous native</dt><dd>{source.history.previousNativeHandle.sessionId}</dd></div> : null}
    </dl></details>
    {onRead ? <Button type="button" className="focus-search-result__read" onClick={() => onRead(source)}>Read conversation</Button> : null}
   </article>)}</section> : null}
  </div> : null}
 </section>
}
