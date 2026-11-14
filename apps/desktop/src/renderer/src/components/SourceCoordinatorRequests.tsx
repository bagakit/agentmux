import { useMemo, useRef, useState } from 'react'
import type { AgentExecutionRecoveryReference } from '../../../shared/contracts'
import type { AgentMuxRpcResult } from '@agentmux/core'
import { api } from '../lib/api'
import { adoptAgentRegionObservation, useAppStore } from '../store'
import { sourceCoordinatorInputs, sourceCoordinatorInputKey, type SourceCoordinatorInput } from '../lib/source-coordinator-input'
import { associateCreatedSourceCoordinator, sendOriginalSourceAssociation } from '../lib/source-coordinator-request'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { configValuesEqual } from '../../../shared/config-edit'
import { OriginalLaunchNames } from './OriginalLaunchNames'

/** Private original C/L intentions. Every action retains the original carrier,
 * request and operation; a read never creates or replays a first message. */
export function SourceCoordinatorRequests({ origin, active, coordinatorControls = true }: { origin: { launcherId: string } | { tabId: string; regionId: string }; active: boolean; coordinatorControls?: boolean }) {
  const inputs = useAppStore(state => active ? state.mountedSpaceInputs : undefined)
  const read = useMemo(() => {
    if (!active) return { inputs: [], unreadable: [], issue: undefined }
    try { return { ...sourceCoordinatorInputs(inputs, origin), issue: undefined } } catch (cause) { return { inputs: [], unreadable: [], issue: presentError(cause) } }
  }, [inputs, active, 'launcherId' in origin ? origin.launcherId : JSON.stringify([origin.tabId, origin.regionId])])
  if (!active) return null
  return <>{read.inputs.filter(input => coordinatorControls || input.acknowledged).map(input => <OriginalSourceCoordinator key={sourceCoordinatorInputKey(input.request)} input={input} />)}
    {read.unreadable.map(entry => <details className="launcher-source-original" key={entry.key}><summary>One original request is unreadable</summary>
      <p role="status">{entry.issue} Other original requests remain available.</p><code>{entry.key}</code></details>)}
    {read.issue ? <p role="status">{read.issue}</p> : null}</>
}
function OriginalSourceCoordinator({ input }: { input: SourceCoordinatorInput }) {
  const [target, setTarget] = useState<AgentExecutionRecoveryReference>(), [report, setReport] = useState<AgentMuxRpcResult<'space.inspect'>>()
  const [issue, setIssue] = useState<string>(), [coordinatorIssue, setCoordinatorIssue] = useState<string>(), [linkIssue, setLinkIssue] = useState<string>(), [busy, setBusy] = useState(false), producer = useRef(false)
  const readGeneration = useRef(0)
  const original = input.request
  async function check() {
    const generation = ++readGeneration.current
    await Promise.allSettled([(async () => { try {
      const found = await api.sessions.resolveExecutionBinding({ hostId: original.hostId, agentSessionId: original.agentSessionId,
        createOperationId: original.createOperationId, toolWorkspace: original.toolWorkspace })
      if (found) {
        if (found.target.coordinator.hostId !== original.hostId || found.target.coordinator.runtimeId !== original.sourceCoordinator.runtimeId ||
          found.target.reference.agentSessionId !== original.agentSessionId || found.target.reference.createOperationId !== original.createOperationId)
          throw Error('The reply belongs to another Coordinator or original request. This intention is retained.')
        if (generation === readGeneration.current) setTarget(found.target)
      }
      if (generation === readGeneration.current) setCoordinatorIssue(found ? undefined : 'The original Coordinator currently has no matching retained intent. The complete request is kept; this read did not submit it.')
    } catch (cause) { if (generation === readGeneration.current) setCoordinatorIssue(presentError(cause)) } })(), (async () => { try {
      const observed = await api.spaceMounts.call('inspect', { hostId: input.target.hostId, reference: input.target.reference, requestId: input.association.operationId })
      if (generation === readGeneration.current) { setReport(observed); setLinkIssue(undefined) }
    } catch (cause) { if (generation === readGeneration.current) setLinkIssue(presentError(cause)) } })()])
  }
  async function continueOriginal() {
    if (producer.current) return
    producer.current = true; setBusy(true)
    ++readGeneration.current
    try {
      if (input.acknowledged) await sendOriginalSourceAssociation(input)
      else {
        if (!target) throw Error('Check the original Coordinator to obtain its exact retained reference. No new Agent was requested.')
        const result = await api.sessions.continueExecution(target)
        const linking = associateCreatedSourceCoordinator(input, result.created)
        void linking.catch(() => {})
        const canonical = await useAppStore.getState().canonicalizeAgentLaunch(result) ?? result
        const state = useAppStore.getState(), slot = input.origin.slot, pending = state.pendingAgentLaunches[original.agentSessionId], region = state.tabs[slot.tabId]?.regions[slot.regionId]
        if (pending?.request && configValuesEqual(pending.request, original) && region?.kind === 'agent' && region.sessionId === original.agentSessionId && canonical.session)
          adoptAgentRegionObservation({ ...slot, hostId: original.hostId, agentSessionId: original.agentSessionId }, canonical)
        await linking
      }
      ++readGeneration.current; setReport(undefined); setIssue(undefined)
    } catch (cause) { setIssue(presentError(cause)) }
    finally { producer.current = false; setBusy(false) }
  }
  const observed = report?.request?.known && report.request.report?.operationId === input.association.operationId ? report.request.report : undefined
  const receipt = input.association.receipt, link = observed ?? receipt
  const producerSaved = receipt?.outcome === 'opened' && receipt.save?.diskDurability === 'confirmed'
  const observationIssues = observed?.issues ?? []
  const observationProblem = !!observed && (observed.outcome === 'partial' || observed.outcome === 'unknown' || observationIssues.length > 0)
  const linkComplete = !observationProblem && (link?.outcome === 'opened' || link?.outcome === 'retired')
  const originalComplete = receipt?.outcome === 'opened' || receipt?.outcome === 'retired'
  // Successful ordinary work has no extra banner. Pending names remain an
  // explicit private intention until their original label owners acknowledge.
  return <details className="launcher-source-original" open={!input.acknowledged || !linkComplete || !producerSaved || undefined}>
    <summary>{observationProblem ? 'Current project link needs checking' : link?.outcome === 'retired' ? 'Original project link retired' : producerSaved ? 'Original project link saved' : link?.outcome === 'opened'
      ? 'Original project link observed' : input.acknowledged ? 'Project link is unconfirmed' : 'Original Reach request'}</summary>
    <p role="status">{issue ?? (observationProblem ? 'The current Source observation does not confirm the original association or placement. The original Agent and operation are retained.'
      : link?.outcome === 'opened' ? producerSaved ? 'The original project-link write was saved.' : 'The association is currently visible. Its original disk-write acknowledgement is unconfirmed.'
      : input.association.issue ?? (!input.acknowledged && !input.submitted ? `This original request was not sent. ${input.issue ?? 'Its complete input is retained.'}` : input.issue)) ?? (input.acknowledged
      ? 'The original Agent creation was confirmed. The project link has its own operation.' : 'The original request and first input are retained. Checking starts no Agent.')}</p>
    {observationIssues.map((item, index) => <p role="status" key={index}><strong>{item.message}</strong> {item.recovery}</p>)}
    {typeof observed?.save?.reason === 'string' && observed.save.reason ? <p role="status">Current link observation: {observed.save.reason}</p> : null}
    {typeof receipt?.save?.reason === 'string' && receipt.save.reason ? <p role="status">Original write acknowledgement: {receipt.save.reason}</p> : null}
    {producerSaved && (observationProblem || link?.outcome === 'retired') ? <p role="status">Original write acknowledgement: saved. This does not confirm the current placement.</p> : null}
    {coordinatorIssue ? <p role="status">Coordinator observation: {coordinatorIssue}</p> : null}
    {linkIssue ? <p role="status">Project-link observation: {linkIssue}</p> : null}
    <div className="agent-work-setup__actions"><div>
      <button type="button" className="small-button" onClick={() => void check()}>Check original Reach request</button>
      {!originalComplete && (input.acknowledged || target) ? <button type="button" className="small-button" disabled={busy} onClick={() => void continueOriginal()}>
        {busy ? 'Continuing…' : input.acknowledged ? 'Continue original project link' : 'Continue original Coordinator request'}</button> : null}
    </div></div>
    <OriginalLaunchNames owner={{ kind: 'reach', input, ...(observed ? { observation: observed } : {}) }} />
    <details><summary>Original request details</summary><pre>{JSON.stringify({ request: original, association: input.association, names: input.origin.names, observation: report }, null, 2)}</pre></details>
  </details>
}
