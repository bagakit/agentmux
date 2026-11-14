import { useEffect, useRef, useState } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import { ContentCopyButton } from '@agentmux/client-ui/components/ContentCopyButton'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { parseAdoptedHostRoute, type HostRouteActor, type HostRouteEdges, type HostRouteIdentity } from '@agentmux/core/host-route'
import { Button } from '@agentmux/client-ui/components/Button'
import type { AppConfig, HostConfig } from '../../../../shared/contracts'
import type { DesktopHostRouteTarget } from '../../../../shared/host-routes'
import { configValuesEqual as equal } from '../../../../shared/config-edit'
import { api } from '../../lib/api'
import { hostRouteDraftDirty } from '../../lib/host-route-draft'
import { grantForRouteReceiver, parseHostRouteGrantRequest, ROUTE_DISCOVERY_SCOPES, ROUTE_WORK_SCOPES } from '../../lib/host-route-grant-request'
import { HostRoutePath } from './HostRoutePath'
import { useHostRoutePolicy } from './use-host-route-policy'
import { SettingsResourceLibrary } from './SettingsResourceLibrary'
import { SettingsSaveBar } from './SettingsSaveBar'
import { SelectionField } from '../SelectionField'
import './remote-routes.css'

const HostIcon = semanticIconComponent('object.host')

/** Select a saved carrier, then bind its actual Core identity before reading policy. */
export function RemoteRoutesPane({ config, active }: { config: AppConfig; active: boolean }) {
  const [hostId, setHostId] = useState(() => config.hosts.find(host => host.kind === 'local')?.id ?? '')
  const host = config.hosts.find(item => item.id === hostId)
  const carrierKey = host ? JSON.stringify((({ label: _label, ...value }) => value)(host)) : hostId
  const [identity, setIdentity] = useState<{ key: string; value?: HostRouteIdentity; issue?: string }>(), [refresh, setRefresh] = useState(0)
  useEffect(() => {
    if (!active || !host) return
    const controller = new AbortController()
    void api.hostRoutes.call({ hostId, ...(host.kind === 'ssh' && host.runtimeId ? { expectedRuntimeId: host.runtimeId } : {}) }, 'route.identity', {}, controller.signal).then(value => {
      if (!controller.signal.aborted) setIdentity({ key: carrierKey, value })
    }).catch(cause => { if (!controller.signal.aborted) setIdentity({ key: carrierKey, issue: presentError(cause) }) })
    return () => controller.abort()
  }, [active, carrierKey, refresh])
  const current = identity?.key === carrierKey ? identity : undefined
  return <div className="remote-routes">
    <div className="remote-work-intro"><h3>Routes between devices</h3><p>Follow saved connections directly or through other nodes. Each device controls who can pass through it.</p></div>
    <label className="host-route-owner"><span>Manage routes on</span><SelectionField label="Route policy device" menuClassName="host-route-owner__menu" value={hostId} options={config.hosts.map(item => ({ value: item.id, label: `${item.label} · ${item.kind === 'local' ? 'This device' : item.id}` }))} missingOptionLabel="Original saved device unavailable" missingOptionDescription={hostId} onValueChange={setHostId} /></label>
    {host && current?.value ? <RoutePolicyEditor key={carrierKey + current.value.runtimeId} host={host} identity={current.value} active={active} />
      : <div className="remote-routes-empty"><HostIcon size={24} aria-hidden="true" /><p role="status">{current?.issue ?? (host ? 'Reading this device’s route owner…' : 'Select its saved Host connection. Existing routes and edits are retained.')}</p><Button type="button" onClick={() => setRefresh(value => value + 1)}>Read route owner</Button></div>}
  </div>
}

function RoutePolicyEditor({ host, identity, active }: { host: HostConfig; identity: HostRouteIdentity; active: boolean }) {
  const target = { hostId: host.id, expectedRuntimeId: identity.runtimeId }
  const policy = useHostRoutePolicy(target, active), { edit, observed } = policy
  const [tab, setTab] = useState<'paths' | 'access'>('paths'), [selected, setSelected] = useState<number | null>(null)
  const [edges, setEdges] = useState<{ key: string; value: HostRouteEdges }>(), [edgeSelection, setEdgeSelection] = useState<{ key: string; id: string }>(), [edgeIssue, setEdgeIssue] = useState(''), [readingEdge, setReadingEdge] = useState(false)
  const [actor, setActor] = useState<HostRouteActor>(), [scope, setScope] = useState<'discover' | 'work'>('work'), [actionIssue, setActionIssue] = useState('')
  const edgeReader = useRef<AbortController | undefined>(undefined), edgeEpoch = useRef(0)
  const row = selected === null ? undefined : edit?.configuration.routes[selected], pathKey = JSON.stringify([selected, row?.route ?? null]), currentPath = useRef(pathKey)
  currentPath.current = pathKey
  const savedPrefix = row && observed?.routes.find(saved => equal(saved.route, row.route))
  const options = edges?.key === pathKey ? edges.value.edges : []
  const edgeId = edgeSelection?.key === pathKey ? edgeSelection.id : ''
  const selectedEdge = options.find(edge => edge.edgeId === edgeId)
  const scopes = scope === 'discover' ? ROUTE_DISCOVERY_SCOPES : ROUTE_WORK_SCOPES
  const request = row && actor ? { kind: 'host-route-access' as const, route: row.route, actor, scopes } : undefined
  function report(operation: () => void) { try { operation(); setActionIssue('') } catch (cause) { setActionIssue(presentError(cause)) } }
  function changeRoute(update: (route: NonNullable<typeof row>) => NonNullable<typeof row>) {
    if (!edit || selected === null || !row) return
    report(() => policy.change(current => {
      if (!equal(current.configuration.routes[selected]?.route, row.route)) throw Error('This route path changed during the edit. Current input and the original peer observation are retained.')
      return { ...current, configuration: { ...current.configuration,
        routes: current.configuration.routes.map((value, index) => index === selected ? update(value) : value) } }
    }))
  }
  function prefixTarget(): DesktopHostRouteTarget {
    if (!row) return target
    if (!savedPrefix) throw Error('Save this route explicitly before exploring its next node. No prefix was saved in the background.')
    return { hostId: host.id, expectedRuntimeId: row.route.hops.at(-1)!.target.runtimeId, via: { routeId: savedPrefix.id, adoptedRoute: savedPrefix.route } }
  }
  async function readEdges() {
    edgeReader.current?.abort(); const controller = new AbortController(); edgeReader.current = controller
    const token = ++edgeEpoch.current, key = pathKey; setEdgeIssue(''); setReadingEdge(true)
    try {
      const reply = await api.hostRoutes.call(prefixTarget(), 'route.edges', {}, controller.signal)
      if (!controller.signal.aborted && currentPath.current === key && edgeEpoch.current === token) { setEdges({ key, value: reply }); setActor(reply.actor); setEdgeSelection(undefined) }
    } catch (cause) { if (!controller.signal.aborted && currentPath.current === key) setEdgeIssue(presentError(cause)) }
    finally { if (edgeEpoch.current === token) setReadingEdge(false) }
  }
  useEffect(() => { if (active && selected === null) void readEdges(); return () => edgeReader.current?.abort() }, [active, pathKey])
  async function appendEdge() {
    if (!edit || !selectedEdge) { setEdgeIssue('The route path or its connection list changed. Choose a connection from the current path.'); return }
    edgeReader.current?.abort(); const controller = new AbortController(); edgeReader.current = controller
    const token = ++edgeEpoch.current, key = pathKey; setEdgeIssue(''); setReadingEdge(true)
    try {
      const reply = await api.hostRoutes.call(prefixTarget(), 'route.edge.inspect', { edgeId }, controller.signal)
      if (controller.signal.aborted || currentPath.current !== key || edgeEpoch.current !== token) return
      const route = parseAdoptedHostRoute({ source: row?.route.source ?? identity, hops: [...(row?.route.hops ?? []), { edgeId: reply.edge.edgeId, target: reply.target }] })
      setActor(reply.actor)
      if (row) changeRoute(value => ({ ...value, route }))
      else {
        let index = 0
        policy.change(current => { index = current.configuration.routes.length; return { ...current, configuration: { ...current.configuration, routes: [...current.configuration.routes, { id: '', route }] } } })
        setSelected(index)
      }
      setEdgeSelection(undefined)
    } catch (cause) { if (!controller.signal.aborted && currentPath.current === key) setEdgeIssue(presentError(cause)) }
    finally { if (edgeEpoch.current === token) setReadingEdge(false) }
  }
  const dirty = edit ? hostRouteDraftDirty(edit) : false
  const conflict = !!edit && !!observed && edit.baseline.revision !== observed.revision
  return <section className="host-route-editor" aria-label="Original Core route policy">
    <div className="host-route-toolbar"><div className="remote-work-tasks" role="group" aria-label="Route policy task">
      <button type="button" aria-pressed={tab === 'paths'} onClick={() => setTab('paths')}>Outgoing routes <span>{edit?.configuration.routes.length ?? '—'}</span></button>
      <button type="button" aria-pressed={tab === 'access'} onClick={() => setTab('access')}>Incoming access <span>{edit?.configuration.grants.length ?? '—'}</span></button>
    </div><Button type="button" onClick={() => void policy.inspect()}>Read saved policy</Button></div>
    {policy.issue ? <p className="settings-inline-error" role="status">{policy.issue}</p> : null}
    {!edit ? <p>Reading the saved policy. Existing work stays available.</p> : <>
      {tab === 'paths' ? <div className="host-route-layout" data-empty-routes={edit.configuration.routes.length === 0}>
        <div className="host-route-library" hidden={edit.configuration.routes.length === 0}><SettingsResourceLibrary label="Saved and draft routes" selectedId={selected === null ? null : String(selected)} focusRequest={null}
          onSelect={value => { setSelected(Number(value)); setActionIssue(''); setEdgeIssue('') }} items={edit.configuration.routes.map((value, index) => ({ id: String(index), name: value.id || 'Unnamed route',
            detail: `${value.route.hops.length === 1 ? 'Direct' : `${value.route.hops.length} hops`} · ${observed?.routes.some(saved => equal(saved, value)) ? 'Saved configuration' : 'Unsaved edit'}`, mark: <HostIcon size={18} /> }))} />
          <Button type="button" onClick={() => { setSelected(null); setActionIssue(''); setEdgeIssue('') }}>New route</Button>
        </div>
        <div className="host-route-detail">
          {row ? <>
            <label className="host-route-field"><span>Route name</span><TextInput aria-label="Route name" value={row.id} placeholder="A short, memorable name" onChange={event => changeRoute(value => ({ ...value, id: event.target.value }))} /></label>
            <HostRoutePath route={row.route} sourceLabel={host.label} />
            <p className="host-route-caption">{savedPrefix ? 'Saved path' : 'Draft path'} · {row.route.hops.length === 1 ? 'direct' : `${row.route.hops.length} logical hops`}. Access is checked by each node when used.</p>
            <div className="host-route-inline-actions"><Button type="button" onClick={() => {
              if (row.route.hops.length > 1) changeRoute(value => ({ ...value, route: { ...value.route, hops: value.route.hops.slice(0, -1) } }))
              else report(() => { policy.change(current => ({ ...current, configuration: { ...current.configuration, routes: current.configuration.routes.filter((_, index) => index !== selected) } })); setSelected(null) })
            }}>{row.route.hops.length > 1 ? 'Remove last node' : 'Remove route'}</Button>
              <Button type="button" onClick={() => void readEdges()}>Explore next node</Button></div>
            {!savedPrefix ? <p className="settings-group-note">Save this path before exploring further. Browsing never saves or grants access.</p> : null}
          </> : <div className="host-route-new"><HostIcon size={28} aria-hidden="true" /><h4>Choose the first connection</h4><p>Start from a saved Host on {host.label}. Inspecting its identity does not trust it or start an Agent.</p></div>}
          <div className="host-route-edge-picker"><label className="host-route-field"><span>{row ? 'Next saved connection' : 'Saved connection'}</span><SelectionField label="Next saved route connection" value={edgeId} options={[{ value: '', label: readingEdge ? 'Reading this node…' : options.length ? 'Choose a connection' : 'Read this node’s connections' }, ...options.map(edge => ({ value: edge.edgeId, label: `${edge.label} · ${edge.edgeId}` }))]} onValueChange={id => setEdgeSelection({ key: pathKey, id })} /></label><Button type="button" disabled={!selectedEdge || readingEdge} onClick={() => void appendEdge()}>Inspect &amp; add</Button>
            {!row ? <Button type="button" onClick={() => void readEdges()}>Read connections</Button> : null}</div>
          {edgeIssue ? <p className="settings-inline-error" role="status">{edgeIssue} Your path is retained.</p> : null}
          {request ? <details className="host-route-access-request"><summary>Request access along this route</summary><p>Each receiving device approves the original actor and purpose. Send this public request to its owner; copying it changes no policy.</p>
            <label className="host-route-field"><span>Purpose</span><SelectionField label="Route access purpose" value={scope} options={[{ value: 'discover', label: 'Discover saved next connections' }, { value: 'work', label: 'Agent work, Space, terminal and input' }]} searchable={false} onValueChange={value => setScope(value as typeof scope)} /></label>
            <ContentCopyButton text={JSON.stringify(request, null, 2)} identity={JSON.stringify(request)} label="Copy public access request" />
            <details><summary>Public identities and exact permissions</summary><pre>{JSON.stringify(request, null, 2)}</pre></details>
          </details> : row ? <p className="settings-group-note">Read this route’s next connections to obtain its actual actor for an access request.</p> : null}
        </div>
      </div> : <div className="host-route-access">
        <h4>Who may pass through {host.label}?</h4><p>A Host connection does not grant transit. These permissions apply only at this node.</p>
        {edit.configuration.grants.map(grant => <div className="host-route-grant" key={grant.id}><div><strong>{equal(grant.scopes, ROUTE_DISCOVERY_SCOPES) ? 'Connection discovery' : equal(grant.scopes, ROUTE_WORK_SCOPES) ? 'Agent and project work' : 'Custom access'}</strong><small>{grant.actor.kind} · {grant.actor.id}</small><details><summary>Identities and {grant.scopes.length} exact permissions</summary><p>Permission <code>{grant.id}</code><br />Via <code>{grant.delegator.runtimeId}</code><br />To <code>{grant.destination.runtimeId}</code><br />Original actor Core <code>{grant.actor.source.runtimeId}</code></p><ul>{grant.scopes.map(value => <li key={value}>{value}</li>)}</ul></details></div>
          <Button type="button" onClick={() => report(() => policy.change(current => ({ ...current, configuration: { ...current.configuration, grants: current.configuration.grants.filter(value => value.id !== grant.id) } })))} >Remove permission</Button></div>)}
        {!edit.configuration.grants.length ? <p className="host-route-caption">No transit permissions saved in this edit.</p> : null}
        <label className="host-route-field"><span>Public access request</span><textarea aria-label="Public route access request" rows={5} value={edit.grantRequestText ?? ''} placeholder="Paste the request copied from the source route" onChange={event => report(() => policy.change(current => ({ ...current, grantRequestText: event.target.value })))} /></label>
        <Button type="button" onClick={() => report(() => { const request = parseHostRouteGrantRequest(JSON.parse(edit.grantRequestText ?? ''))
          const grant = grantForRouteReceiver(request, identity, 'access-' + crypto.randomUUID())
          policy.change(current => ({ ...current, configuration: { ...current.configuration, grants: [...current.configuration.grants, grant] } }))
        })}>Add to this node’s edit</Button><p className="settings-group-note">Review the identities and permissions above, then Save policy to approve them.</p>
      </div>}
      {actionIssue ? <p className="settings-inline-error" role="status">{actionIssue}</p> : null}
      {conflict ? <div className="host-route-conflict" role="status"><p>The saved policy changed since this edit began. Both versions are retained.</p><Button type="button" onClick={() => policy.rebase(true)}>Use saved policy</Button><Button type="button" onClick={() => policy.rebase(false)}>Keep edits over saved policy</Button></div> : null}
      <SettingsSaveBar dirty={dirty} scopeLabel="Route policy" label="Save policy" onSave={() => void policy.save()}
        save={{ state: policy.busy ? 'saving' : 'idle', saving: policy.busy, error: '' }} />
      {edit.retainedSaves.length ? <details className="host-route-original-saves"><summary>{edit.retainedSaves.length} retained save {edit.retainedSaves.length === 1 ? 'request' : 'requests'}</summary>
        <p>Read this same policy to check the original request. A later observation does not replace its original save acknowledgment. No request is retried automatically.</p>
        {edit.retainedSaves.map(({ input, notSent, refusal }) => <p key={input.operationId}><code>{input.operationId}</code> · {notSent ? 'Not sent; original edit retained' : refusal ? `Refused by the original Core · ${refusal.code}: ${refusal.message}` : observed?.operation?.operationId === input.operationId ? 'Observed at this owner; original acknowledgment unavailable' : 'Original result not observed'}</p>)}
      </details> : null}
      <details className="host-route-owner-details"><summary>Original policy identity</summary><dl><dt>Runtime</dt><dd>{identity.runtimeId}</dd><dt>Key fingerprint</dt><dd>{identity.fingerprint}</dd><dt>Saved revision</dt><dd>{observed?.revision ?? 'Not observed'}</dd></dl></details>
    </>}
  </section>
}
