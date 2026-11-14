import { useEffect, useRef, useState } from 'react'
import type { AgentMuxRpcResult, SpaceSnapshot } from '@agentmux/core'
import type { HostRouteAgentTarget, HostRouteChoices, HostRouteExecutors } from '@agentmux/core/host-route'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../lib/api'
import { checkpointMountedSpaceInputs, useAppStore } from '../store'
import { mountedAgentOpenInput, mountedAgentOpenKey, mountedLauncherSelection, type MountedAgentOpenInput, type MountedLauncherSlot } from '../lib/space-mount-launch'
import type { SpaceMountHostChoices, SpaceMountRecord } from '../../../shared/space-mount'
import { ExecutionRouteLink } from './AgentExecutionRelation'

/** The original Space accepts this business request; this Window owns only its unsent selection and frozen intent. */
type MountedSpaceLauncherProps = {
  target: SpaceMountRecord; project: SpaceSnapshot['scope']['zones'][number] | undefined; slot: MountedLauncherSlot; mountKey: string; active: boolean; draft?: string
}
export function MountedSpaceLauncher(props: MountedSpaceLauncherProps) {
  return <MountedSpaceLauncherContent key={mountedAgentOpenKey(props.target,props.slot)} {...props} />
}
function MountedSpaceLauncherContent({ target, project, slot, mountKey, active, draft }: MountedSpaceLauncherProps) {
  const inputs = useAppStore(state => state.mountedSpaceInputs), key = mountedAgentOpenKey(target, slot)
  let selection: ReturnType<typeof mountedLauncherSelection>, original: ReturnType<typeof mountedAgentOpenInput>, unreadable: string | undefined
  try { selection = mountedLauncherSelection(inputs, mountKey, slot); original = mountedAgentOpenInput(inputs, key) }
  catch (cause) { unreadable = presentError(cause) }
  const projectTarget = project ? { ...target, zoneId: project.zoneId, workspaceId: project.workspaceId } : undefined
  const prompt = slot.kind === 'region' ? draft ?? '' : selection?.prompt ?? ''
  const agentHostId = selection?.agentHostId ?? project?.hostId ?? '', executorId = selection?.executorId ?? '', sourceKey = JSON.stringify([target.hostId, target.reference])
  const [choices, setChoices] = useState<SpaceMountHostChoices>(), [choicesIssue, setChoicesIssue] = useState<string>()
  const [routes, setRoutes] = useState<HostRouteChoices>(), [routesIssue, setRoutesIssue] = useState<string>()
  const [directInventory, setDirectInventory] = useState<AgentMuxRpcResult<'settings.executors.discover'>>()
  const [routedInventory, setRoutedInventory] = useState<HostRouteExecutors>(), [inventoryIssue, setInventoryIssue] = useState<string>(), [refresh, setRefresh] = useState(0)
  const routeTarget = selection?.agentTarget, routeKey = JSON.stringify(routeTarget), choiceKey = JSON.stringify(routeTarget ? ['route', routeTarget] : ['host', agentHostId])
  const inventory = routeTarget ? routedInventory?.inventory : directInventory
  const [inFlight, setInFlight] = useState(() => new Map<string, symbol>()), producer = useRef(inFlight)
  const busy = Boolean(original && inFlight.has(original.request.operationId))
  const [issue, setIssue] = useState<string>(), [inspection, setInspection] = useState<AgentMuxRpcResult<'space.inspect'>>()
  const inspectionReader = useRef<AbortController | undefined>(undefined)
  useEffect(() => {
    if (!active) return
    const controller = new AbortController(); setChoices(undefined); setChoicesIssue(undefined)
    void api.spaceMounts.call('hostChoices', { hostId: target.hostId, reference: target.reference }, controller.signal).then(reply => {
      if (!controller.signal.aborted) setChoices(reply)
    }).catch(cause => { if (!controller.signal.aborted) setChoicesIssue(presentError(cause)) })
    return () => controller.abort()
  }, [sourceKey, active, refresh])
  useEffect(() => {
    if (!active) return
    const controller = new AbortController(); setRoutesIssue(undefined)
    void api.spaceMounts.call('routeChoices', { hostId: target.hostId, reference: target.reference }, controller.signal).then(reply => {
      if (!controller.signal.aborted) setRoutes(reply)
    }).catch(cause => { if (!controller.signal.aborted) setRoutesIssue(presentError(cause)) })
    return () => controller.abort()
  }, [sourceKey, active, refresh])
  useEffect(() => {
    if (!active || !agentHostId) return
    const controller = new AbortController(); setDirectInventory(undefined); setRoutedInventory(undefined); setInventoryIssue(undefined)
    const request = routeTarget
      ? api.spaceMounts.call('routeExecutors', { hostId: target.hostId, reference: target.reference, agentTarget: routeTarget }, controller.signal).then(reply => { if (!controller.signal.aborted) setRoutedInventory(reply) })
      : api.spaceMounts.call('executors', { hostId: target.hostId, reference: target.reference, agentHostId }, controller.signal).then(reply => { if (!controller.signal.aborted) setDirectInventory(reply) })
    void request.catch(cause => { if (!controller.signal.aborted) setInventoryIssue(presentError(cause)) })
    return () => controller.abort()
  }, [sourceKey, active, agentHostId, routeKey, refresh])
  useEffect(() => () => inspectionReader.current?.abort(), [sourceKey, active])
  function choose(host: string, executor: string, agentTarget?: HostRouteAgentTarget) {
    try { useAppStore.getState().editSpaceMountLauncher(mountKey, slot, { ...selection, agentHostId: host, agentTarget, executorId: executor }); setIssue(undefined) }
    catch (cause) { setIssue(presentError(cause)) }
  }
  async function send(input: MountedAgentOpenInput, continueOriginal = false) {
    const operationId = input.request.operationId
    if (producer.current.has(operationId) || input.submitted && !continueOriginal) return
    const token = Symbol(operationId), pending = new Map(producer.current)
    pending.set(operationId, token); producer.current = pending; setInFlight(pending); setIssue(undefined)
    const store = useAppStore.getState(), retained = { ...input, submitted: true }; delete retained.issue
    let dispatched = false
    try {
      store.retainSpaceMountAgentOpen(key, current => current && current.request !== input.request ? current : retained)
      await checkpointMountedSpaceInputs()
      if (mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, key)?.request !== input.request) throw Error('The retained original request changed before dispatch. No substitute request was sent.')
      dispatched = true
      const receipt = await api.spaceMounts.call('open', { hostId: input.target.hostId, reference: input.target.reference, request: input.request })
      if (receipt.operationId !== input.request.operationId) throw Error('The response belongs to another original task. Keep the original request and check its source.')
      store.retainSpaceMountAgentOpen(key, current => current?.request === input.request ? { ...current, receipt } : current)
    } catch (cause) {
      const message = `${dispatched ? 'The original task result is unknown.' : input.submitted ? 'The original task was not continued. Its earlier result remains unconfirmed.' : 'The task was not sent.'} ${presentError(cause)}`
      try {
        store.retainSpaceMountAgentOpen(key, current => current?.request === input.request ? { ...current, submitted: input.submitted || dispatched, issue: message } : current)
        if (mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, key)?.request === input.request) setIssue(message)
      } catch { /* Preserve an unreadable/future intent instead of replacing its original bytes. */ }
    } finally {
      if (producer.current.get(operationId) === token) {
        const remaining = new Map(producer.current); remaining.delete(operationId)
        producer.current = remaining; setInFlight(remaining)
      }
    }
  }
  async function create() {
    if (original || !canStart || !projectTarget || !inventory) return
    const input: MountedAgentOpenInput = { kind: 'agent-open', target: projectTarget, slot, submitted: false,
      request: { operationId: crypto.randomUUID(), content: { kind: 'new-agent', executorId, agentTarget: routeTarget ? routedInventory!.agentTarget : { hostId: agentHostId, runtimeId: inventory.runtimeId }, ...(prompt ? { prompt } : {}) },
        destination: { spaceId: target.reference.spaceId, zoneId: projectTarget.zoneId, newTab: true }, focus: false } }
    await send(input)
  }
  async function inspect() {
    if (!original) return
    inspectionReader.current?.abort(); const controller = new AbortController(); inspectionReader.current = controller
    try { const reply = await api.spaceMounts.call('inspect', { hostId: original.target.hostId, reference: original.target.reference, requestId: original.request.operationId }, controller.signal)
      if (!controller.signal.aborted && mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, key)?.request === original.request) { setInspection(reply); setIssue(undefined) }
    } catch (cause) {
      try {
        if (!controller.signal.aborted && mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, key)?.request === original.request) setIssue(presentError(cause))
      } catch { /* Preserve an unreadable/future intent instead of attaching an old read error to it. */ }
    }
  }
  const executor = inventory?.executors.find(entry => entry.executorId === executorId)
  const observedReport = inspection?.request?.known && inspection.request.report?.operationId === original?.request.operationId ? inspection.request.report : undefined
  const retired = original?.receipt?.outcome === 'retired' || observedReport?.outcome === 'retired'
  const completed = !retired && (original?.receipt?.outcome === 'opened' || observedReport?.outcome === 'opened')
  const terminalObservation = completed || retired
  const targetMatches = routeTarget ? JSON.stringify(routedInventory?.agentTarget) === routeKey : directInventory?.routeHostId === agentHostId
  const canStart = active && !unreadable && !!projectTarget && targetMatches && Boolean(executor)
  return <div className="mounted-space-launcher" aria-label="New work in original Space">
    <div className="mounted-space-launcher__project"><small>Project device · original Space</small><code>{project?.directoryPath ?? 'Original project directory unobserved'}</code></div>
    <div className="mounted-space-launcher__fields">
      <label><span>Agent device</span><select aria-label="Original Space Agent device" value={choiceKey} disabled={!!unreadable} onChange={event => {
        const route = routes?.routes.find(route => JSON.stringify(['route', route.agentTarget]) === event.target.value)
        if (route) choose(route.agentTarget.hostId, '', route.agentTarget)
        else if (event.target.value === JSON.stringify(['host', 'local'])) choose('local', '')
        else { const host = choices?.hosts.find(host => JSON.stringify(['host', host.hostId]) === event.target.value); if (host) choose(host.hostId, '') }
      }}>
        {!agentHostId ? <option value="">Original project device unconfirmed</option> : null}
        <option value={JSON.stringify(['host', 'local'])}>{project?.hostId === 'local' ? 'Project device' : 'Source Core'} · original Core</option>
        {routeTarget && !routes?.routes.some(route => JSON.stringify(route.agentTarget) === routeKey) || !routeTarget && agentHostId !== 'local' && !choices?.hosts.some(host => host.hostId === agentHostId) ? <option value={choiceKey}>Retained {routeTarget ? 'route' : 'device'} · {agentHostId}</option> : null}
        {choices?.hosts.filter(host => host.hostId !== 'local').map(host => <option key={host.hostId} value={JSON.stringify(['host', host.hostId])}>{host.label}{host.hostId === project?.hostId ? ' · Project device' : ''}</option>)}
        {routes?.routes.length ? <optgroup label="Saved execution routes">{routes.routes.map(route => <option key={route.id} value={JSON.stringify(['route', route.agentTarget])}>{route.id} · {route.agentTarget.adoptedRoute.hops.length > 1 ? `${route.agentTarget.adoptedRoute.hops.length} hops` : 'Direct route'}</option>)}</optgroup> : null}
      </select></label>
      <label><span>Agent configuration</span><select aria-label="Original Space Agent configuration" value={executorId} disabled={!!unreadable} onChange={event => choose(agentHostId, event.target.value, routeTarget)}>
        <option value="">{inventory ? 'Choose a configuration' : 'Reading this Agent device…'}</option>
        {executorId && !inventory?.executors.some(item => item.executorId === executorId) ? <option value={executorId}>Retained selection · {executorId}</option> : null}
        {inventory?.executors.map(item => <option key={item.executorId} value={item.executorId}>{item.label} · {item.availability}</option>)}
      </select></label>
    </div>
    {routeTarget ? <details><summary><ExecutionRouteLink relation={routeTarget.adoptedRoute.hops.length > 1 ? { kind: 'cascade', hops: routeTarget.adoptedRoute.hops.length } : { kind: 'direct' }} /> Saved execution route</summary>
      <p>The Agent runs on the last device in this route. Your project stays on the project device.</p>
      <ol>{[routeTarget.adoptedRoute.source, ...routeTarget.adoptedRoute.hops.map(hop => hop.target)].map((identity, index) => <li key={index}><code>{identity.runtimeId}</code></li>)}</ol>
    </details> : null}
    {executor ? <details><summary>Original configuration</summary><code>{executor.command}</code><p>Agent Runtime: {inventory?.runtimeId}</p></details> : null}
    {executor && executor.availability !== 'available' ? <p className="settings-group-note">{executor.availability === 'missing' ? 'The last executable check reported this CLI missing.' : 'The executable check is unconfirmed.'} The original Core will validate this configuration when you start.</p> : null}
    {unreadable || issue || !terminalObservation && original?.issue || inventoryIssue ? <p role="status">{unreadable ?? issue ?? (!terminalObservation ? original?.issue : undefined) ?? inventoryIssue}</p> : null}
    {choicesIssue ? <details><summary>Other Agent devices unavailable</summary><p>{choicesIssue} The project device and existing source work remain available.</p></details> : null}
    {routesIssue ? <details><summary>Saved route observation unavailable</summary><p>{routesIssue} Retained routes are earlier observations. Other devices and existing work remain available.</p></details> : null}
    {slot.kind === 'new-work' ? <label><span>Private task draft</span><textarea aria-label="New original Space task draft" value={prompt} onChange={event => {
      try { useAppStore.getState().editSpaceMountLauncher(mountKey, slot, { agentHostId, agentTarget: routeTarget, executorId, prompt: event.target.value }) } catch (cause) { setIssue(presentError(cause)) }
    }} /></label> : null}
    <div className="mounted-space-launcher__actions">
      {!original ? <button type="button" className="small-button" disabled={!canStart} onClick={() => void create()}>Start in original Space</button> : <>
        <p role="status">{retired ? 'Original Agent was retired. Its request and creation history are retained.' : completed ? 'Original Space confirmed the new Agent.' : busy ? 'Submitting the original task…' : original.submitted ? 'Original task retained. Check its original result.' : 'The original task was not sent.'}</p>
        {!original.submitted ? <button type="button" className="small-button" disabled={busy} onClick={() => void send(original)}>Send original task</button> : null}
        {original.submitted && !terminalObservation ? <button type="button" className="small-button" disabled={busy} onClick={() => void send(original, true)}>Continue original task</button> : null}
        <button type="button" className="small-button" onClick={() => void inspect()}>Check original task</button>
        {terminalObservation ? <button type="button" className="small-button" onClick={() => { useAppStore.getState().retainSpaceMountAgentOpen(key, current => current === original ? undefined : current); setInspection(undefined) }}>Prepare another task</button> : null}
      </>}
      <button type="button" className="small-button" onClick={() => setRefresh(value => value + 1)}>Refresh devices</button>
    </div>
    {original ? <details><summary>Original task request</summary><p>Continuing uses this same request and its frozen execution target. It does not confirm or resend the original first input.</p><pre>{JSON.stringify({ request: original.request, ...(original.issue ? { originalIssue: original.issue } : {}), ...(original.receipt ? { receipt: original.receipt } : {}) }, null, 2)}</pre></details> : null}
    {inspection ? <details><summary>Current original task observation</summary><p>This read does not repeat the original request or confirm its write response.</p><pre>{JSON.stringify(inspection, null, 2)}</pre></details> : null}
  </div>
}
