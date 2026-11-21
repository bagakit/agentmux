import { useState, type ReactNode } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import { TextInput } from '@agentmux/client-ui/input'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { decodeMeshPeerCode, type MeshPeerCode } from '@agentmux/core/mesh-peer-code'
import type { MeshNetworkInspection, MeshNetworkSettings } from '@agentmux/core/mesh-network'
import { configValuesEqual } from '../../../../shared/config-edit'
import { api } from '../../lib/api'
import { meshPeerFormPatch, type MeshForm } from '../../lib/mesh-settings-draft'
import type { useLocalRuntimeRecovery } from '../../lib/use-local-runtime-recovery'
import { setAuthoredWorkbench, useAppStore } from '../../store'
import { ServiceWindowNotice } from '../ServiceWindowNotice'

type Props = {
  settings: MeshNetworkSettings | undefined
  snapshot: MeshNetworkInspection | undefined
  networkIssue: string
  form: MeshForm | undefined
  saved: MeshNetworkSettings | undefined
  peerCode: string | null
  issue: string
  reading: boolean
  saving: boolean
  blocked: boolean
  hasUnsavedEdit: boolean
  onConnect(form: MeshForm): void
  onCheck(): void
  onCopy(code: string): void
  copyFeedback: string
  onAccess: (() => void) | undefined
  onManage: (() => void) | undefined
  onDone: (() => void) | undefined
  resolution: ReactNode
  identityRecovery: ReturnType<typeof useLocalRuntimeRecovery>
  openSeparate: ((code?: string) => void) | undefined
  openingSeparate: boolean
  separateIssue: ReactNode
}

export function MeshGatewayJoin({ settings, snapshot, networkIssue, form, saved, peerCode, issue, reading, saving, blocked, hasUnsavedEdit,
  onConnect, onCheck, onCopy, copyFeedback, onAccess, onManage, onDone, resolution, identityRecovery, openSeparate, openingSeparate, separateIssue }: Props) {
  const authored = useAppStore(state => state.meshGatewayCode)
  const handoff = useAppStore(state => state.meshGatewayHandoff)
  const incoming = api.ui.isNewIdentityWindow ? handoff : undefined
  const [reviewed, setReviewed] = useState<string>()
  const reviewedIncoming = reviewed === incoming
  const code = authored || (!reviewedIncoming ? incoming : undefined) || ''
  const trimmed = code.trim()
  function change(value: string) {
    setReviewed(incoming)
    setAuthoredWorkbench({ meshGatewayCode: value })
  }

  let gateway: MeshPeerCode | undefined, connectForm: MeshForm | undefined, codeIssue = ''
  if (trimmed) try {
    const peer = decodeMeshPeerCode(trimmed)
    if (peer.direct === false || !peer.endpoints.length) throw new Error('This code has no dial address. Ask the gateway operator for a gateway connection code.')
    gateway = peer
    if (saved && form) connectForm = { ...form, ...meshPeerFormPatch(form, trimmed, peer, saved.identity?.peerId,
      saved.configuration.role === 'disabled' && form.networkId === saved.configuration.networkId) }
  } catch (cause) { codeIssue = cause instanceof Error ? cause.message : String(cause) }

  const configuration = settings?.configuration
  const configured = gateway && configuration && configuration.role !== 'disabled' && configuration.networkId === gateway.networkId &&
    configuration.members.some(member => member.peerId === gateway.peerId && member.publicKey === gateway.publicKey) &&
    configuration.peers.some(peer => peer.peerId === gateway.peerId && configValuesEqual(peer.endpoints, gateway.endpoints))
  const connected = configured && !networkIssue && snapshot?.activeRevision === settings?.revision &&
    snapshot?.network?.peers.some(peer => peer.peerId === gateway?.peerId && peer.state === 'connected')
  const needsReview = snapshot?.source === 'static' || hasUnsavedEdit
  const submit = !configured && !needsReview && !blocked && !saving && connectForm
  const applyIssue = snapshot?.apply.issue?.message
  const recovery = identityRecovery.notice
  const stage = configured || saving ? 'Connection' : gateway && !codeIssue ? 'Review' : 'Gateway code'
  const codeField = <label className="mesh-form-field mesh-join-code" data-settings-field="mesh-join"><span>Gateway connection code</span>
    <TextInput aria-label="Gateway connection code" placeholder="amux-mesh:…" spellCheck={false}
      value={code} onChange={event => change(event.target.value)} aria-invalid={Boolean(codeIssue)} /></label>

  return <div className="mesh-network-settings mesh-gateway-join" data-mesh-settings>
    <header className="mesh-join-landing">
      <div><h3>Connect to a Relay Gateway</h3><p>{api.ui.isNewIdentityWindow
        ? 'You’re in a separate AgentMux instance. The connection will belong to this identity.'
        : 'Join your AgentMux network using the code shared by your gateway operator.'}</p></div>
      <div className="mesh-join-link" data-connected={connected ? '' : undefined} aria-hidden="true">
        <div><span><SemanticIcon name="object.display" size={23} /></span><small>This Mac</small></div>
        <i />
        <div><span><SemanticIcon name="object.node" size={23} /></span><small>Relay Gateway</small></div>
      </div>
    </header>
    <ol className="mesh-join-steps" aria-label="Connection steps">
      {['Gateway code', 'Review', 'Connection'].map(step => <li key={step} aria-current={step === stage ? 'step' : undefined}>{step}</li>)}
    </ol>
    <form className="mesh-network-section mesh-join-form" onSubmit={event => {
      event.preventDefault()
      if (submit) { change(code); onConnect(submit) }
    }}>
      {!configured ? codeField : null}
      {incoming && authored && authored !== incoming && !reviewedIncoming ? <Button onClick={() => change(incoming)}>Review gateway from original instance</Button> : null}
      {gateway ? <div className="mesh-join-target mesh-peer-preview">
        <SemanticIcon name="object.node" size={18} aria-hidden="true" />
        <div><h4>{gateway.networkId}</h4>
          <ul aria-label="Gateway addresses">{gateway.endpoints.map(({ endpoint, useTls }) => {
            const address = `${useTls ? 'https' : 'http'}://${endpoint}`
            return <li key={address}><code>{address}</code></li>
          })}</ul>
          <details><summary>Gateway identity</summary><code>{gateway.peerId}</code></details></div>
      </div> : null}
      {codeIssue ? <p className="settings-inline-error" role="alert">{codeIssue}</p> : null}
      {!configured && settings && !blocked && (!needsReview || saving) ? <Button type="submit" variant="primary" disabled={!submit}>{saving ? 'Saving connection…' : 'Connect'}</Button> : null}
      {configured && !blocked && !saving ? <div className="mesh-join-result" role="status">
        <strong>{connected ? 'Connected to gateway' : networkIssue ? 'Connection check unavailable' : applyIssue ? 'Gateway settings could not be applied' : 'Gateway connection not yet confirmed'}</strong>
        {!connected ? <p>{networkIssue ? 'Check the gateway address and try again.' : applyIssue || 'If this Mac is new to the network, send its connection code to the gateway operator for approval. Then check the connection again.'}</p> : null}
        <div className="mesh-recovery-actions">
          {connected && onDone ? <Button variant="primary" onClick={onDone}>Done</Button> : <Button variant={connected ? 'secondary' : 'primary'} onClick={onCheck} disabled={reading}>Check connection</Button>}
          {peerCode && !connected ? <Button onClick={() => onCopy(peerCode)}>Copy this Mac’s connection code</Button> : null}
        </div>
      </div> : null}
      {configured ? <details className="mesh-join-code-disclosure"><summary>Gateway connection code</summary>{codeField}</details> : null}
    </form>
    {resolution}
    {saving ? <p className="field-hint" role="status">Saving connection…</p> : null}
    {recovery ? <div className="mesh-identity-recovery">
      <ServiceWindowNotice notice={recovery.notice} actions={<div className="mesh-recovery-actions">
        <Button variant="primary" onClick={onCheck} disabled={reading || identityRecovery.restoring}>Check this Mac again</Button>
        {identityRecovery.canImport ? <Button onClick={() => recovery.action?.run()} disabled={identityRecovery.restoring}>Import original backup…</Button> : null}
      </div>} />
      {openSeparate ? <details className="mesh-advanced"><summary>Continue with a separate identity</summary>
        <p className="field-hint">A second AgentMux instance will open with its own identity. {gateway ? 'It will bring the selected gateway along for review. ' : ''}Your original work stays here.</p>
        <Button onClick={() => openSeparate(gateway ? trimmed : undefined)} disabled={openingSeparate || identityRecovery.restoring}>{openingSeparate ? 'Opening separate instance…' : 'Open separate instance…'}</Button>
        {separateIssue}
      </details> : null}
      <details className="mesh-advanced"><summary>Technical details</summary><p>{recovery.detail}</p></details>
    </div> : !settings ? <div className="mesh-join-result" role="status">
      <strong>{issue ? 'This Mac’s Mesh settings couldn’t be read' : 'Reading this Mac’s Mesh settings…'}</strong>
      {issue ? <><Button disabled={reading} onClick={onCheck}>Read settings again</Button><details><summary>Technical details</summary>{issue}</details></> : null}
    </div> : null}
    {settings && issue ? <p className="settings-inline-error" role="alert">{issue}</p> : null}
    {needsReview && !configured && !blocked && !saving ? <div className="mesh-join-result">
      <p>{snapshot?.source === 'static' ? 'This Mac is already running a startup gateway. Review its configuration and admissions before making changes.'
        : 'This Mac has unsaved gateway settings. Review them before connecting here.'}</p>
      {onManage ? <Button onClick={onManage}>Manage gateways</Button> : null}
    </div> : null}
    {copyFeedback ? <p role="status" className="mesh-copy-feedback">{copyFeedback}</p> : null}
    <footer className="mesh-recovery-actions mesh-join-footer">
      {onAccess ? <Button onClick={onAccess}>Use another device</Button> : null}
    </footer>
  </div>
}
