import { mintObjectId } from '@agentmux/core/object-id'
import { useEffect, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { RemoteCoreUpgradeCheck, RemoteCoreUpgradeReceipt } from '@agentmux/core'
import { Button } from '@agentmux/client-ui/components/Button'
import type { SshHostConfig } from '../../../../shared/contracts'
import { configValuesEqual } from '../../../../shared/config-edit'
import { api } from '../../lib/api'
import { copyTextToClipboard } from '../../lib/clipboard-copy'
import './host-upgrade-observation.css'

const LoadingIcon = semanticIconComponent('status.loading')
const UpgradeIcon = semanticIconComponent('action.upgrade-host')
const CopyIcon = semanticIconComponent('action.copy')
const DownIcon = semanticIconComponent('navigation.down')
const STAGE_LABELS: Record<RemoteCoreUpgradeReceipt['stage'], string> = {
  preparing: 'Preparing the candidate', staged: 'Candidate staged', stopping: 'Stopping the original Core',
  'replacing-native': 'Replacing the Native Runtime', starting: 'Starting the updated Core', verifying: 'Verifying the original Runtime', completed: 'Verification completed'
}
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
/** "3 in Agent Sessions, 1 in a terminal"; empty categories are left out. */
function endingSummary(ending: NonNullable<RemoteCoreUpgradeCheck['nativeReplacement']>['ending']): string {
  const agents = ending.filter(run => run.agentSessionId !== null).length, terminals = ending.length - agents
  return [agents ? (agents === 1 ? '1 in an Agent Session' : `${agents} in Agent Sessions`) : '', terminals ? (terminals === 1 ? '1 in a terminal' : `${terminals} in terminals`) : '']
    .filter(Boolean).join(', ')
}
type Operation = { input: SshHostConfig; id: string; receipt?: RemoteCoreUpgradeReceipt; candidate?: NonNullable<RemoteCoreUpgradeCheck['candidate']> | undefined;
  /** The confirmed admission, kept until the original receipt arrives. */
  expected?: RemoteCoreUpgradeCheck['expected']
  error?: string | undefined; errorAction?: 'upgrade' | 'inspect' | 'reconnect' | undefined }
type Review = { input: SshHostConfig; check: RemoteCoreUpgradeCheck & { candidate: NonNullable<RemoteCoreUpgradeCheck['candidate']> } }
type State = { input: SshHostConfig; check?: RemoteCoreUpgradeCheck; checkApplied?: boolean; operation?: Operation | undefined; review?: Review | undefined;
  busy?: 'checking' | 'upgrading' | 'inspecting' | 'reconnecting' | undefined; error?: string | undefined
  /** The maintenance owner holds no record of this attempt: it was refused before admission. */
  refused?: string | undefined }
function route({ label: _label, ...host }: SshHostConfig): Omit<SshHostConfig, 'label'> { return host }
function matches(a: SshHostConfig, b: SshHostConfig): boolean { return configValuesEqual(route(a), route(b)) }
function belongs(state: State, host: SshHostConfig): boolean {
  return matches(state.input, host) || Boolean(state.operation && (matches(state.operation.input, host) ||
    state.operation.receipt?.remoteCommand && state.operation.receipt.status !== 'failed' &&
    matches({ ...state.operation.input, remoteCommand: state.operation.receipt.remoteCommand }, host)))
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const version = (value: string | null | undefined) => value ?? 'Unknown'
const contentLabel = (source: string | null | undefined, digest: string | undefined) => source ? `Source ${source.slice(0, 10)}` : digest ? `Content ${digest.slice(0, 12)}` : 'Source unknown'
function ReadTime({ at, label = 'Read' }: { at: number; label?: string }) {
  return <span>{label} <time dateTime={new Date(at).toISOString()}>{new Date(at).toLocaleString()}</time></span>
}

/** The review of an upgrade that also replaces an older Native Runtime: why, what ends and what
 * is kept. Confirming applies exactly this reviewed admission. */
function NativeReplacementReview({ review, busy, onConfirm, onCancel }: { review: Review; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  const plan = review.check.nativeReplacement!, label = review.input.label, ending = plan.ending.length
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => { cancel.current?.focus() }, [])
  const current = review.check.current.state === 'available' ? review.check.current.native.protocolVersion : undefined
  return <div className="host-upgrade__review" role="group" aria-label="Review upgrade" data-upgrade-native-replacement
    onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onCancel() } }}>
    <strong>Review upgrade for {label}</strong><span>{review.input.hostname} · {contentLabel(review.check.candidate.sourceCommit, review.check.candidate.digest)}</span>
    <p>The Native Runtime on {label} {current === undefined ? 'uses an older protocol' : `speaks protocol ${current}`} and this app needs protocol {review.check.candidate.requiredNativeProtocolVersion}, so it restarts with the new version.</p>
    {ending ? <dl className="host-upgrade__observation" aria-label="Upgrade impact">
      <div><dt>Running processes that end</dt><dd data-upgrade-ending>{endingSummary(plan.ending)}</dd></div>
      <div><dt>Kept</dt><dd>Sessions with their history and output, and the Runtime identity</dd></div>
    </dl> : <p data-upgrade-ending>No processes are running on {label}, so nothing ends. Sessions, their history and the Runtime identity are kept.</p>}
    <p>A copy of the Native state is saved on {label} before the restart.</p>
    <div className="host-upgrade__actions">
      <Button ref={cancel} type="button" data-upgrade-cancel disabled={busy} onClick={onCancel}>Cancel</Button>
      <button type="button" className={ending ? 'danger-button' : 'primary-button'} data-upgrade-confirm disabled={busy} onClick={onConfirm}>
        {ending ? `Upgrade and end ${plural(ending, 'process', 'processes')}` : 'Upgrade Core and Native Runtime'}</button>
    </div>
  </div>
}

/** One local update controller. The original maintenance owner retains every operation. */
export function useHostUpgrade({ host, committed, active, installationDetail }: {
  host: SshHostConfig; committed: SshHostConfig | undefined; active: boolean; installationDetail?: string | undefined
}) {
  const [entries, setEntries] = useState<State[]>([])
  const state = entries.find(item => belongs(item, host))
  const currentHost = useRef(host), currentCommitted = useRef(committed)
  currentHost.current = host; currentCommitted.current = committed
  const autoChecked = useRef<SshHostConfig | undefined>(undefined)
  const inFlight = useRef(new Set<string>())
  const saved = committed !== undefined && matches(host, committed)
  const check = state?.check && matches(state.check.input as SshHostConfig, host) ? state.check : undefined
  const operation = state?.operation, receipt = operation?.receipt, review = state?.review
  const busy = state?.busy !== undefined
  const unresolved = Boolean(operation && (!receipt || receipt.status === 'unknown' || receipt.status === 'running'))
  const adoptionNeeded = receipt?.status === 'completed' && receipt.connectionAdoption?.state !== 'connected'
  const runtimeBlocked = check?.reason === 'runtime-update-required'
  const candidateUnavailable = check?.candidate === null
  // Reported by the maintenance owner beside any receipt; it never replaces the receipt's own detail.
  const unreadable = check?.unreadableOperations?.length ? check.unreadableOperations.join(', ') : undefined
  // The adoption owner's own text, such as why a receipt was not saved for restart; separate from the receipt detail.
  const adoptionDetail = receipt?.connectionAdoption?.detail
  const replacement = check?.reason === 'native-replacement' ? check.nativeReplacement : undefined
  const ready = !state?.error && !state?.checkApplied && check?.candidate && check.eligible && (check.reason === 'ready' || replacement) && check.expected
  const attemptFeedback = !busy && operation?.error ? operation.errorAction === 'reconnect' ? 'This connection attempt was not confirmed. The completed deployment is retained.'
    : operation.errorAction === 'upgrade' ? 'The upgrade response was not confirmed. Check the original operation.'
      : 'This original result check was not confirmed. The previous receipt is retained.' : undefined
  const otherOperationHost = operation && operation.input.id !== host.id
  function update(input: SshHostConfig, change: (previous: State) => State) {
    setEntries(previous => {
      const index = previous.findIndex(item => belongs(item, input))
      if (index === -1) return [...previous, change({ input })]
      return previous.map((item, i) => i === index ? change(item) : item)
    })
  }
  function admitted(input: SshHostConfig) { return active && currentCommitted.current && matches(input, currentHost.current) && matches(input, currentCommitted.current) }
  async function run(input: SshHostConfig, kind: NonNullable<State['busy']>, action: () => Promise<void>) {
    const key = JSON.stringify(route(input))
    if (inFlight.current.has(key)) return
    inFlight.current.add(key)
    update(input, previous => ({ ...previous, busy: kind, error: undefined, refused: undefined }))
    try { await action() }
    catch (error) { update(input, previous => kind === 'checking' || !previous.operation ? { ...previous, error: message(error) }
      : { ...previous, operation: { ...previous.operation, error: message(error), errorAction: kind === 'reconnecting' ? 'reconnect' : kind === 'upgrading' ? 'upgrade' : 'inspect' } }) }
    finally { inFlight.current.delete(key); update(input, previous => ({ ...previous, busy: undefined })) }
  }
  async function inspectVersions() {
    if (!active || !saved || busy) return
    const input = structuredClone(host)
    let observed: RemoteCoreUpgradeCheck | undefined
    await run(input, 'checking', async () => {
      const result = await api.hosts.upgradeCheck(input)
      observed = result
      update(input, previous => ({ ...previous, check: result, checkApplied: false, review: undefined,
        ...(result.latestOperation ? { operation: { ...(previous.operation?.id === result.latestOperation.operationId ? previous.operation : {}), input: result.latestOperation.input as SshHostConfig, id: result.latestOperation.operationId,
          receipt: result.latestOperation, candidate: result.latestOperation.candidate ?? (previous.operation?.id === result.latestOperation.operationId ? previous.operation.candidate : undefined) } } : {}) }))
    })
    return observed
  }
  useEffect(() => {
    if (!active || !saved) { autoChecked.current = undefined; return }
    if (busy || autoChecked.current && matches(autoChecked.current, host)) return
    autoChecked.current = structuredClone(host)
    void inspectVersions()
  }, [active, saved, host, busy])
  function beginReview() {
    if (!ready || !check?.candidate || !admitted(host) || busy || unresolved) return
    const input = structuredClone(host)
    const captured: Review = { input, check: { ...structuredClone(check), candidate: structuredClone(check.candidate) } }
    if (replacement) update(input, previous => ({ ...previous, review: captured }))
    else void applyUpgrade(captured)
  }
  async function confirmUpgrade() {
    if (review) await applyUpgrade(review)
  }
  async function applyUpgrade(captured: Review) {
    if (!captured.check.expected || !admitted(captured.input) || busy || unresolved) return
    // Confirmation applies exactly the reviewed tuple. A new check cannot replace it here.
    await run(captured.input, 'upgrading', async () => {
      const operationId = mintObjectId()
      update(captured.input, previous => ({ ...previous, checkApplied: true, review: undefined, operation: {
        input: captured.input, id: operationId, candidate: captured.check.candidate, expected: captured.check.expected } }))
      try {
        const result = await api.hosts.upgrade(captured.input, captured.check.expected!, operationId)
        update(captured.input, previous => ({ ...previous, operation: { input: captured.input, id: operationId,
          candidate: result.candidate ?? captured.check.candidate, expected: captured.check.expected, receipt: result } }))
      } catch (error) {
        update(captured.input, previous => ({ ...previous, operation: { input: captured.input, id: operationId,
          candidate: captured.check.candidate, expected: captured.check.expected, error: message(error), errorAction: 'upgrade' } }))
      }
    })
  }
  async function readOriginal(reconnect = false) {
    if (!active || busy || !operation || reconnect && receipt?.status !== 'completed') return
    const captured = operation
    await run(captured.input, reconnect ? 'reconnecting' : 'inspecting', async () => {
      const result = reconnect ? await api.hosts.upgradeReconnect(captured.input, captured.id) : await api.hosts.upgradeInspect(captured.input, captured.id)
      // Only an admitted attempt has a record. No receipt yet and no record means the
      // request was refused before admission; nothing ran on the Core.
      if (!reconnect && !result && !captured.receipt) return update(captured.input, previous => ({ ...previous, operation: undefined,
        refused: captured.error ?? 'No record of this upgrade request was found.' }))
      update(captured.input, previous => ({ ...previous, operation: result ? { ...captured, receipt: result,
        candidate: result.candidate ?? captured.candidate, error: undefined, errorAction: undefined } : { ...captured,
          error: 'No confirmed receipt was returned for the original upgrade.', errorAction: reconnect ? 'reconnect' : 'inspect' } }))
    })
  }
  // The admission of the operation in flight, or of its receipt, says whether it replaces the Native.
  const replacing = Boolean(operation?.receipt?.expected.nativeReplacement ?? operation?.expected?.nativeReplacement)
  const status = !saved ? 'Save the connection first' : state?.busy === 'checking' ? 'Checking versions' : state?.busy === 'upgrading' ? replacing ? 'Upgrading Core and Native Runtime' : 'Upgrading Core'
    : state?.busy === 'inspecting' ? 'Checking original result' : state?.busy === 'reconnecting' ? 'Reconnecting to updated Core' : state?.error ? 'Upgrade check unconfirmed' : state?.refused ? 'Upgrade not started'
      : attemptFeedback && !ready ? operation?.errorAction === 'reconnect' ? 'Connection attempt unconfirmed' : operation?.errorAction === 'upgrade' ? 'Upgrade response unconfirmed' : 'Original result check unconfirmed'
        : unresolved ? 'Original upgrade needs checking' : adoptionNeeded && !ready ? 'Connection confirmation needed' : candidateUnavailable ? 'App update candidate unavailable' : check?.reason === 'up-to-date' ? 'Up to date' : runtimeBlocked ? 'Automatic upgrade unavailable' : ready ? replacement ? 'Native Runtime update required' : 'Update available' : receipt?.status === 'completed' ? 'Deployment completed' : 'Version check unconfirmed'
  const detail = state?.error ?? state?.refused ?? operation?.error ?? receipt?.detail ?? check?.detail
  const diagnostics = state && (check || operation || state.error || state.refused) ? [
    `Host: ${host.label} (${host.id})`, `Status: ${status}`, detail ? `Details: ${detail}` : undefined,
    `Deployed Core version: ${check?.current.state === 'available' ? version(check.current.version) : 'Unknown'}`,
    check?.current.state === 'available' ? `Deployed Core source: ${check.current.sourceCommit ?? 'Unknown'}` : undefined,
    check?.current.state === 'available' ? `Deployed content digest: ${check.current.deploymentDigest}` : undefined,
    `App Core version: ${candidateUnavailable ? 'Unavailable' : version(check?.candidate?.version)}`, `App Core source: ${check?.candidate?.sourceCommit ?? 'Unknown'}`,
    check?.candidate ? `App candidate digest: ${check.candidate.digest}` : undefined,
    check?.candidate ? `App Core owner API protocol: ${check.candidate.ownerProtocolVersion ?? 'Unknown'}` : undefined,
    check?.candidate ? `Required Native protocol: ${check.candidate.requiredNativeProtocolVersion}` : undefined,
    check?.candidateUnavailable ? `App candidate unavailable: ${check.candidateUnavailable.code} · ${check.candidateUnavailable.detail}` : undefined,
    check?.current.state !== 'available' && installationDetail ? 'Installation check: ' + installationDetail : undefined,
    operation ? `Operation: ${operation.id}` : undefined,
    operation ? `Original candidate version: ${version(operation.candidate?.version)}` : undefined,
    operation ? `Original candidate digest: ${receipt?.expected.candidateDigest ?? operation.candidate?.digest ?? 'Unknown'}` : undefined,
    receipt ? `Original result: ${receipt.status} / ${receipt.stage}` : undefined,
    receipt?.nativeReplacement?.stateCopy ? `Native state copy: ${receipt.nativeReplacement.stateCopy}` : undefined,
    check?.nativeReplacement ? `Native replacement ends: ${check.nativeReplacement.ending.length} running` : undefined,
    adoptionDetail ? `Connection detail: ${adoptionDetail}` : undefined,
    unreadable ? `Unreadable update records: ${unreadable}` : undefined
  ].filter(value => value !== undefined).join('\n') : undefined
  const [copyState, setCopyState] = useState<{ input: SshHostConfig; text: string; status: 'copying' | 'copied' | 'failed'; error?: string }>()
  const latestCopy = useRef<object | undefined>(undefined)
  const copy = copyState && diagnostics === copyState.text && matches(copyState.input, host) ? copyState : undefined
  async function copyDiagnostics() {
    if (!diagnostics || copy?.status === 'copying') return
    const captured = { input: structuredClone(host), text: diagnostics }; latestCopy.current = captured
    setCopyState({ ...captured, status: 'copying' })
    let failure: string | undefined
    const copied = await copyTextToClipboard(captured.text, error => { failure = message(error) })
    if (latestCopy.current === captured) setCopyState({ ...captured, status: copied ? 'copied' : 'failed', ...(failure ? { error: failure } : {}) })
  }
  return { host, state, check, operation, receipt, review, busy, saved, unresolved, adoptionNeeded, runtimeBlocked, candidateUnavailable, unreadable, adoptionDetail, replacement, ready, attemptFeedback, otherOperationHost, status, detail, diagnostics, copy, replacing, inspectVersions, beginReview, confirmUpgrade, readOriginal, update, copyDiagnostics }
}

/** Presentation only; the Host maintenance composition owns the single controller. */
export function HostUpgradePanel({ maintenance, onCheck, installationDetail, checkingInstallation }: {
  maintenance: ReturnType<typeof useHostUpgrade>; onCheck: () => Promise<void>; installationDetail?: string | undefined; checkingInstallation: boolean
}) {
  const { host, state, check, operation, receipt, review, busy: upgradeBusy, saved, unresolved, adoptionNeeded, runtimeBlocked, candidateUnavailable, unreadable, adoptionDetail, replacement, ready, attemptFeedback, otherOperationHost, status: updateStatus, detail, diagnostics, copy, replacing, beginReview, confirmUpgrade, readOriginal, update, copyDiagnostics } = maintenance
  const busy = upgradeBusy || checkingInstallation
  const status = checkingInstallation ? 'Checking Core' : updateStatus
  const installationDiagnostic = check?.current.state !== 'available' ? installationDetail : undefined
  return <section className="host-upgrade" data-host-upgrade={host.id} aria-label="Remote Core update">
    <div className="host-upgrade__heading"><span className="host-upgrade__title">{busy ? <LoadingIcon size={14} animation="spin" /> : <UpgradeIcon size={14} />}<strong role="status">{status}</strong></span></div>
    <dl className="host-upgrade__versions" aria-label="Current and target Core versions">
      <div><dt>{state?.checkApplied ? 'Last read before upgrade' : `Deployed on ${host.label}`}</dt><dd data-upgrade-current-version>{check?.current.state === 'available' ? version(check.current.version) : 'Unknown'}<small>{check?.current.state === 'available' ? contentLabel(check.current.sourceCommit, check.current.deploymentDigest) : 'Source unknown'}</small></dd></div>
      <span aria-hidden="true">→</span>
      <div><dt>Bundled with this app</dt><dd data-upgrade-candidate-version>{candidateUnavailable ? 'Unavailable' : version(check?.candidate?.version)}<small>{contentLabel(check?.candidate?.sourceCommit, check?.candidate?.digest)}</small></dd></div>
    </dl>
    <p className="field-hint host-upgrade__description" data-upgrade-candidate-unavailable={candidateUnavailable || undefined}>{checkingInstallation ? 'Checking this Host’s original installation facts. Nothing is installed during a check.' : !saved ? 'Save this connection before checking or upgrading.' : state?.busy === 'upgrading' ? replacing ? 'Saving a copy of the Native state, restarting the Native Runtime and starting the updated Core. Running processes end; Sessions and their history are kept.' : 'Updating the original Core service and verifying its retained Runtime. Existing Agent runs are retained.' : state?.busy === 'inspecting' ? 'Reading the original operation result. This does not start another upgrade.' : state?.busy === 'reconnecting' ? 'Connecting this app to the original completed deployment. No new upgrade starts.' : state?.busy === 'checking' ? 'Reading the original service and this app’s candidate. No upgrade starts during a check.' : state?.error ? 'The latest check did not confirm new facts. Existing work remains available.' : state?.refused ? 'The upgrade did not start, and the deployed Core is unchanged. Check Core to try again.' : candidateUnavailable ? operation ? 'A new update candidate is unavailable. The original operation below is retained.' : 'The local update bundle could not be prepared. This read did not change the deployed Core. Use Check Core to try again; Technical details has the cause.' : unresolved ? 'The original upgrade has no confirmed final result. Current version facts remain separate.' : adoptionNeeded && !ready ? 'The original deployment completed. Reconnect to confirm this app’s connection to it.' : runtimeBlocked ? 'This host needs a Native Runtime update that this app cannot safely perform. Existing Agents are retained.' : check?.reason === 'up-to-date' ? 'The deployed Core matches this app’s candidate. No update is needed.' : ready ? replacement ? 'This upgrade also restarts the Native Runtime. Review what ends before confirming.' : 'Update only the Core service. Native Runtime, Sessions and running processes are kept.' : receipt?.status === 'completed' ? 'The original deployment completed. Check Core to read current deployment and app candidate facts.' : 'The Core check is not confirmed. Check this Host again; existing work is retained.'}</p>
    {check ? <div className="host-upgrade__read-time"><ReadTime at={check.current.observedAt} label={state?.checkApplied ? 'Last read before upgrade' : state?.error ? 'Last confirmed check' : 'Checked'} /></div> : null}
    {operation ? <div className="host-upgrade__original" aria-label="Original update receipt">
      <strong>{receipt?.status === 'completed' ? 'Deployment completed' : receipt?.status === 'failed' ? 'Original upgrade did not complete' : receipt?.status === 'running' || !receipt && state?.busy === 'upgrading' ? 'Original upgrade is in progress' : 'Original upgrade result unconfirmed'}</strong>
      {attemptFeedback ? <p className="field-hint" role="status" data-upgrade-attempt-feedback>{attemptFeedback}</p> : null}
      {operation && otherOperationHost ? <p className="field-hint">Original Host: {operation.input.label} ({operation.input.id}). Actions below address that original Host.</p> : null}
      {receipt ? <dl className="host-upgrade__observation"><div><dt>Last reported stage</dt><dd data-upgrade-stage={receipt.stage}>{STAGE_LABELS[receipt.stage]}</dd></div><div><dt>Receipt updated</dt><dd><ReadTime at={receipt.updatedAt} label="" /></dd></div></dl> : null}
      {receipt?.status === 'completed' && receipt.nativeReplacement ? <p className="field-hint" data-upgrade-ended-runs>{receipt.nativeReplacement.endedRunIds.length
        ? `The Native Runtime was replaced and ${plural(receipt.nativeReplacement.endedRunIds.length, 'running process', 'running processes')} ended. Open an ended Session and choose Restore original to continue it; a terminal starts a new shell when you open it.`
        : 'The Native Runtime was replaced. No processes were running, so none ended.'}</p> : null}
      {state?.busy === 'upgrading' && !receipt ? null : <p className="field-hint">{unresolved ? 'Check this original operation before starting another upgrade.' : receipt?.status === 'completed' ? receipt.connectionAdoption?.state === 'connected' ? 'Connection verified at the time below. Current channel status is shown by the Host connection hint.' : 'The deployment is complete. This app’s connection to it is not confirmed.' : 'Check current versions before reviewing another upgrade.'}</p>}
      {receipt?.status === 'completed' ? <div className="host-upgrade__read-time">Connection: {receipt.connectionAdoption?.state === 'connected' ? 'verified' : receipt.connectionAdoption?.state === 'pending-confirmation' ? 'waiting for confirmation' : 'unconfirmed'}{receipt.connectionAdoption ? <> · <ReadTime at={receipt.connectionAdoption.readAt} /></> : null}</div> : null}
    </div> : null}
    {review && matches(review.input, host) && review.check.nativeReplacement ? <NativeReplacementReview review={review} busy={busy || !saved}
        onConfirm={() => void confirmUpgrade()} onCancel={() => update(review.input, previous => ({ ...previous, review: undefined }))} />
: <div className="host-upgrade__actions">
      <button type="button" data-upgrade-action className={state?.busy === 'upgrading' || ready && !unresolved ? 'primary-button' : 'small-button'} disabled={busy || !saved} onClick={() => void (unresolved ? readOriginal() : ready ? beginReview() : adoptionNeeded ? readOriginal(true) : onCheck())}>
        {busy ? checkingInstallation || state?.busy === 'checking' ? 'Checking…' : state?.busy === 'inspecting' ? 'Checking original result…' : state?.busy === 'reconnecting' ? 'Reconnecting…' : 'Upgrading…' : unresolved ? 'Check original result' : ready ? replacement ? 'Review update' : 'Update Core' : adoptionNeeded ? operation && otherOperationHost ? `Reconnect ${operation.input.label}` : 'Reconnect to updated Core' : 'Check Core'}
      </button>
      {check && !unresolved && !adoptionNeeded && ready ? <Button type="button" data-upgrade-refresh disabled={busy || !saved} onClick={() => void onCheck()}>Check again</Button> : null}
      {ready && !unresolved && adoptionNeeded ? <Button type="button" data-upgrade-reconnect disabled={busy || !saved} onClick={() => void readOriginal(true)}>Reconnect original update{operation && otherOperationHost ? ` · ${operation.input.label}` : ''}</Button> : null}
      {!ready && !unresolved && adoptionNeeded ? <Button type="button" data-upgrade-refresh disabled={busy || !saved} onClick={() => void onCheck()}>Check Core</Button> : null}
    </div>}
    {unreadable ? <p className="field-hint host-upgrade__next-step" data-upgrade-unreadable-records>Could not read update record {unreadable}. Its Host and result are unknown, and it will not run again. To report it, copy diagnostics from Technical details.</p> : null}
    {runtimeBlocked ? <p className="field-hint host-upgrade__next-step">Share the diagnostics with this host’s maintainer to arrange a supported Native Runtime update.</p> : null}
    {diagnostics ? <details className="host-upgrade__details"><summary>Technical details <DownIcon size={13} /></summary><div className="host-upgrade__diagnostics">
      {check?.candidateUnavailable ? <div><span className="host-upgrade__detail-label">App candidate unavailable · {check.candidateUnavailable.code}</span><p className="host-upgrade__diagnostic-message">{check.candidateUnavailable.detail}</p></div> : null}
      {detail ? <div><span className="host-upgrade__detail-label">Original diagnostic</span><p className="host-upgrade__diagnostic-message">{detail}</p></div> : null}
      {installationDiagnostic ? <div><span className="host-upgrade__detail-label">Installation check</span><p className="host-upgrade__diagnostic-message">{installationDiagnostic}</p></div> : null}
      {adoptionDetail ? <div><span className="host-upgrade__detail-label">Connection detail</span><p className="host-upgrade__diagnostic-message" data-upgrade-connection-detail>{adoptionDetail}</p></div> : null}
      <dl className="host-upgrade__facts">
        {check?.current.state === 'available' ? <><div><dt>Deployed Core source</dt><dd><code>{check.current.sourceCommit ?? 'Unknown'}</code></dd></div><div><dt>Deployed content digest</dt><dd><code>{check.current.deploymentDigest}</code></dd></div></> : null}
        {check ? <>{check.candidate ? <><div><dt>App Core source</dt><dd><code>{check.candidate.sourceCommit ?? 'Unknown'}</code></dd></div><div><dt>App candidate digest</dt><dd><code>{check.candidate.digest}</code></dd></div></> : null}<div><dt>Core owner API protocol · deployed / app</dt><dd>{check.current.state === 'available' ? check.current.ownerProtocolVersion : 'Unknown'} / {check.candidate?.ownerProtocolVersion ?? 'Unknown'}</dd></div><div><dt>Native protocol · current / required</dt><dd>{check.current.state === 'available' ? check.current.native.protocolVersion : 'Unknown'} / {check.candidate?.requiredNativeProtocolVersion ?? 'Unknown'}</dd></div></> : null}
        {receipt?.nativeReplacement?.stateCopy ? <div><dt>Native state copy</dt><dd><code>{receipt.nativeReplacement.stateCopy}</code></dd></div> : null}
        {operation ? <><div><dt>Original operation</dt><dd><code>{operation.id}</code></dd></div><div><dt>Original upgrade candidate version</dt><dd>{version(operation.candidate?.version)}</dd></div><div><dt>Original upgrade candidate digest</dt><dd><code>{operation.receipt?.expected.candidateDigest ?? operation.candidate?.digest ?? 'Unknown'}</code></dd></div></> : null}
        {unreadable ? <div><dt>Unreadable update records</dt><dd><code>{unreadable}</code></dd></div> : null}
      </dl><Button type="button" data-copy-upgrade-diagnostics disabled={copy?.status === 'copying'} onClick={() => void copyDiagnostics()}><CopyIcon size={13} />{copy?.status === 'copying' ? 'Copying…' : copy?.status === 'copied' ? 'Copied' : 'Copy diagnostics'}</Button>
    </div></details> : null}
    {copy?.status === 'copied' ? <p className="host-upgrade__copy-feedback" role="status">Diagnostics copied.</p> : copy?.status === 'failed' ? <p className="host-upgrade__copy-feedback host-upgrade__copy-feedback--error" role="alert">Could not copy diagnostics. Try again.{copy.error ? ` ${copy.error}` : ''}</p> : null}
  </section>
}
