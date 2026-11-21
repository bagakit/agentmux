import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Switch, Textarea, TextInput } from '@agentmux/client-ui/input'
import { mintObjectId } from '@agentmux/core/object-id'
import type { MeshPeerCode } from '@agentmux/core/mesh-peer-code'
import type { MeshNetworkInspection, MeshNetworkSettings, MeshOwnerTarget } from '@agentmux/core/mesh-network'
import { api } from '../../lib/api'
import { useAppStore, updateMeshSettingsDraft } from '../../store'
import { configValuesEqual } from '../../../../shared/config-edit'
import { meshConfiguration, meshDraftForRuntime, meshForm, meshPeerCode, meshPeerFormPatch, type MeshForm, type MeshSettingsDraft } from '../../lib/mesh-settings-draft'
import { SettingsSaveBar } from './SettingsSaveBar'
import { MeshNetworkMap } from './MeshNetworkMap'
import { MeshAccessLinks } from './MeshAccessLinks'
import { MeshOperatorTarget } from './MeshOperatorTarget'
import { MeshPeerPairing } from './MeshPeerPairing'
import { MeshGatewayJoin } from './MeshGatewayJoin'
import { ServiceWindowNotice } from '../ServiceWindowNotice'
import { ConfirmationDialog } from '../ConfirmationDialog'
import { useLocalRuntimeRecovery } from '../../lib/use-local-runtime-recovery'
import './mesh-settings.css'

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
const retained = (edit: MeshSettingsDraft): MeshSettingsDraft | undefined => edit.pending || edit.linkInput || edit.pairingInput || !configValuesEqual(edit.form, meshForm(edit.baseline.configuration, edit.baseline.identity?.peerId)) ? edit : undefined

function confirmMeshDraft(edit: MeshSettingsDraft, confirmed: MeshNetworkSettings) {
  const form = meshForm(confirmed.configuration, confirmed.identity?.peerId)
  const pending = edit.pending!
  if (pending.gatewayCode || pending.peerApproval) {
    const hadAdvancedEdits = !configValuesEqual(edit.form, meshForm(edit.baseline.configuration, edit.baseline.identity?.peerId))
    const updated = { ...edit, pending: undefined, baseline: hadAdvancedEdits ? edit.baseline : confirmed, form: hadAdvancedEdits ? edit.form : form }
    if (pending.peerApproval && updated.pairingInput?.trim() === pending.peerApproval) delete updated.pairingInput
    return retained(updated)
  }
  const later = !configValuesEqual(edit.form, pending.submittedForm) || confirmed.operation && confirmed.operation.revision !== confirmed.revision
  return retained({ ...edit, pending: undefined, baseline: confirmed, form: later ? edit.form : form })
}

type EditorProps = { active: boolean; onConnections?: () => void; showTopology?: boolean; join?: boolean; onAccess?: () => void; onManage?: () => void; onDone?: () => void }

export function MeshNetworkSettings(props: EditorProps) {
  if (props.join) return <MeshNetworkEditor {...props} target={undefined} deviceLabel="This device" />
  return <MeshOperatorTarget label="Device to manage" active={props.active}>{(target, label) =>
    <MeshNetworkEditor {...props} target={target} deviceLabel={label} />
  }</MeshOperatorTarget>
}

function MeshNetworkEditor({ active, onConnections, showTopology = true, join, onAccess, onManage, onDone, target, deviceLabel }: EditorProps & { target: MeshOwnerTarget | undefined; deviceLabel: string }) {
  const [settings, setSettings] = useState<MeshNetworkSettings>(), [networkSnapshot, setSnapshot] = useState<MeshNetworkInspection>()
  const [issue, setIssue] = useState(''), [networkIssue, setNetworkIssue] = useState(''), [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false), [reading, setReading] = useState(false), [newer, setNewer] = useState<MeshNetworkSettings>()
  const [copyFeedback, setCopyFeedback] = useState('')
  const [openingIdentity, setOpeningIdentity] = useState(false), [identitySetupIssue, setIdentitySetupIssue] = useState(''), [identitySetupRequested, setIdentitySetupRequested] = useState(false)
  const [confirmNewIdentity, setConfirmNewIdentity] = useState(false)
  const pairingField = useRef<HTMLInputElement>(null)
  const edits = useAppStore(state => state.meshSettingsDrafts)
  const current = useRef(settings); current.current = settings
  const networkReading = useRef(false)
  const readEpoch = useRef(0), reader = useRef<AbortController | undefined>(undefined), visible = useRef(active)
  useLayoutEffect(() => { visible.current = active; return () => { visible.current = false } }, [active])
  const destination = target ? { target } : {}
  let edit: MeshSettingsDraft | undefined, editIssue = ''
  try { if (settings) edit = meshDraftForRuntime(edits, settings.owner.runtimeId) } catch (cause) { editIssue = message(cause) }
  const saved = edit?.baseline ?? settings, form = edit?.form ?? (settings ? meshForm(settings.configuration, settings.identity?.peerId) : undefined)
  const dirty = Boolean(saved && form && !configValuesEqual(form, meshForm(saved.configuration, saved.identity?.peerId)))
  const originalOffer = edit?.linkInput ?? ''
  const pending = edit?.pending
  const snapshot = networkSnapshot && (!settings || networkSnapshot.owner.runtimeId === settings.owner.runtimeId && networkSnapshot.owner.ownerInstanceId === settings.owner.ownerInstanceId) ? networkSnapshot : undefined
  const network = snapshot?.network

  async function copy(text: string) {
    try { await api.ui.writeClipboardText(text); setCopyFeedback('Copied') } catch (cause) { setCopyFeedback(message(cause)) }
  }
  const inspectNetwork = useCallback(async (signal?: AbortSignal) => {
    if (networkReading.current) return
    networkReading.current = true
    try {
      const original = current.current?.owner
      const result = await api.mesh.call('mesh.inspect', destination, { ...(signal ? { signal } : {}), ...(original ? { expectedOwner: original } : {}) })
      if (!signal?.aborted && (!current.current || result.owner.runtimeId === current.current.owner.runtimeId && result.owner.ownerInstanceId === current.current.owner.ownerInstanceId)) { setSnapshot(result); setNetworkIssue('') }
    } catch (cause) { if (!signal?.aborted) setNetworkIssue(message(cause)) }
    finally { networkReading.current = false }
  }, [target?.hostId, target?.expectedRuntimeId])

  async function inspect(operationId?: string) {
    reader.current?.abort(); const controller = new AbortController(); reader.current = controller
    const epoch = ++readEpoch.current, originalRuntime = current.current?.owner.runtimeId
    setReading(true); setIssue(''); setNotice('')
    // Network observation and editable settings are independent capabilities.
    void inspectNetwork(controller.signal)
    try {
      // A restarted original Core may have a new process fence, never a replacement Runtime.
      const result = await api.mesh.call('settings.mesh.inspect', { ...destination, ...(operationId ? { operationId } : {}) }, { signal: controller.signal })
      if (controller.signal.aborted || epoch !== readEpoch.current) return
      if (originalRuntime && result.owner.runtimeId !== originalRuntime) throw new Error('Another Core answered. The original Mesh draft and request are retained for their Runtime.')
      current.current = result; setSettings(result)
      const held = meshDraftForRuntime(useAppStore.getState().meshSettingsDrafts, result.owner.runtimeId)
      if (operationId && held?.pending?.operationId === operationId) {
        if (result.operation?.status === 'confirmed' && result.operation.expectedRevision === held.pending.expectedRevision) {
          await updateMeshSettingsDraft(result.owner.runtimeId, value => {
            if (value?.pending?.operationId !== operationId) return value
            return confirmMeshDraft(value, result)
          }, true)
          const remaining = meshDraftForRuntime(useAppStore.getState().meshSettingsDrafts, result.owner.runtimeId)
          if (!join && (result.operation.revision !== result.revision || remaining && remaining.baseline.revision !== result.revision)) setNewer(result)
          setNotice('Original Mesh save confirmed')
        } else setIssue(result.operation === null ? 'The original save is not recorded. Your draft and operation are retained; inspect the original Core before another save.' : 'The original save remains unconfirmed. Its input and operation are retained.')
      } else if (held?.pending) {
        void inspect(held.pending.operationId)
      } else if (!join) {
        const conflict = held && held.baseline.revision !== result.revision
        setNewer(conflict ? result : undefined)
        if (conflict) setIssue('Saved Mesh settings changed. Review the saved version or keep your draft before saving.')
      }
      return true
    } catch (cause) { if (!controller.signal.aborted && epoch === readEpoch.current) setIssue(message(cause)) }
    finally { if (epoch === readEpoch.current) setReading(false) }
  }
  useEffect(() => { if (active) void inspect(); return () => { reader.current?.abort(); setReading(false) } }, [active])
  useEffect(() => {
    if (!active || !settings) return
    const controller = new AbortController()
    void inspectNetwork(controller.signal)
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void inspectNetwork(controller.signal) }, 3000)
    return () => { clearInterval(timer); controller.abort() }
  }, [active, settings?.owner.runtimeId, settings?.owner.ownerInstanceId, inspectNetwork])

  function change(patch: Partial<MeshForm>, pairingInput?: string) {
    if (!saved || !form) return
    setNotice('')
    void updateMeshSettingsDraft(saved.owner.runtimeId, value => retained({ ...value, baseline: value?.baseline ?? saved,
      form: { ...(value?.form ?? form), ...patch }, ...(pairingInput !== undefined ? { pairingInput } : {}), ...(value?.pending ? { pending: value.pending } : {}) })).catch(cause => setIssue(message(cause)))
  }
  async function save(connection?: { form: MeshForm; gatewayCode?: string; peerApproval?: string }) {
    const baseline = connection ? settings : saved
    if (!baseline || !form || saving || pending || (!connection && newer) || editIssue) return
    let sent = false, operationId = ''
    setIssue(''); setNotice(''); setSaving(true); reader.current?.abort(); ++readEpoch.current
    try {
      const submittedForm = connection?.form ?? form
      const configuration = meshConfiguration(submittedForm, baseline.configuration, settings?.identity ?? undefined), runtimeId = baseline.owner.runtimeId
      operationId = mintObjectId()
      await updateMeshSettingsDraft(runtimeId, value => {
        if (value?.pending) throw new Error('A Mesh save is already being checked. Continue with that save first.')
        return { ...value, baseline: value?.baseline ?? baseline, form: value?.form ?? form,
          pending: { operationId, expectedRevision: baseline.revision, submitted: configuration, submittedForm, phase: 'in-flight',
            ...(connection?.gatewayCode ? { gatewayCode: connection.gatewayCode } : {}), ...(connection?.peerApproval ? { peerApproval: connection.peerApproval } : {}) } }
      }, true)
      sent = true
      const result = await api.mesh.call('settings.mesh.configure', { ...destination, expectedRevision: baseline.revision, operationId, configuration }, { expectedOwner: settings!.owner })
      if (result.settings.owner.runtimeId !== runtimeId) throw new Error('Mesh save returned another Runtime. The original request is retained.')
      if (result.diskDurability !== 'confirmed') throw new Error('The original Mesh disk acknowledgement is unknown. Inspect this save before trying again.')
      await updateMeshSettingsDraft(runtimeId, value => {
        if (value?.pending?.operationId !== operationId) return value
        return confirmMeshDraft(value, result.settings)
      }, true)
      current.current = result.settings; setSettings(result.settings); setNotice('Mesh settings saved')
      const held = meshDraftForRuntime(useAppStore.getState().meshSettingsDrafts, runtimeId)
      setNewer(!join && held && held.baseline.revision !== result.settings.revision ? result.settings : undefined)
      if (visible.current) void inspectNetwork()
    } catch (cause) {
      const failure = cause as { code?: string; controlFailure?: { disposition?: string } }
      const notApplied = !sent || failure?.controlFailure?.disposition === 'not_applied'
      if (operationId) await updateMeshSettingsDraft(baseline.owner.runtimeId, value => {
        if (value?.pending?.operationId !== operationId) return value
        if (!notApplied) return { ...value, pending: { ...value.pending, phase: 'unknown' } }
        return retained({ ...value, pending: undefined })
      }, true).catch(() => {})
      setIssue(message(cause))
      if (visible.current && connection && (!notApplied || failure?.code === 'MESH_REVISION_CHANGED')) {
        const read = await inspect(notApplied ? undefined : operationId)
        if (notApplied && read) setNotice(connection.peerApproval ? 'Settings refreshed. Confirm the device to approve it.' : 'Settings refreshed. Confirm the selected gateway to connect.')
      }
    } finally { setSaving(false) }
  }
  async function resolveDraft(keep: boolean) {
    if (!newer) return
    await updateMeshSettingsDraft(newer.owner.runtimeId, value => value ? retained({ ...value, baseline: newer, form: keep ? value.form : meshForm(newer.configuration, newer.identity?.peerId) }) : undefined, true)
    setSettings(newer); setNewer(undefined); setIssue('')
  }
  function approvePeer(code: string, peer: MeshPeerCode) {
    if (!settings) return
    const latest = meshForm(settings.configuration, settings.identity?.peerId)
    const patch = meshPeerFormPatch(latest, code, peer, settings.identity?.peerId, false)
    void save({ form: { ...latest, ...patch }, peerApproval: code })
  }
  const peerCode = settings && settings.configuration.role !== 'disabled' ? meshPeerCode(settings) : null
  const hasTopology = Boolean(network && (network.peers.length || network.records.length || network.routes.length))
  const identityRecovery = useLocalRuntimeRecovery(active && !target && !settings, () => { void inspect() })
  const refresh = () => { if (!settings && !target) identityRecovery.refresh(); void inspect() }
  const newIdentityWindow = !target && api.ui.isNewIdentityWindow
  async function openIdentitySetup(code?: string) {
    setOpeningIdentity(true); setIdentitySetupIssue('')
    try { if (code) await api.ui.openLocalIdentitySetup(code); else await api.ui.openLocalIdentitySetup(); setIdentitySetupRequested(true) }
    catch (cause) { setIdentitySetupIssue(message(cause)) }
    finally { setOpeningIdentity(false) }
  }
  const identitySetupAction = newIdentityWindow || target ? null : <button
    className={identityRecovery.notice ? 'primary-button' : 'small-button'} type="button"
    disabled={openingIdentity || identityRecovery.restoring} onClick={() => setConfirmNewIdentity(true)}>
    {openingIdentity ? 'Opening setup…' : 'Set up a new identity…'}
  </button>
  const identitySetupError = identitySetupIssue ? <p className="settings-inline-error" role="alert">{identitySetupIssue}</p> : null
  const recoveryNotice = identityRecovery.notice?.notice
  const conflict = newer ? <div className="mesh-conflict" role="alert"><span>The saved version changed. Your edit is retained.</span><button className="small-button" onClick={() => void resolveDraft(false)}>Use saved</button><button className="small-button" onClick={() => void resolveDraft(true)}>Keep my draft</button></div> : null
  const pendingAction = pending ? <div className="mesh-pending"><button className="small-button" disabled={saving || reading} onClick={() => void inspect(pending.operationId)}>Inspect original save</button><code>{pending.operationId}</code></div> : null

  if (join) return <MeshGatewayJoin active={active} settings={settings} snapshot={snapshot} networkIssue={networkIssue} peerCode={peerCode}
    issue={issue} draftIssue={editIssue} notice={notice} reading={reading} saving={saving} pending={pending}
    onConnect={(form, gatewayCode) => void save({ form, gatewayCode })} onCheck={refresh} onCopy={copy} copyFeedback={copyFeedback}
    onAccess={onAccess} onManage={onManage} onDone={onDone} onCheckSave={() => { if (pending) void inspect(pending.operationId) }}
    identityRecovery={identityRecovery} openSeparate={newIdentityWindow || target ? undefined : openIdentitySetup} openingSeparate={openingIdentity}
    separateIssue={identitySetupIssue} separateRequested={identitySetupRequested} />

  return <div className="mesh-network-settings" data-mesh-settings data-settings-field="mesh-configuration">
    <ConfirmationDialog open={active && confirmNewIdentity} intent="neutral" title="Create a separate identity?"
      description="AgentMux opens a new window with its own identity. Your current window and saved work stay available. Enter the gateway code in the new window."
      confirmLabel="Create and open setup" onCancel={() => setConfirmNewIdentity(false)}
      onConfirm={() => { setConfirmNewIdentity(false); void openIdentitySetup() }} />
    {!identityRecovery.notice ? <header className="mesh-network-heading">
      {newIdentityWindow ? <div className="mesh-connection-intro"><div><h3>New identity setup</h3><p>Pair this window with your gateway. Your original work stays in its own window.</p></div></div> : <div className="mesh-connection-intro"><div><h3>{deviceLabel}’s network</h3><p>Add a trusted peer or publish a gateway address for other devices.</p></div></div>}
      {settings || !issue ? <button className="small-button" onClick={refresh} disabled={reading || saving}>{reading ? 'Reading…' : 'Refresh'}</button> : null}
    </header> : null}
    {identityRecovery.notice ? <div className="mesh-identity-recovery">
      <ServiceWindowNotice notice={recoveryNotice && identitySetupAction
        ? { ...recoveryNotice, notice: { ...recoveryNotice.notice,
          restore: `${recoveryNotice.notice.restore} A new identity opens in a separate window.` } }
        : recoveryNotice ?? null}
        actions={<div className="mesh-recovery-actions">
          {identitySetupAction}
          <button className="small-button" type="button" onClick={refresh} disabled={identityRecovery.restoring}>Check again</button>
          {identityRecovery.canImport ? <button className="small-button" type="button" disabled={identityRecovery.restoring} onClick={identityRecovery.notice.action?.run}>{identityRecovery.notice.action?.label}</button> : null}
          {onConnections ? <button className="small-button" type="button" onClick={onConnections}>Open saved connections</button> : null}
        </div>} />
      {identitySetupError}
      <details className="mesh-advanced"><summary>Technical details</summary><p>{identityRecovery.notice.detail}</p></details>
    </div>
    : !settings ? <section className="mesh-availability" role={issue ? 'alert' : 'status'}>
      <span className="mesh-section-kicker">{issue ? 'Setup unavailable' : 'Connecting to this Core'}</span>
      <h3>{issue ? 'Couldn’t read Mesh settings.' : 'Reading your network settings…'}</h3>
      <p>{issue ? 'Check this Core’s connection and version, then refresh. Your saved device connections are still available.' : 'You can keep using your saved connections while this Core responds.'}</p>
      <div className="mesh-recovery-actions">{issue ? <button className="primary-button" onClick={refresh} disabled={reading}>{reading ? 'Reading…' : 'Refresh Mesh'}</button> : null}{onConnections ? <button className="small-button" onClick={onConnections}>Open saved connections</button> : null}</div>
      {issue ? <details className="mesh-advanced"><summary>Technical details</summary><p>{issue}</p>{networkIssue ? <p>Network observation: {networkIssue}</p> : null}</details> : null}
    </section> : null}
    {snapshot ? <div className="mesh-network-status" role="status"><strong>{networkIssue ? 'Last confirmed · ' : ''}{snapshot.source === 'static' ? 'Startup configuration active' : snapshot.apply.state === 'active' ? 'Mesh active' : snapshot.apply.state === 'disabled' ? 'Mesh disabled' : snapshot.apply.state === 'starting' ? 'Applying settings…' : 'Mesh apply unavailable'}</strong>{network ? <span>{network.peers.filter(peer => peer.state === 'connected').length} authenticated peer{network.peers.filter(peer => peer.state === 'connected').length === 1 ? '' : 's'} · {network.routes.length} known route{network.routes.length === 1 ? '' : 's'}</span> : null}{snapshot.gateway.state === 'listening' ? <span>Listening on {snapshot.gateway.listener?.host}:{snapshot.gateway.listener?.port}</span> : null}{snapshot.apply.issue ? <span className="settings-inline-error">{snapshot.apply.issue.message}</span> : null}{snapshot.activeRevision && snapshot.desiredRevision !== snapshot.activeRevision ? <span>Saved settings differ from the active network.</span> : null}</div> : null}
    {networkIssue && (settings || snapshot) ? <div className="mesh-network-note" role="status"><strong>Network observation unavailable.</strong><p>{snapshot ? 'The last confirmed view is retained. Refresh to check again.' : 'Current connections haven’t been confirmed. Refresh to check again.'}</p><details className="mesh-advanced"><summary>Technical details</summary><p>{networkIssue}</p></details></div> : null}
    {showTopology ? <>{hasTopology ? <MeshNetworkMap snapshot={snapshot} /> : null}</> : null}
    {form && saved ? <>
      {snapshot?.source === 'static' ? <p className="mesh-network-note">A startup gateway configuration is active. Saving these complete Mesh settings replaces that configuration and its publisher admissions; the original file is kept.</p> : null}
      {editIssue ? <p role="alert" className="settings-inline-error">{editIssue}</p> : <section className="mesh-network-section">
        <header><h4>Network participation</h4>{form.role === 'participant' ? <button className="small-button" onClick={() => change({ role: 'disabled' })}>Leave network</button> : null}</header>
        <div className="mesh-task-options" role="group" aria-label="Network participation">
          <button type="button" aria-pressed={form.role !== 'disabled'} onClick={() => { change({ role: form.role === 'gateway' ? 'gateway' : 'participant' }); pairingField.current?.focus() }}><span className="mesh-task-label"><strong>Connect to a gateway</strong><span aria-hidden="true">→</span></span><span>This device can join using an outbound connection.</span></button>
          <button type="button" aria-pressed={form.role === 'gateway'} onClick={() => change({ role: 'gateway' })}><span className="mesh-task-label"><strong>Provide a gateway</strong><span aria-hidden="true">{form.role === 'gateway' ? '✓' : '↗'}</span></span><span>Let devices connect here, including while this device uses an upstream gateway.</span></button>
        </div>
        <MeshPeerPairing input={edit?.pairingInput ?? ''} form={form} ownPeerId={settings?.identity?.peerId} inputRef={pairingField} allowNewNetwork={saved.configuration.role === 'disabled' && form.networkId === saved.configuration.networkId}
          onInput={value => change({}, value)} onAdd={patch => change(patch, '')}
          onApprove={settings?.configuration.role === 'gateway' && snapshot?.source === 'managed' ? approvePeer : undefined} busy={saving || Boolean(pending)} />
        {pending?.peerApproval ? pendingAction : null}
        <div className="mesh-code-action">{peerCode ? <><button className="small-button" onClick={() => void copy(peerCode)}>Copy saved connection code</button><span className="field-hint">{dirty ? 'Save changes before sharing the updated code.' : 'Exchange codes with the other device. Each device adds its peer and saves.'}</span></> : <p className="field-hint">Add the peer and save. Then copy this device’s code back to its operator.</p>}</div>
        <details className="mesh-advanced"><summary>Network name and peer codes{form.peers.trim() ? ` · ${form.peers.trim().split(/\s+/u).length} saved or pending` : ''}</summary>
          <label className="mesh-form-field"><span>Network name</span><TextInput aria-label="Mesh network" value={form.networkId} onChange={event => change({ networkId: event.target.value })} /></label>
          <label className="mesh-form-field"><span>Trusted peer codes</span><Textarea aria-label="Mesh peer codes" value={form.peers} onChange={event => change({ peers: event.target.value })} rows={3} /></label>
        </details>
        {form.role === 'gateway' ? <div className="mesh-gateway-fields"><header><h4>Gateway address</h4><p className="field-hint">Use an address the other devices can reach, such as an internal IP or hostname.</p></header><label className="mesh-toggle"><Switch aria-label="Own Mesh listener" checked={form.listen} onChange={event => change({ listen: event.target.checked })} /><span>Listen on a dedicated address</span></label>{form.listen ? <div className="mesh-form-grid"><label><span>Listen address</span><TextInput aria-label="Mesh listen address" value={form.host} onChange={event => change({ host: event.target.value })} /></label><label><span>Port</span><TextInput aria-label="Mesh listen port" value={form.port} inputMode="numeric" onChange={event => change({ port: event.target.value })} /></label></div> : <p className="field-hint">Enable a dedicated listener, or use this Core’s existing HTTP listener.</p>}<label className="mesh-form-field"><span>Address to share with other devices</span><Textarea aria-label="Mesh published origins" value={form.ingress} onChange={event => change({ ingress: event.target.value })} rows={2} placeholder="http://your-gateway:8444" /></label><p className="field-hint">Other devices use this address to connect.</p><button className="small-button" onClick={() => change({ role: 'participant' })}>Stop providing a gateway</button><p className="field-hint">Saving this change removes the listener and shared addresses. Outbound connections remain available.</p></div> : null}
        <details className="mesh-advanced mesh-device-access"><summary>Allow devices to access this Core{form.clientKeys.trim() ? ' · configured' : ''}</summary>
          <p className="field-hint">Joining a network connects peers. Access to this Core is granted separately.</p>
          <p className="field-hint">{snapshot?.endpoint.state === 'not-provided' ? 'This deployment forwards network traffic without a local Host endpoint.' : snapshot?.endpoint.state === 'available' ? 'This Core’s endpoint is available. Add each accessing device’s public key below.' : snapshot?.endpoint.state === 'starting' ? 'This Core’s endpoint is starting.' : 'Enable participation, then refresh to check this Core’s endpoint.'}</p>
          <label className="mesh-form-field"><span>Allowed device public keys</span><Textarea aria-label="Mesh device public keys" value={form.clientKeys} onChange={event => change({ clientKeys: event.target.value })} rows={3} placeholder="One public key per line" /></label><p className="field-hint">On the device that will use this Core, open its access link and copy the access key. Add that key on a new line here, then save to approve the device.</p>
        </details>
        <details className="mesh-advanced"><summary>Advanced network settings</summary><div className="mesh-form-grid"><label><span>TLS key file</span><TextInput aria-label="Mesh TLS key path" value={form.keyPath} onChange={event => change({ keyPath: event.target.value })} /></label><label><span>TLS certificate file</span><TextInput aria-label="Mesh TLS certificate path" value={form.certPath} onChange={event => change({ certPath: event.target.value })} /></label></div><label className="mesh-form-field"><span>Additional publisher grants</span><Textarea aria-label="Mesh publisher grants" value={form.publishers} onChange={event => change({ publishers: event.target.value })} rows={3} /></label><p className="field-hint">Server IDs and token hashes for separately hosted publishers. Host deployments connect their own endpoint automatically.</p><code>{settings?.identity?.peerId ?? 'Network identity not created'}</code></details>
      </section>}
      {conflict}
      <SettingsSaveBar save={{ state: issue || editIssue ? 'error' : saving ? 'saving' : notice ? 'saved' : 'idle', error: issue || editIssue, saving }} dirty={dirty || Boolean(pending)} label="Save Mesh settings" scopeLabel="Mesh" onSave={() => void save()} blocked={pending ? 'Inspect the original save first' : newer ? 'Review the current saved version' : editIssue || undefined} />
      {!pending?.peerApproval ? pendingAction : null}
      {notice ? <p role="status" className="mesh-network-notice">{notice}</p> : null}
    </> : null}
    {settings && form && saved ? <MeshAccessLinks active={active} target={target} deviceLabel={deviceLabel} snapshot={snapshot} offerText={originalOffer} copy={copy}
      onInput={text => { void updateMeshSettingsDraft(saved.owner.runtimeId, value => retained({ ...value, baseline: value?.baseline ?? saved,
        form: value?.form ?? form, linkInput: text })).catch(cause => setIssue(message(cause))) }} /> : null}
    {settings && identitySetupAction ? <details className="mesh-advanced">
      <summary>Separate identity setup</summary>
      <p>Open the separate setup again, or start it and pair a new identity with your gateway.</p>
      {identitySetupAction}{identitySetupError}
    </details> : null}
    {copyFeedback ? <p role="status" className="mesh-copy-feedback">{copyFeedback}</p> : null}
  </div>
}
