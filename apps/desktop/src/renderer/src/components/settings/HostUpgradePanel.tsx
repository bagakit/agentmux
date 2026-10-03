import { useEffect, useRef, useState } from 'react'
import { ArrowUpCircle, CheckCircle2, ChevronDown, Info, LoaderCircle } from 'lucide-react'
import type { RemoteCoreUpgradeCheck, RemoteCoreUpgradeReceipt } from '@agentmux/core'
import type { SshHostConfig } from '../../../../shared/contracts'
import { configValuesEqual } from '../../../../shared/config-edit'
import { api } from '../../lib/api'

type State = {
  input?: SshHostConfig
  check?: RemoteCoreUpgradeCheck
  receipt?: RemoteCoreUpgradeReceipt
  operationId?: string
  busy?: 'checking' | 'upgrading' | 'inspecting' | undefined
  error?: string | undefined
}
function route({ label: _label, ...host }: SshHostConfig): Omit<SshHostConfig, 'label'> { return host }
function matches(a: SshHostConfig, b: SshHostConfig): boolean { return configValuesEqual(route(a), route(b)) }

/** Presentation owns only its current input. The public maintenance owner retains transactions. */
export function HostUpgradePanel({ host, committed, active }: {
  host: SshHostConfig
  committed: SshHostConfig | undefined
  active: boolean
}) {
  const [state, setState] = useState<State>({})
  const autoCheckedInput = useRef<SshHostConfig | undefined>(undefined)
  const currentHost = useRef(host), currentCommitted = useRef(committed)
  currentHost.current = host; currentCommitted.current = committed
  const saved = committed !== undefined && matches(host, committed)
  const displayInput = state.receipt && state.receipt.status !== 'failed' && state.receipt.remoteCommand && state.input
    ? { ...state.input, remoteCommand: state.receipt.remoteCommand } : state.input
  const current = displayInput !== undefined && (matches(displayInput, host) ||
    (state.receipt?.status === 'unknown' || state.receipt?.status === 'running') && state.input !== undefined && matches(state.input, host))
  const busy = state.busy !== undefined
  const receipt = current ? state.receipt : undefined
  const check = current ? state.check : undefined
  const uncertain = current && state.operationId && (state.error !== undefined || receipt?.status === 'unknown' || receipt?.status === 'running')
  const detail = current ? state.error ?? receipt?.detail ?? check?.detail : undefined
  const needsRecheck = Boolean(check && !check.eligible || current && state.error && !state.operationId)
  const retainedOperation = Boolean(state.operationId && state.input &&
    (matches(state.input, host) || displayInput && matches(displayInput, host)))

  useEffect(() => {
    if (!active || !saved) { autoCheckedInput.current = undefined; return }
    // Re-entering while this exact input is already in flight joins that check.
    if (busy && state.input && matches(state.input, host)) autoCheckedInput.current = state.input
    // One visible saved target, once per entry/input. Unknown original operations
    // keep their receipt; checking never admits or replays a deployment.
    if (busy) return
    if (retainedOperation && (state.receipt?.status !== 'completed' && state.receipt?.status !== 'failed' || autoCheckedInput.current)) {
      autoCheckedInput.current = structuredClone(host)
      return
    }
    if (autoCheckedInput.current && matches(autoCheckedInput.current, host)) return
    autoCheckedInput.current = structuredClone(host)
    void upgrade(false)
  }, [active, saved, host, busy, retainedOperation, state.input, state.receipt?.status])

  async function upgrade(runUpgrade = true): Promise<void> {
    if (!active || !saved || busy) return
    const input = structuredClone(host)
    setState({ input, busy: 'checking' })
    let operationId: string | undefined
    try {
      const check = await api.hosts.upgradeCheck(input)
      // A changed draft or same-ID external replacement cannot borrow this check.
      if (!matches(input, currentHost.current) || !currentCommitted.current || !matches(input, currentCommitted.current)) {
        setState({ input, check }); return
      }
      if (check.latestOperation?.status === 'unknown' || check.latestOperation?.status === 'running') {
        setState({ input, check, receipt: check.latestOperation, operationId: check.latestOperation.operationId }); return
      }
      if (!runUpgrade || !check.eligible || !check.expected) { setState({ input, check }); return }
      operationId = crypto.randomUUID()
      setState({ input, check, operationId, busy: 'upgrading' })
      const receipt = await api.hosts.upgrade(input, check.expected, operationId)
      setState({ input, check, operationId, receipt })
    } catch (error) {
      setState({ input, ...(operationId ? { operationId } : {}),
        error: error instanceof Error ? error.message : String(error) })
    }
  }
  async function inspect(): Promise<void> {
    if (!active || busy || !state.operationId || !state.input) return
    const captured = state
    setState({ ...captured, busy: 'inspecting' })
    try {
      const receipt = await api.hosts.upgradeInspect(captured.input!, captured.operationId!)
      setState({ ...captured, busy: undefined, ...(receipt ? { receipt, error: undefined } : {
        error: 'The original upgrade has no confirmed receipt. Check this connection before trying a new update.' }) })
    } catch (error) { setState({ ...captured, busy: undefined, error: error instanceof Error ? error.message : String(error) }) }
  }
  const status = busy ? state.busy === 'checking' ? 'Checking upgrade' : state.busy === 'inspecting' ? 'Checking original result' : 'Upgrading and reconnecting' :
    receipt?.status === 'completed' ? 'Upgrade complete' : uncertain ? 'Upgrade result unconfirmed' : receipt?.status === 'failed' ? 'Upgrade not completed' : needsRecheck ?
      check?.reason === 'runtime-update-required' ? 'Runtime update required' : 'Upgrade check unconfirmed' : check?.eligible ? 'Ready to upgrade' : 'Remote Core'
  return <section className="host-upgrade" data-host-upgrade={host.id}>
    <div className="host-upgrade__heading">
      <span className="host-upgrade__title">{busy ? <LoaderCircle size={14} className="spin" /> : receipt?.status === 'completed' ? <CheckCircle2 size={14} /> : check && !check.eligible || uncertain ? <Info size={14} /> : <ArrowUpCircle size={14} />}<strong role="status">{status}</strong></span>
      <button type="button" className="small-button" disabled={busy || !saved} onClick={() => void (uncertain ? inspect() : upgrade(!needsRecheck))}>
        {busy ? 'Working…' : uncertain ? 'Check upgrade result' : needsRecheck ? 'Check again' : 'Upgrade and reconnect'}
      </button>
    </div>
    <p className="field-hint">{!saved ? 'Save this connection before upgrading.' : uncertain ? detail :
      check && !check.eligible ? check.reason === 'runtime-update-required' ?
        'The Runtime needs a separate safe update before Core can be upgraded. Existing Agents and Sessions were kept.' :
        'The upgrade could not be verified. Existing Agents and Sessions were kept.' :
      detail ?? 'Check and update this remote service using the Core included with AgentMux. Existing Sessions stay in place.'}</p>
    {current && (check || state.operationId) ? <details className="host-check-details">
      <summary>Upgrade details <ChevronDown size={13} /></summary>
      {check && !check.eligible ? <p className="host-check-detail">{check.detail}</p> : null}
      {check ? <p className="host-check-detail">Core source: {check.candidate.sourceCommit}<br />Candidate: {check.candidate.digest}<br />Runtime protocol: {check.candidate.protocolVersion}</p> : null}
      {state.operationId ? <p className="host-check-detail">Operation: {state.operationId}{receipt ? <><br />{receipt.status} · {receipt.stage}</> : null}</p> : null}
    </details> : null}
  </section>
}
