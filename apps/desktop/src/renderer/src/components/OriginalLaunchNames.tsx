import { useEffect, useRef, useState } from 'react'
import type { NameChangeResult, NameObservation } from '@agentmux/core/name-control'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { Button } from '@agentmux/client-ui/components/Button'
import { useAppStore } from '../store'
import { sourceCoordinatorInputKey } from '../lib/source-coordinator-input'
import { mountedAgentOpenKey } from '../lib/space-mount-launch'
import { applyOriginalLaunchNames, launchNameAddress, newestNameObservation, originalLaunchName, readLaunchName, sendLaunchName,
  type LaunchNameOwner, type LaunchNameRole } from '../lib/original-launch-names'

/** Two original private name intentions; current labels come only from their owners. */
export function OriginalLaunchNames({ owner, active = true }: { owner: LaunchNameOwner; active?: boolean }) {
  const key = owner.kind === 'reach' ? sourceCoordinatorInputKey(owner.input.request) : mountedAgentOpenKey(owner.input.target, owner.input.slot)
  const operationId = owner.kind === 'reach' ? owner.input.request.createOperationId : owner.input.request.operationId
  useAppStore(state => state.mountedSpaceInputs && typeof state.mountedSpaceInputs === 'object' ? (state.mountedSpaceInputs as Record<string, unknown>)[key] : undefined)
  if (!active) return null
  return <div className="launcher-original-names" aria-label="Original Agent and Tab names">
    {(['agent', 'tab'] as const).map(role => <OriginalName key={JSON.stringify([key, operationId, role])} owner={owner} role={role} />)}
  </div>
}
function OriginalName({ owner, role }: { owner: LaunchNameOwner; role: LaunchNameRole }) {
  const label = role === 'agent' ? 'Agent name' : 'Tab name', requested = owner.input.origin?.names[role === 'agent' ? 'agentName' : 'tabName'].trim()
  let input: ReturnType<typeof originalLaunchName>, unreadable: string | undefined
  try { input = originalLaunchName(owner, role) } catch (cause) { unreadable = presentError(cause) }
  const hasName = Boolean(requested || input || unreadable)
  const target = input?.target ?? launchNameAddress(owner, role), identity = target ? JSON.stringify(target) : undefined
  const [observed, setObserved] = useState<NameObservation | NameChangeResult>(), [issue, setIssue] = useState<string>(), [busy, setBusy] = useState(false)
  const reader = useRef<AbortController | undefined>(undefined), generation = useRef(0)
  useEffect(() => {
    setObserved(undefined); setIssue(undefined)
    if (!target || !hasName) return
    const controller = new AbortController(), turn = ++generation.current; reader.current = controller
    void readLaunchName(target, input?.change.operationId, controller.signal).then(result => {
      if (!controller.signal.aborted && turn === generation.current) setObserved(current => newestNameObservation(current, result))
    }, cause => { if (!controller.signal.aborted && turn === generation.current) setIssue(presentError(cause)) })
    return () => controller.abort()
  }, [identity, hasName])
  useEffect(() => { if (input?.response) setObserved(current => newestNameObservation(current, input.response!)) }, [input?.response])
  async function check() {
    if (!target) return
    reader.current?.abort(); const controller = new AbortController(), turn = ++generation.current; reader.current = controller
    try {
      const next = await readLaunchName(target, input?.change.operationId, controller.signal)
      if (!controller.signal.aborted && turn === generation.current) { setObserved(current => newestNameObservation(current, next)); setIssue(undefined) }
    } catch (cause) { if (!controller.signal.aborted && turn === generation.current) setIssue(presentError(cause)) }
  }
  async function apply(confirm: boolean) {
    setBusy(true)
    try {
      if (!input) await applyOriginalLaunchNames(owner, [role])
      else { const result = await sendLaunchName(owner, role, confirm); setObserved(current => newestNameObservation(current, result)) }
      setIssue(undefined)
    } catch (cause) { setIssue(presentError(cause)) }
    finally { setBusy(false) }
  }
  if (!requested && !input && !unreadable) return null
  const saved = input?.response?.applied && input.response.save.diskDurability === 'confirmed'
  return <details className="launcher-original-name" open={!saved || !!issue || !!unreadable || undefined}>
    <summary>{label}: {observed ? observed.current.override ?? 'Automatic name' : 'Unconfirmed'}</summary>
    <p>Original requested name: <strong>{input?.change.name ?? requested}</strong></p>
    {input?.response ? <p role="status">{saved ? 'Original name write saved.' : input.response.applied ? 'Original name applied; disk acknowledgement is unconfirmed.' : 'The original name was not applied.'} {input.response.save.issue}</p> : null}
    {observed && observed.current.nameRevision > (input?.response?.current.nameRevision ?? -1) && saved ? <p>Current name is a newer owner observation. The original save remains in its operation history.</p> : null}
    {unreadable || issue || input?.issue ? <p role="status">{unreadable ?? issue ?? input?.issue}</p> : null}
    {!target && !unreadable ? <p role="status">The original name target is unconfirmed. Its name and original Agent workface are retained.</p> : null}
    {target && !unreadable ? <div className="agent-work-setup__actions"><div>
      <Button type="button" onClick={() => void check()}>Check {label.toLowerCase()}</Button>
      {!input?.response?.applied ? <Button type="button" disabled={busy} onClick={() => void apply(false)}>Apply original {label.toLowerCase()}</Button> : null}
      {!saved && (input?.response?.applied || observed?.record?.status === 'applied') ? <Button type="button" disabled={busy} onClick={() => void apply(true)}>Confirm original {label.toLowerCase()}</Button> : null}
    </div></div> : null}
    <details><summary>Name operation details</summary><pre>{JSON.stringify({ input, observation: observed }, null, 2)}</pre></details>
  </details>
}
