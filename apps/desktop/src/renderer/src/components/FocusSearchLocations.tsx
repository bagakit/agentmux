import type { AgentSessionHistoryDescriptor } from '@agentmux/core'
import type { searchFocus, FocusSearchLocation } from '../lib/focus-search'

/** Original object results do not change execution-card or Mote classification. */
export function FocusSearchLocations({ result, onSelect, onRead, describeLocation }: {
 describeLocation(location: FocusSearchLocation): string
 result: ReturnType<typeof searchFocus>; onSelect(location: FocusSearchLocation): void
 onRead?: (source: AgentSessionHistoryDescriptor) => void
}) {
 return <>
  {result.issue ? <p role="status" className="focus-project-lanes__empty">{result.issue}</p> : null}
  {result.locations.length ? <section className="focus-search-locations" aria-label="Matching original locations"><small title="Original locations are independent of execution project and state filters.">All matching locations · {result.locations.length}</small>{result.locations.map(location => <button type="button" className="focus-location-choice small-button" key={location.address} onClick={() => onSelect(location)} title={`${location.reference.displayWorkspaceId} / ${location.reference.groupId} / ${location.reference.tabId} / ${location.reference.regionId}`}><strong>{location.name}</strong><small>{describeLocation(location)} · {location.kind} · {location.reference.tabId} / {location.reference.regionId}</small></button>)}</section> : null}
  {result.unplaced.length ? <div className="focus-search-locations" aria-label="Objects without confirmed locations">{result.unplaced.map(object => <div key={`${object.kind}:${object.id}`}><strong>{object.name}</strong><small>{object.kind} · {object.id} · No confirmed open location</small></div>)}</div> : null}
  {result.sources.length ? <div className="focus-search-locations" aria-label="Matching retained conversations">{result.sources.map(source => <div key={`${source.hostId}:${source.agentSessionId}`}><strong>{source.agentSessionId}</strong><small>Current retained native: {source.history?.nativeHandle?.sessionId ?? 'unavailable'} · {source.history?.workspacePath ?? source.hostId} · Recorded conversation</small>{source.history?.observedNativeHandle ? <small>Observed native: {source.history.observedNativeHandle.sessionId}</small> : null}{source.history?.previousNativeHandle ? <small>Previous native: {source.history.previousNativeHandle.sessionId}</small> : null}{onRead ? <button type="button" className="small-button" onClick={() => onRead(source)}>Read conversation</button> : null}</div>)}</div> : null}
 </>
}
