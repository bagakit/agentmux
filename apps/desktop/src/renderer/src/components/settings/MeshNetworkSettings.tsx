import { useCallback, useEffect, useRef, useState } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import { mintObjectId } from '@agentmux/core/object-id'
import type { MeshNetworkInspection, MeshNetworkLink, MeshNetworkSettings } from '@agentmux/core/mesh-network'
import { api } from '../../lib/api'
import { useAppStore, updateMeshSettingsDraft } from '../../store'
import { configValuesEqual } from '../../../../shared/config-edit'
import { meshConfiguration, meshDraftForRuntime, meshForm, meshPeerCode, type MeshForm, type MeshSettingsDraft } from '../../lib/mesh-settings-draft'
import { SettingsSaveBar } from './SettingsSaveBar'
import { MeshNetworkMap } from './MeshNetworkMap'
import { MeshConnectionIntro } from './MeshConnectionIntro'
import { ServiceWindowNotice } from '../ServiceWindowNotice'
import { useLocalRuntimeRecovery } from '../../lib/use-local-runtime-recovery'
import './mesh-settings.css'

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
const retained = (edit: MeshSettingsDraft): MeshSettingsDraft | undefined => edit.pending || edit.linkInput || !configValuesEqual(edit.form, meshForm(edit.baseline.configuration, edit.baseline.identity?.peerId)) ? edit : undefined

export function MeshNetworkSettings({ active, onConnections, showTopology = true }: { active: boolean; onConnections?: () => void; showTopology?: boolean }) {
  const [settings, setSettings] = useState<MeshNetworkSettings>(), [networkSnapshot, setSnapshot] = useState<MeshNetworkInspection>()
  const [issue, setIssue] = useState(''), [networkIssue, setNetworkIssue] = useState(''), [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false), [reading, setReading] = useState(false), [newer, setNewer] = useState<MeshNetworkSettings>()
  const [link, setLink] = useState<MeshNetworkLink>(), [linkIssue, setLinkIssue] = useState('')
  const [copyFeedback, setCopyFeedback] = useState(''), [linking, setLinking] = useState(false)
  const edits = useAppStore(state => state.meshSettingsDrafts)
  const current = useRef(settings); current.current = settings
  const linkRequest = useRef<{ input: string; owner: MeshNetworkSettings['owner']; controller: AbortController } | undefined>(undefined)
  const networkReading = useRef(false)
  const readEpoch = useRef(0), reader = useRef<AbortController | undefined>(undefined), visible = useRef(active); visible.current = active
  let edit: MeshSettingsDraft | undefined, editIssue = ''
  try { if (settings) edit = meshDraftForRuntime(edits, settings.owner.runtimeId) } catch (cause) { editIssue = message(cause) }
  const saved = edit?.baseline ?? settings, form = edit?.form ?? (settings ? meshForm(settings.configuration, settings.identity?.peerId) : undefined)
  const dirty = Boolean(saved && form && !configValuesEqual(form, meshForm(saved.configuration, saved.identity?.peerId)))
  const originalOffer = edit?.linkInput ?? ''
  const pending = edit?.pending
  const snapshot = networkSnapshot && (!settings || networkSnapshot.owner.runtimeId === settings.owner.runtimeId && networkSnapshot.owner.ownerInstanceId === settings.owner.ownerInstanceId) ? networkSnapshot : undefined
  const network = snapshot?.network
  const endpointOffer = snapshot?.endpoint.state === 'available' ? snapshot.endpoint.offer : undefined

  async function copy(text: string) {
    try { await api.ui.writeClipboardText(text); setCopyFeedback('Copied') } catch (cause) { setCopyFeedback(message(cause)) }
  }
  const inspectNetwork = useCallback(async (signal?: AbortSignal) => {
    if (networkReading.current) return
    networkReading.current = true
    try {
      const original = current.current?.owner
      const result = await api.mesh.call('mesh.inspect', {}, { ...(signal ? { signal } : {}), ...(original ? { expectedOwner: original } : {}) })
      if (!signal?.aborted && (!current.current || result.owner.runtimeId === current.current.owner.runtimeId && result.owner.ownerInstanceId === current.current.owner.ownerInstanceId)) { setSnapshot(result); setNetworkIssue('') }
    } catch (cause) { if (!signal?.aborted) setNetworkIssue(message(cause)) }
    finally { networkReading.current = false }
  }, [])

  async function inspect(operationId?: string) {
    reader.current?.abort(); const controller = new AbortController(); reader.current = controller
    const epoch = ++readEpoch.current, originalRuntime = current.current?.owner.runtimeId
    setReading(true); setIssue(''); setNotice('')
    // Network observation and editable settings are independent capabilities.
    void inspectNetwork(controller.signal)
    try {
      // A restarted original Core may have a new process fence, never a replacement Runtime.
      const result = await api.mesh.call('settings.mesh.inspect', operationId ? { operationId } : {}, { signal: controller.signal })
      if (controller.signal.aborted || epoch !== readEpoch.current) return
      if (originalRuntime && result.owner.runtimeId !== originalRuntime) throw new Error('Another Core answered. The original Mesh draft and request are retained for their Runtime.')
      if (current.current?.owner.ownerInstanceId !== result.owner.ownerInstanceId) { linkRequest.current?.controller.abort(); linkRequest.current = undefined; setLinking(false); setLink(undefined) }
      current.current = result; setSettings(result)
      const held = meshDraftForRuntime(useAppStore.getState().meshSettingsDrafts, result.owner.runtimeId)
      if (operationId && held?.pending?.operationId === operationId) {
        if (result.operation?.status === 'confirmed' && result.operation.expectedRevision === held.pending.expectedRevision) {
          await updateMeshSettingsDraft(result.owner.runtimeId, value => {
            if (value?.pending?.operationId !== operationId) return value
            const later = !configValuesEqual(value.form, value.pending.submittedForm) || result.operation!.revision !== result.revision
            return retained({ ...value, pending: undefined, baseline: result, form: later ? value.form : meshForm(result.configuration, result.identity?.peerId) })
          }, true)
          if (result.operation.revision !== result.revision) setNewer(result)
          setNotice('Original Mesh save confirmed')
        } else setIssue(result.operation === null ? 'The original save is not recorded. Your draft and operation are retained; inspect the original Core before another save.' : 'The original save remains unconfirmed. Its input and operation are retained.')
      } else if (held?.pending) {
        void inspect(held.pending.operationId)
      } else if (held && held.baseline.revision !== result.revision) {
        setNewer(result); setIssue('Saved Mesh settings changed. Review the saved version or keep your draft before saving.')
      }
    } catch (cause) { if (!controller.signal.aborted && epoch === readEpoch.current) setIssue(message(cause)) }
    finally { if (epoch === readEpoch.current) setReading(false) }
  }
  useEffect(() => { if (active && !current.current) void inspect(); return () => { reader.current?.abort(); setReading(false); linkRequest.current?.controller.abort(); linkRequest.current = undefined; setLinking(false) } }, [active])
  useEffect(() => {
    if (!active || !settings) return
    const controller = new AbortController()
    void inspectNetwork(controller.signal)
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void inspectNetwork(controller.signal) }, 3000)
    return () => { clearInterval(timer); controller.abort() }
  }, [active, settings?.owner.runtimeId, settings?.owner.ownerInstanceId, inspectNetwork])

  function change(patch: Partial<MeshForm>) {
    if (!saved || !form) return
    setNotice(''); setLink(undefined)
    void updateMeshSettingsDraft(saved.owner.runtimeId, value => retained({ ...value, baseline: value?.baseline ?? saved,
      form: { ...(value?.form ?? form), ...patch }, ...(value?.pending ? { pending: value.pending } : {}) })).catch(cause => setIssue(message(cause)))
  }
  async function save() {
    if (!saved || !form || saving || pending || newer || editIssue) return
    let sent = false, operationId = ''
    setIssue(''); setNotice(''); setSaving(true); reader.current?.abort(); ++readEpoch.current
    try {
      const configuration = meshConfiguration(form, saved.configuration, settings?.identity ?? undefined), runtimeId = saved.owner.runtimeId
      operationId = mintObjectId()
      await updateMeshSettingsDraft(runtimeId, value => ({ ...value, baseline: value?.baseline ?? saved, form: value?.form ?? form,
        pending: { operationId, expectedRevision: saved.revision, submitted: configuration, submittedForm: form, phase: 'in-flight' } }), true)
      sent = true
      const result = await api.mesh.call('settings.mesh.configure', { expectedRevision: saved.revision, operationId, configuration }, { expectedOwner: settings!.owner })
      if (result.settings.owner.runtimeId !== runtimeId) throw new Error('Mesh save returned another Runtime. The original request is retained.')
      if (result.diskDurability !== 'confirmed') throw new Error('The original Mesh disk acknowledgement is unknown. Inspect this save before trying again.')
      await updateMeshSettingsDraft(runtimeId, value => {
        if (value?.pending?.operationId !== operationId) return value
        const later = !configValuesEqual(value.form, form)
        return retained({ ...value, pending: undefined, baseline: result.settings, form: later ? value.form : meshForm(result.settings.configuration, result.settings.identity?.peerId) })
      }, true)
      current.current = result.settings; setSettings(result.settings); setNewer(undefined); setNotice('Mesh settings saved')
      if (visible.current) void inspectNetwork()
    } catch (cause) {
      const notApplied = !sent || (cause as { controlFailure?: { disposition?: string } })?.controlFailure?.disposition === 'not_applied'
      if (saved && operationId) await updateMeshSettingsDraft(saved.owner.runtimeId, value => {
        if (value?.pending?.operationId !== operationId) return value
        if (!notApplied) return { ...value, pending: { ...value.pending, phase: 'unknown' } }
        const { pending: _request, ...rest } = value; return retained(rest)
      }, true).catch(() => {})
      setIssue(message(cause))
    } finally { setSaving(false) }
  }
  async function resolveDraft(keep: boolean) {
    if (!newer) return
    await updateMeshSettingsDraft(newer.owner.runtimeId, value => value ? retained({ ...value, pending: undefined, baseline: newer, form: keep ? value.form : meshForm(newer.configuration, newer.identity?.peerId) }) : undefined, true)
    setSettings(newer); setNewer(undefined); setIssue('')
  }
  async function createLink() {
    if (!settings) return
    linkRequest.current?.controller.abort()
    const request = { input: originalOffer, owner: settings.owner, controller: new AbortController() }; linkRequest.current = request
    const isCurrent = () => linkRequest.current === request && !request.controller.signal.aborted && current.current?.owner.runtimeId === request.owner.runtimeId && current.current.owner.ownerInstanceId === request.owner.ownerInstanceId
    setLinking(true); setLinkIssue(''); setLink(undefined)
    try {
      const input = JSON.parse(request.input), offer = input.offer ?? input
      const result = await api.mesh.call('mesh.link', { offer }, { expectedOwner: request.owner, signal: request.controller.signal })
      if (isCurrent()) setLink(result)
    } catch (cause) { if (isCurrent()) setLinkIssue(message(cause)) }
    finally { if (linkRequest.current === request) { setLinking(false); linkRequest.current = undefined } }
  }
  const peerCode = settings ? meshPeerCode(settings) : null
  const hasTopology = Boolean(network && (network.peers.length || network.records.length || network.routes.length))
  const identityRecovery = useLocalRuntimeRecovery(active && !settings, () => { void inspect() })
  return <div className="mesh-network-settings" data-mesh-settings>
    <header className="mesh-network-heading"><MeshConnectionIntro />{!identityRecovery.notice && (settings || !issue) ? <button className="small-button" onClick={() => void inspect()} disabled={reading || saving}>{reading ? 'Reading…' : 'Refresh'}</button> : null}</header>
    {identityRecovery.notice ? <ServiceWindowNotice layout="surface" notice={identityRecovery.notice.notice}
      actions={<><button className="primary-button" disabled={identityRecovery.restoring} onClick={identityRecovery.notice.action?.run}>{identityRecovery.notice.action?.label}</button>{onConnections ? <button className="small-button" onClick={onConnections}>Open saved connections</button> : null}</>} />
    : !settings ? <section className="mesh-availability" role={issue ? 'alert' : 'status'}>
      <span className="mesh-section-kicker">{issue ? 'Setup unavailable' : 'Connecting to this Core'}</span>
      <h3>{issue ? 'Couldn’t read Mesh settings.' : 'Reading your network settings…'}</h3>
      <p>{issue ? 'Check this Core’s connection and version, then refresh. Your saved device connections are still available.' : 'You can keep using your saved connections while this Core responds.'}</p>
      <div className="mesh-recovery-actions">{issue ? <button className="primary-button" onClick={() => void inspect()} disabled={reading}>{reading ? 'Reading…' : 'Refresh Mesh'}</button> : null}{onConnections ? <button className="small-button" onClick={onConnections}>Open saved connections</button> : null}</div>
      {issue ? <details className="mesh-advanced"><summary>Technical details</summary><p>{issue}</p>{networkIssue ? <p>Network observation: {networkIssue}</p> : null}</details> : null}
    </section> : null}
    {snapshot ? <div className="mesh-network-status" role="status"><strong>{networkIssue ? 'Last confirmed · ' : ''}{snapshot.source === 'static' ? 'Startup configuration active' : snapshot.apply.state === 'active' ? 'Mesh active' : snapshot.apply.state === 'disabled' ? 'Mesh disabled' : snapshot.apply.state === 'starting' ? 'Applying settings…' : 'Mesh apply unavailable'}</strong>{network ? <span>{network.peers.filter(peer => peer.state === 'connected').length} authenticated peer{network.peers.filter(peer => peer.state === 'connected').length === 1 ? '' : 's'} · {network.routes.length} known route{network.routes.length === 1 ? '' : 's'}</span> : null}{snapshot.gateway.state === 'listening' ? <span>Listening on {snapshot.gateway.listener?.host}:{snapshot.gateway.listener?.port}</span> : null}{snapshot.apply.issue ? <span className="settings-inline-error">{snapshot.apply.issue.message}</span> : null}{snapshot.activeRevision && snapshot.desiredRevision !== snapshot.activeRevision ? <span>Saved settings differ from the active network.</span> : null}</div> : null}
    {networkIssue && (settings || snapshot) ? <div className="mesh-network-note" role="status"><strong>Network observation unavailable.</strong><p>{snapshot ? 'The last confirmed view is retained. Refresh to check again.' : 'Current connections haven’t been confirmed. Refresh to check again.'}</p><details className="mesh-advanced"><summary>Technical details</summary><p>{networkIssue}</p></details></div> : null}
    {showTopology ? <>{hasTopology ? <MeshNetworkMap snapshot={snapshot} /> : null}</> : null}
    {form && saved ? <>
      {snapshot?.source === 'static' ? <p className="mesh-network-note">A startup gateway configuration is active. Saving these complete Mesh settings replaces that configuration and its publisher admissions; the original file is kept.</p> : null}
      {editIssue ? <p role="alert" className="settings-inline-error">{editIssue}</p> : <section className="mesh-network-section" data-settings-field="mesh-configuration">
        <header><h4>Connection setup</h4>{form.role !== 'disabled' ? <button className="small-button" onClick={() => change({ role: 'disabled' })}>Disable participation</button> : null}</header>
        <div className="mesh-task-options" role="group" aria-label="Connection mode">
          <button type="button" aria-pressed={form.role === 'participant'} onClick={() => change({ role: 'participant' })}><span className="mesh-task-label"><strong>Connect to a gateway</strong><span aria-hidden="true">{form.role === 'participant' ? '✓' : '→'}</span></span><span>Join through a device you can reach. No incoming port needed.</span></button>
          <button type="button" aria-pressed={form.role === 'gateway'} onClick={() => change({ role: 'gateway' })}><span className="mesh-task-label"><strong>Provide a gateway</strong><span aria-hidden="true">{form.role === 'gateway' ? '✓' : '↗'}</span></span><span>Let other devices connect here. This device can also connect to other gateways.</span></button>
        </div>
        <div className="mesh-form-grid"><label className="mesh-form-field"><span>Network name</span><TextInput aria-label="Mesh network" value={form.networkId} onChange={event => change({ networkId: event.target.value })} /></label><div className="mesh-code-action">{peerCode ? <><button className="small-button" onClick={() => void copy(peerCode)}>Copy saved connection code</button><span className="field-hint">Contains the saved network name and gateway address. Save changes before sharing.</span></> : <p className="field-hint">Save a connection mode to create this device’s network identity.</p>}</div></div>
        <p className="field-hint">Use the same network name on both devices. Exchange connection codes, then save on both sides.</p>
        <label className="mesh-form-field"><span>Other devices’ connection codes</span><textarea aria-label="Mesh peer codes" value={form.peers} onChange={event => change({ peers: event.target.value })} placeholder="Paste a gateway or another device’s connection code" rows={3} /></label>
        {form.role === 'gateway' ? <div className="mesh-gateway-fields"><header><h4>Gateway address</h4><p className="field-hint">Use an address the other devices can reach, such as an internal IP or hostname.</p></header><label className="mesh-toggle"><input type="checkbox" aria-label="Own Mesh listener" checked={form.listen} onChange={event => change({ listen: event.target.checked })} /><span>Listen on a dedicated address</span></label>{form.listen ? <div className="mesh-form-grid"><label><span>Listen address</span><TextInput aria-label="Mesh listen address" value={form.host} onChange={event => change({ host: event.target.value })} /></label><label><span>Port</span><TextInput aria-label="Mesh listen port" value={form.port} inputMode="numeric" onChange={event => change({ port: event.target.value })} /></label></div> : <p className="field-hint">Enable a dedicated listener, or use this Core’s existing HTTP listener.</p>}<label className="mesh-form-field"><span>Address to share with other devices</span><textarea aria-label="Mesh published origins" value={form.ingress} onChange={event => change({ ingress: event.target.value })} rows={2} placeholder="http://your-gateway:8444" /></label><p className="field-hint">Binding a port and saving this address do not confirm that another device can reach it.</p></div> : null}
        <details className="mesh-advanced mesh-device-access"><summary>Allow devices to access this Core{form.clientKeys.trim() ? ' · configured' : ''}</summary>
          <p className="field-hint">Joining a network connects peers. Access to this Core is granted separately.</p>
          <p className="field-hint">{snapshot?.endpoint.state === 'not-provided' ? 'This deployment forwards network traffic without a local Host endpoint.' : snapshot?.endpoint.state === 'available' ? 'This Core’s endpoint is available. Add each accessing device’s public key below.' : snapshot?.endpoint.state === 'starting' ? 'This Core’s endpoint is starting.' : 'Enable participation, then refresh to check this Core’s endpoint.'}</p>
          <label className="mesh-form-field"><span>Allowed device public keys</span><textarea aria-label="Mesh device public keys" value={form.clientKeys} onChange={event => change({ clientKeys: event.target.value })} rows={3} placeholder="One public key per line" /></label><p className="field-hint">On the accessing CLI, use <code>agentmux-runtime relay-key</code> to read its public key. An empty list admits no devices.</p>
        </details>
        <details className="mesh-advanced"><summary>Advanced network settings</summary><div className="mesh-form-grid"><label><span>TLS key file</span><TextInput aria-label="Mesh TLS key path" value={form.keyPath} onChange={event => change({ keyPath: event.target.value })} /></label><label><span>TLS certificate file</span><TextInput aria-label="Mesh TLS certificate path" value={form.certPath} onChange={event => change({ certPath: event.target.value })} /></label></div><label className="mesh-form-field"><span>Additional publisher grants</span><textarea aria-label="Mesh publisher grants" value={form.publishers} onChange={event => change({ publishers: event.target.value })} rows={3} /></label><p className="field-hint">Server IDs and token hashes for separately hosted publishers. Host deployments connect their own endpoint automatically.</p><code>{settings?.identity?.peerId ?? 'Network identity not created'}</code></details>
      </section>}
      {newer ? <div className="mesh-conflict" role="alert"><span>The saved version changed. Your edit is retained.</span><button className="small-button" onClick={() => void resolveDraft(false)}>Use saved</button><button className="small-button" onClick={() => void resolveDraft(true)}>Keep my draft</button></div> : null}
      <SettingsSaveBar save={{ state: issue || editIssue ? 'error' : saving ? 'saving' : notice ? 'saved' : 'idle', error: issue || editIssue, saving }} dirty={dirty || Boolean(pending)} label="Save Mesh settings" scopeLabel="Mesh" onSave={() => void save()} blocked={pending ? 'Inspect the original save first' : newer ? 'Review the current saved version' : editIssue || undefined} />
      {pending ? <div className="mesh-pending"><code>{pending.operationId}</code><button className="small-button" disabled={saving || reading} onClick={() => void inspect(pending.operationId)}>Inspect original save</button></div> : null}
      {notice ? <p role="status" className="mesh-network-notice">{notice}</p> : null}
    </> : null}
    {settings ? <details className="mesh-advanced mesh-access-links"><summary>Access links and endpoint details</summary>
      {endpointOffer ? <section className="mesh-network-section"><header><h4>This Core’s endpoint</h4><button className="small-button" onClick={() => void copy(JSON.stringify(endpointOffer))}>Copy endpoint offer</button></header><p className="field-hint">Use this offer at a reachable gateway to create a network access link.</p><code>{endpointOffer.serverId}</code></section> : snapshot?.endpoint.state === 'not-provided' ? <p className="field-hint">This deployment provides network forwarding without a Host endpoint.</p> : null}
      <section className="mesh-network-section" data-settings-field="mesh-link"><header><h4>Create an access link</h4></header><p className="field-hint">For a connected node: paste its complete endpoint offer. The link keeps that node’s identity and device permissions.</p><label className="mesh-form-field"><span>Node endpoint offer</span><textarea aria-label="Original Mesh endpoint offer" value={originalOffer} onChange={event => { const text = event.target.value; linkRequest.current?.controller.abort(); linkRequest.current = undefined; setLinking(false); if (saved && form) void updateMeshSettingsDraft(saved.owner.runtimeId, value => retained({ ...value, baseline: value?.baseline ?? saved, form: value?.form ?? form, linkInput: text })).catch(cause => setLinkIssue(message(cause))); setLink(undefined) }} rows={3} placeholder="Paste the complete endpoint offer" /></label><button className="small-button" disabled={linking || !originalOffer || !settings} onClick={() => void createLink()}>{linking ? 'Reading route…' : 'Create access link'}</button>{linkIssue ? <p role="alert" className="settings-inline-error">{linkIssue}</p> : null}{link ? <div className="mesh-link-result"><span>{link.observation.route.hops} network hop{link.observation.route.hops === 1 ? '' : 's'} · endpoint {link.offer.serverId}</span><TextInput aria-label="Mesh access link" value={link.url} readOnly /><button className="small-button" onClick={() => void copy(link.url)}>Copy access link</button><details><summary>Original endpoint identity</summary><dl><dt>Server</dt><dd><code>{link.offer.serverId}</code></dd><dt>Encryption public key</dt><dd><code>{link.offer.daemonPublicKeyB64}</code></dd></dl><button className="small-button" onClick={() => void copy(link.offer.daemonPublicKeyB64)}>Copy original encryption key</button></details><small>Use the complete link with amux --endpoint. Device admission and Core permissions still apply.</small></div> : null}</section>
    </details> : null}
    {copyFeedback ? <p role="status" className="mesh-copy-feedback">{copyFeedback}</p> : null}
  </div>
}
