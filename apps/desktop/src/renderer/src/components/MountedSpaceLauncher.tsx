import { useEffect, useRef, useState } from 'react'
import type { AgentMuxRpcResult, SpaceSnapshot } from '@agentmux/core'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../lib/api'
import { checkpointMountedSpaceInputs, useAppStore } from '../store'
import { mountedAgentOpenInput, mountedAgentOpenKey, mountedLauncherSelection, type MountedAgentOpenInput, type MountedLauncherSlot } from '../lib/space-mount-launch'
import type { SpaceMountHostChoices, SpaceMountRecord } from '../../../shared/space-mount'

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
  const [inventory, setInventory] = useState<AgentMuxRpcResult<'settings.executors.discover'>>(), [inventoryIssue, setInventoryIssue] = useState<string>(), [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false), producer = useRef(false), [issue, setIssue] = useState<string>(), [inspection, setInspection] = useState<AgentMuxRpcResult<'space.inspect'>>()
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
    if (!active || !agentHostId) return
    const controller = new AbortController(); setInventory(undefined); setInventoryIssue(undefined)
    void api.spaceMounts.call('executors', { hostId: target.hostId, reference: target.reference, agentHostId }, controller.signal).then(reply => {
      if (!controller.signal.aborted) setInventory(reply)
    }).catch(cause => { if (!controller.signal.aborted) setInventoryIssue(presentError(cause)) })
    return () => controller.abort()
  }, [sourceKey, active, agentHostId, refresh])
  useEffect(() => () => inspectionReader.current?.abort(), [sourceKey, active])
  function choose(host: string, executor: string) {
    try { useAppStore.getState().editSpaceMountLauncher(mountKey, slot, { ...selection, agentHostId: host, executorId: executor }); setIssue(undefined) }
    catch (cause) { setIssue(presentError(cause)) }
  }
  async function send(input: MountedAgentOpenInput) {
    if (producer.current || input.submitted) return
    producer.current = true; setBusy(true); setIssue(undefined)
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
      const message = `${dispatched ? 'The original task result is unknown.' : 'The task was not sent.'} ${presentError(cause)}`
      try { store.retainSpaceMountAgentOpen(key, current => current?.request === input.request ? { ...current, submitted: dispatched, issue: message } : current) } catch { /* Preserve an unreadable/future intent instead of replacing its original bytes. */ }
      setIssue(message)
    } finally { producer.current = false; setBusy(false) }
  }
  async function create() {
    if (original || !canStart || !projectTarget || !inventory) return
    const input: MountedAgentOpenInput = { kind: 'agent-open', target: projectTarget, slot, submitted: false,
      request: { operationId: crypto.randomUUID(), content: { kind: 'new-agent', executorId, agentTarget: { hostId: agentHostId, runtimeId: inventory.runtimeId }, ...(prompt ? { prompt } : {}) },
        destination: { spaceId: target.reference.spaceId, zoneId: projectTarget.zoneId, newTab: true }, focus: false } }
    await send(input)
  }
  async function inspect() {
    if (!original) return
    inspectionReader.current?.abort(); const controller = new AbortController(); inspectionReader.current = controller
    try { const reply = await api.spaceMounts.call('inspect', { hostId: original.target.hostId, reference: original.target.reference, requestId: original.request.operationId }, controller.signal)
      if (!controller.signal.aborted && mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, key)?.request === original.request) { setInspection(reply); setIssue(undefined) }
    } catch (cause) { if (!controller.signal.aborted) setIssue(presentError(cause)) }
  }
  const executor = inventory?.executors.find(entry => entry.executorId === executorId), completed = original?.receipt?.outcome === 'opened'
  const canStart = active && !unreadable && !!projectTarget && inventory?.routeHostId === agentHostId && Boolean(executor)
  return <div className="mounted-space-launcher" aria-label="New work in original Space">
    <div className="mounted-space-launcher__project"><small>Project device · original Space</small><code>{project?.directoryPath ?? 'Original project directory unobserved'}</code></div>
    <div className="mounted-space-launcher__fields">
      <label><span>Agent device</span><select aria-label="Original Space Agent device" value={agentHostId} disabled={!!unreadable} onChange={event => choose(event.target.value, '')}>
        {!agentHostId ? <option value="">Original project device unconfirmed</option> : null}
        <option value="local">{project?.hostId === 'local' ? 'Project device' : 'Source Core'} · original Core</option>
        {agentHostId !== 'local' && !choices?.hosts.some(host => host.hostId === agentHostId) ? <option value={agentHostId}>Original target · {agentHostId}</option> : null}
        {choices?.hosts.filter(host => host.hostId !== 'local').map(host => <option key={host.hostId} value={host.hostId}>{host.label} · {host.hostId}{host.hostId === project?.hostId ? ' · Project device' : ''}</option>)}
      </select></label>
      <label><span>Agent configuration</span><select aria-label="Original Space Agent configuration" value={executorId} disabled={!!unreadable} onChange={event => choose(agentHostId, event.target.value)}>
        <option value="">{inventory ? 'Choose a configuration' : 'Reading this Agent device…'}</option>
        {executorId && !inventory?.executors.some(item => item.executorId === executorId) ? <option value={executorId}>Retained selection · {executorId}</option> : null}
        {inventory?.executors.map(item => <option key={item.executorId} value={item.executorId}>{item.label} · {item.availability}</option>)}
      </select></label>
    </div>
    {executor ? <details><summary>Original configuration</summary><code>{executor.command}</code><p>Agent Runtime: {inventory?.runtimeId}</p></details> : null}
    {executor && executor.availability !== 'available' ? <p className="settings-group-note">{executor.availability === 'missing' ? 'The last executable check reported this CLI missing.' : 'The executable check is unconfirmed.'} The original Core will validate this configuration when you start.</p> : null}
    {unreadable || issue || original?.issue || inventoryIssue ? <p role="status">{unreadable ?? issue ?? original?.issue ?? inventoryIssue}</p> : null}
    {choicesIssue ? <details><summary>Other Agent devices unavailable</summary><p>{choicesIssue} The project device and existing source work remain available.</p></details> : null}
    {slot.kind === 'new-work' ? <label><span>Private task draft</span><textarea aria-label="New mounted Space task draft" value={prompt} onChange={event => {
      try { useAppStore.getState().editSpaceMountLauncher(mountKey, slot, { agentHostId, executorId, prompt: event.target.value }) } catch (cause) { setIssue(presentError(cause)) }
    }} /></label> : null}
    <div className="mounted-space-launcher__actions">
      {!original ? <button type="button" className="small-button" disabled={!canStart} onClick={() => void create()}>Start in original Space</button> : <>
        <p role="status">{completed ? 'Original Space confirmed the new Agent.' : busy ? 'Submitting the original task…' : original.submitted ? 'Original task retained. Check its original result.' : 'The original task was not sent.'}</p>
        {!original.submitted ? <button type="button" className="small-button" disabled={busy} onClick={() => void send(original)}>Send original task</button> : null}
        <button type="button" className="small-button" onClick={() => void inspect()}>Check original task</button>
        {completed ? <button type="button" className="small-button" onClick={() => { useAppStore.getState().retainSpaceMountAgentOpen(key, current => current === original ? undefined : current); setInspection(undefined) }}>Prepare another task</button> : null}
      </>}
      <button type="button" className="small-button" onClick={() => setRefresh(value => value + 1)}>Refresh devices</button>
    </div>
    {original ? <details><summary>Original task request</summary><pre>{JSON.stringify({ request: original.request, ...(original.receipt ? { receipt: original.receipt } : {}) }, null, 2)}</pre></details> : null}
    {inspection ? <details open><summary>Current original task observation</summary><p>This read does not repeat the original request or confirm its write response.</p><pre>{JSON.stringify(inspection, null, 2)}</pre></details> : null}
  </div>
}
