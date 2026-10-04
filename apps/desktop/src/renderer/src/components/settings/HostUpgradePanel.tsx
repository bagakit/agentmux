import { useEffect, useRef, useState } from 'react'
import { ArrowUpCircle, CheckCircle2, ChevronDown, Copy, Info, LoaderCircle } from 'lucide-react'
import type { RemoteCoreUpgradeCheck, RemoteCoreUpgradeReceipt } from '@agentmux/core'
import type { SshHostConfig } from '../../../../shared/contracts'
import { configValuesEqual } from '../../../../shared/config-edit'
import { api } from '../../lib/api'
import { copyTextToClipboard } from '../../lib/clipboard-copy'

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
  const [copyState, setCopyState] = useState<{ input: SshHostConfig; text: string; status: 'copying' | 'copied' | 'failed'; error?: string }>()
  const latestCopyRequest = useRef<object | undefined>(undefined)
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
  const needsRecheck = Boolean(check && !check.eligible || current && state.error && !state.operationId || receipt?.status === 'completed' || receipt?.status === 'failed')
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
  const runtimeBlocked = !busy && !receipt && check?.reason === 'runtime-update-required' && !check.eligible
  const coreSource = check?.candidate.sourceCommit ?? 'Unknown'
  const status = busy ? state.busy === 'checking' ? 'Checking upgrade' : state.busy === 'inspecting' ? 'Checking original result' : 'Upgrading and reconnecting' :
    receipt?.status === 'completed' ? 'Upgrade complete' : uncertain ? 'Upgrade result unconfirmed' : receipt?.status === 'failed' ? 'Upgrade not completed' : needsRecheck ?
      runtimeBlocked ? 'Automatic upgrade unavailable' : 'Upgrade check unconfirmed' : check?.eligible ? 'Ready to upgrade' : 'Remote service update'
  const description = !saved ? 'Save this connection before upgrading.' : busy ? state.busy === 'checking' ?
    'Checking whether this host can be updated without interrupting its existing Agents.' : state.busy === 'inspecting' ?
    'Reading the original update result. This does not start another update.' : 'Updating the remote service and verifying the original connection.' :
    receipt?.status === 'completed' ? 'The remote Core was updated and the original connection was verified.' : uncertain ?
    'The previous update result is not confirmed. Check that original operation before starting another update.' : receipt?.status === 'failed' ?
    'The update did not complete. Recheck its availability before trying again.' : runtimeBlocked ?
    'This host needs a runtime update that this version of AgentMux cannot safely perform. Existing Agents are left unchanged.' : needsRecheck ?
    'We could not confirm whether this host can be updated. Review the connection settings, then check again.' :
    'Update this host using the Core bundled with AgentMux, then reconnect to the original Sessions.'
  const diagnostics = current && (check || state.operationId || state.error) ? [
    `Host: ${host.label} (${host.id})`, `Address: ${host.hostname}`, `Status: ${status}`,
    check ? `Reason: ${check.reason}` : undefined, detail ? `Details: ${detail}` : undefined,
    check ? `App Core source: ${coreSource}` : undefined,
    check ? `Update digest: ${check.candidate.digest}` : undefined,
    check ? `Required Runtime protocol: ${check.candidate.protocolVersion}` : undefined,
    state.operationId ? `Operation: ${state.operationId}` : undefined,
    receipt ? `Original result: ${receipt.status} / ${receipt.stage}` : undefined
  ].filter(value => value !== undefined).join('\n') : undefined
  const copy = copyState && diagnostics === copyState.text && matches(copyState.input, host) ? copyState : undefined
  async function copyDiagnostics(): Promise<void> {
    if (!diagnostics || copy?.status === 'copying') return
    const captured = { input: structuredClone(host), text: diagnostics }
    latestCopyRequest.current = captured
    setCopyState({ ...captured, status: 'copying' })
    let failure: string | undefined
    const copied = await copyTextToClipboard(captured.text, error => {
      failure = error instanceof Error ? error.message : String(error)
    })
    if (latestCopyRequest.current !== captured) return
    setCopyState({ ...captured, status: copied ? 'copied' : 'failed', ...(failure ? { error: failure } : {}) })
  }
  return <section className="host-upgrade" data-host-upgrade={host.id}>
    <div className="host-upgrade__heading">
      <span className="host-upgrade__title">{busy ? <LoaderCircle size={14} className="spin" /> : receipt?.status === 'completed' ? <CheckCircle2 size={14} /> : check && !check.eligible || uncertain ? <Info size={14} /> : <ArrowUpCircle size={14} />}<strong role="status">{status}</strong></span>
    </div>
    <p className="field-hint host-upgrade__description">{description}</p>
    {runtimeBlocked ? <p className="host-upgrade__next-step">Copy the diagnostics for whoever maintains this host to arrange a supported runtime update. Recheck availability after that update is installed.</p> : null}
    <div className="host-upgrade__actions">
      {runtimeBlocked ? <button type="button" className="small-button" data-copy-upgrade-diagnostics disabled={copy?.status === 'copying'} onClick={() => void copyDiagnostics()}><Copy size={13} />{copy?.status === 'copying' ? 'Copying…' : copy?.status === 'copied' ? 'Copied' : 'Copy diagnostics'}</button> : null}
      <button type="button" data-upgrade-action className={check?.eligible && !needsRecheck && !busy ? 'primary-button' : 'small-button host-upgrade__recheck'} disabled={busy || !saved} onClick={() => void (uncertain ? inspect() : upgrade(!needsRecheck))}>
        {busy ? 'Working…' : uncertain ? 'Check original result' : needsRecheck ? 'Recheck availability' : 'Upgrade and reconnect'}
      </button>
    </div>
    {diagnostics ? <details className="host-upgrade__details">
      <summary>Technical details <ChevronDown size={13} /></summary>
      <div className="host-upgrade__diagnostics">
        {detail ? <div><span className="host-upgrade__detail-label">Original diagnostic</span><p className="host-upgrade__diagnostic-message">{detail}</p></div> : null}
        <dl className="host-upgrade__facts">
          {check ? <><div><dt>App Core source</dt><dd><code>{coreSource}</code></dd></div><div><dt>Update digest</dt><dd><code>{check.candidate.digest}</code></dd></div><div><dt>Required Runtime protocol</dt><dd>{check.candidate.protocolVersion}</dd></div></> : null}
          {state.operationId ? <div><dt>Original operation</dt><dd><code>{state.operationId}</code>{receipt ? <span>{receipt.status} · {receipt.stage}</span> : null}</dd></div> : null}
        </dl>
        {!runtimeBlocked ? <button type="button" className="small-button" data-copy-upgrade-diagnostics disabled={copy?.status === 'copying'} onClick={() => void copyDiagnostics()}><Copy size={13} />{copy?.status === 'copying' ? 'Copying…' : copy?.status === 'copied' ? 'Copied' : 'Copy diagnostics'}</button> : null}
      </div>
    </details> : null}
    {copy?.status === 'copied' ? <p className="host-upgrade__copy-feedback" role="status">{runtimeBlocked ? 'Diagnostics copied. Share them to resolve the update path.' : 'Diagnostics copied.'}</p> : copy?.status === 'failed' ? <p className="host-upgrade__copy-feedback host-upgrade__copy-feedback--error" role="alert">Could not copy diagnostics. Try again.{copy.error ? ` ${copy.error}` : ''}</p> : null}
  </section>
}
