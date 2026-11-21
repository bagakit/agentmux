import { useRef, useState } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import { TextInput } from '@agentmux/client-ui/input'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import meshArt from '@agentmux/client-ui/brand/illustrations/concepts/mesh-relay.jpg'
import { decodeMeshPeerCode, type MeshPeerCode } from '@agentmux/core/mesh-peer-code'
import type { MeshNetworkInspection, MeshNetworkSettings } from '@agentmux/core/mesh-network'
import { configValuesEqual } from '../../../../shared/config-edit'
import { api } from '../../lib/api'
import { meshForm, meshPeerFormPatch, type MeshForm, type MeshSettingsDraft } from '../../lib/mesh-settings-draft'
import type { useLocalRuntimeRecovery } from '../../lib/use-local-runtime-recovery'
import { setAuthoredWorkbench, useAppStore } from '../../store'
import { ConfirmationDialog } from '../ConfirmationDialog'

type Props = {
  active: boolean
  settings: MeshNetworkSettings | undefined
  snapshot: MeshNetworkInspection | undefined
  networkIssue: string
  peerCode: string | null
  issue: string
  draftIssue: string
  notice: string
  reading: boolean
  saving: boolean
  pending: MeshSettingsDraft['pending']
  onConnect(form: MeshForm, code: string): void
  onCheck(): void
  onCheckSave(): void
  onCopy(code: string): void
  copyFeedback: string
  onAccess: (() => void) | undefined
  onManage: (() => void) | undefined
  onDone: (() => void) | undefined
  identityRecovery: ReturnType<typeof useLocalRuntimeRecovery>
  separate: boolean
  onPrepareIdentity(): void
  preparingIdentity: boolean
  identitySetupIssue: string
  onOriginalIdentity(): void
}

export function MeshGatewayJoin({ active, settings, snapshot, networkIssue, peerCode, issue, draftIssue, notice, reading, saving, pending,
  onConnect, onCheck, onCheckSave, onCopy, copyFeedback, onAccess, onManage, onDone, identityRecovery, separate, onPrepareIdentity, preparingIdentity, identitySetupIssue, onOriginalIdentity }: Props) {
  const authored = useAppStore(state => state.meshGatewayCode)
  const [confirmIdentity, setConfirmIdentity] = useState<'import' | 'new'>()
  const [clipboardIssue, setClipboardIssue] = useState('')
  const [pasting, setPasting] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const code = pending?.gatewayCode ?? authored
  const trimmed = code.trim()
  function change(value: string) {
    setClipboardIssue('')
    setAuthoredWorkbench({ meshGatewayCode: value })
  }

  async function paste() {
    setPasting(true)
    try {
      const value = (await api.ui.readClipboardText()).trim()
      if (!value) setClipboardIssue('Clipboard is empty. Copy your gateway code or paste it into the field.')
      else if ((useAppStore.getState().meshGatewayCode || '') === authored) change(value)
    } catch {
      setClipboardIssue('Couldn’t read the clipboard. Paste your code into the field.')
    } finally {
      setPasting(false)
      field.current?.focus()
    }
  }

  let gateway: MeshPeerCode | undefined, connectForm: MeshForm | undefined, codeIssue = '', reviewIssue = ''
  if (trimmed) {
    try {
      gateway = decodeMeshPeerCode(trimmed)
      if (gateway.direct === false || !gateway.endpoints.length) {
        gateway = undefined
        codeIssue = 'This is a device code. Paste the connection code shared by the gateway operator.'
      }
    } catch {
      codeIssue = 'This gateway code is incomplete or invalid. Copy the full code from the gateway operator.'
    }
    if (settings && gateway) {
      try {
        const form = meshForm(settings.configuration, settings.identity?.peerId)
        connectForm = { ...form, ...meshPeerFormPatch(form, trimmed, gateway, settings.identity?.peerId, settings.configuration.role === 'disabled') }
      } catch (cause) { reviewIssue = cause instanceof Error ? cause.message : String(cause) }
    }
  }

  const configuration = settings?.configuration
  const configured = Boolean(gateway && configuration && configuration.role !== 'disabled' && configuration.networkId === gateway.networkId &&
    configuration.members.some(member => member.peerId === gateway.peerId && member.publicKey === gateway.publicKey) &&
    configuration.peers.some(peer => peer.peerId === gateway.peerId && configValuesEqual(peer.endpoints, gateway.endpoints)))
  const connected = configured && !networkIssue && snapshot?.activeRevision === settings?.revision &&
    snapshot?.network?.peers.some(peer => peer.peerId === gateway?.peerId && peer.state === 'connected')
  const recovery = identityRecovery.notice
  const unverifiedMesh = snapshot?.apply.issue?.code === 'MESH_IDENTITY_UNCONFIRMED'
  const identityIssue = Boolean(recovery || unverifiedMesh || separate && !settings)
  const staticGateway = snapshot?.source === 'static'
  const needsNetworkCheck = Boolean(settings && !snapshot && !configured)
  const checking = reading || identityRecovery.restoring
  const submit = !configured && !saving && !pending && !reading && !draftIssue && !staticGateway && !needsNetworkCheck && !identityIssue && connectForm
  const canEnterCode = !identityIssue && !pending && !saving
  const canPaste = canEnterCode && !pasting
  const applyIssue = snapshot?.apply.issue?.message
  const applying = !networkIssue && !applyIssue && (snapshot?.apply.state === 'starting' || snapshot?.activeRevision !== settings?.revision)
  const steps = ['Device identity', 'Gateway code', 'Review', 'Connection']
  const step = identityIssue || !settings ? 0 : configured || saving || pending ? 3 : gateway ? 2 : 1
  const phase = connected ? 'connected' : preparingIdentity || identityRecovery.restoring ? 'identity' : saving || applying && configured ? 'connecting'
    : identityIssue || !settings ? 'attention' : configured ? 'waiting' : gateway ? 'review' : 'ready'
  const codeField = <label className="mesh-form-field mesh-join-code" data-settings-field="mesh-join"><span>Gateway connection code</span>
    <TextInput ref={field} aria-label="Gateway connection code" placeholder="amux-mesh:…" spellCheck={false}
      value={code} onChange={event => change(event.target.value)} disabled={!canEnterCode} aria-invalid={Boolean(codeIssue || reviewIssue)} /></label>

  return <div className="mesh-network-settings mesh-gateway-join" data-mesh-settings>
    <header className="mesh-join-landing" data-mesh-phase={phase}>
      <div className="mesh-join-lead">
        <h3>Bring this Mac into your network.</h3>
        <p>Connect through a Relay Gateway to reach approved devices and their work.</p>
        {identityIssue && !preparingIdentity ? <span className="mesh-join-identity-flag"><i aria-hidden="true" />Device identity needs attention</span> : null}
        {preparingIdentity ? <span className="mesh-join-identity-progress" role="status">Verifying the separate identity…</span> : null}
        {separate && settings && !identityIssue ? <span className="mesh-join-identity-progress" role="status"><SemanticIcon name="object.node" size={14} />Using separate Mesh identity</span> : null}
      </div>
      <div className="mesh-join-art" aria-hidden="true"><img src={meshArt} alt="" width="1100" height="619" draggable={false} />
        <div className="mesh-join-signal" key={phase}><i /><b /><i /></div>
      </div>
    </header>
    {identityIssue ? <section className="mesh-identity-recovery mesh-join-resolution" aria-label="Device identity" aria-busy={preparingIdentity || identityRecovery.restoring}>
      <div className="mesh-join-result" role="status">
        <strong>{preparingIdentity ? 'Preparing a separate identity' : separate ? 'Check the separate Mesh identity' : recovery ? 'Confirm this Mac’s identity to continue' : 'This Mac’s Mesh identity couldn’t be verified'}</strong>
        <p>{preparingIdentity ? 'AgentMux is verifying its background service. You can continue here once the identity is ready.'
          : recovery?.notice.notice.restore ?? (separate ? 'Check its background service, or switch back to the original identity.' : 'Check the original Mesh identity again, or prepare a separate one here.')}</p>
        <div className="mesh-recovery-actions">
          {identityRecovery.canImport && recovery ? <Button type="button" variant="primary" disabled={identityRecovery.restoring || preparingIdentity}
            onClick={() => setConfirmIdentity('import')}>Import original backup…</Button> : null}
          {separate ? <Button type="button" variant="primary" disabled={preparingIdentity} onClick={onPrepareIdentity}>Check this identity</Button> :
            <Button type="button" variant={identityRecovery.canImport && recovery ? 'secondary' : 'primary'}
              disabled={preparingIdentity || identityRecovery.restoring} onClick={() => setConfirmIdentity('new')}>{identitySetupIssue ? 'Retry new identity…' : 'Create a new identity…'}</Button>}
          {separate ? <Button type="button" disabled={preparingIdentity} onClick={onOriginalIdentity}>Use original identity</Button> :
            <Button type="button" onClick={onCheck} disabled={identityRecovery.restoring || preparingIdentity}>Check this Mac again</Button>}
        </div>
        {identitySetupIssue ? <p role="alert" className="settings-inline-error">Couldn't verify this identity. Check it again.</p> : null}
        {recovery || applyIssue || identitySetupIssue || issue ? <details className="mesh-advanced"><summary>Technical details</summary><p>{identitySetupIssue || recovery?.detail || applyIssue || issue}</p></details> : null}
      </div>
    </section> : null}
    <ol className="mesh-join-steps" aria-label="Connection steps">
      {steps.map((label, index) => <li key={label} data-complete={index < step || connected ? '' : undefined}
        data-waiting={identityIssue && index > step ? '' : undefined} aria-current={index === step ? 'step' : undefined}>
        <span className="mesh-join-step-dot" aria-hidden="true" /><span>{label}</span>
      </li>)}
    </ol>
    <form className="mesh-network-section mesh-join-form" aria-busy={saving || reading} onSubmit={event => {
      event.preventDefault()
      if (submit) { change(code); onConnect(submit, trimmed) }
      else if (!gateway && canPaste) void paste()
    }}>
      {!configured ? codeField : null}
      {gateway ? <div className="mesh-join-target mesh-peer-preview">
        <SemanticIcon name="object.node" size={18} aria-hidden="true" />
        <div><h4>{gateway.networkId}</h4>
          <ul aria-label="Gateway addresses">{gateway.endpoints.map(({ endpoint, useTls }) => {
            const address = `${useTls ? 'https' : 'http'}://${endpoint}`
            return <li key={address}><code>{address}</code></li>
          })}</ul>
          <details><summary>Gateway identity</summary><code>{gateway.peerId}</code></details></div>
      </div> : null}
      {!identityIssue && (codeIssue || reviewIssue || clipboardIssue) ? <p className="settings-inline-error" role="alert">{codeIssue || reviewIssue || clipboardIssue}</p> : null}
      {!gateway && canEnterCode ? <>
        <Button type="submit" variant="primary" disabled={!canPaste}>{pasting ? 'Reading clipboard…' : 'Paste gateway code'}</Button>
        <details><summary>Where do I get a code?</summary><p>Ask the operator to copy the saved gateway connection code from Mesh → Relay settings.</p>
          {onManage ? <Button type="button" onClick={onManage}>Open gateway settings</Button> : null}</details>
      </> : null}
      {submit ? <Button type="submit" variant="primary">Connect</Button> : null}
      {pending || saving ? <div className="mesh-join-result" role="status">
        <strong>{saving ? 'Saving connection…' : reading ? 'Checking the original save…' : pending?.gatewayCode ? 'This connection’s save is unconfirmed' : 'An earlier Mesh save is unconfirmed'}</strong>
        {!saving && pending ? <><p>Check the original save to continue with the correct network settings.</p>
          <Button type="button" variant="primary" onClick={onCheckSave} disabled={reading}>Check original save</Button></> : null}
      </div> : !identityIssue && configured ? <div className="mesh-join-result" role="status">
        <strong>{connected ? 'Connected to gateway' : networkIssue ? 'Connection check unavailable' : applyIssue ? 'Gateway settings could not be applied' : applying ? 'Applying your gateway settings…' : 'Gateway connection not yet confirmed'}</strong>
        {connected ? <p>Open a device with its access link, or return to the Mesh map.</p>
          : <p>{networkIssue ? 'The last saved connection is kept. Check again to see its current state.' : applyIssue ? 'Review the saved gateway settings or check the current state.' : applying ? 'Your settings were saved. The Mac is still preparing the connection.' : 'If the gateway operator hasn’t approved this Mac yet, send them this Mac’s connection code. AgentMux checks again while this page is open.'}</p>}
        <div className="mesh-recovery-actions">
          {connected && onDone ? <Button type="button" variant="primary" onClick={onDone}>Done</Button> : <Button type="button" variant="primary" onClick={onCheck} disabled={reading}>Check connection</Button>}
          {peerCode && !connected && !applyIssue ? <Button type="button" onClick={() => onCopy(peerCode)}>Copy this Mac’s connection code</Button> : null}
          {applyIssue && onManage ? <Button type="button" onClick={onManage}>Review gateway settings</Button> : null}
          {connected && onAccess ? <Button type="button" onClick={onAccess}>Open a device</Button> : null}
        </div>
        {applyIssue ? <details><summary>Technical details</summary>{applyIssue}</details> : null}
      </div> : null}
      {configured ? <details className="mesh-join-code-disclosure"><summary>Gateway connection code</summary>{codeField}</details> : null}
      {!identityIssue && !settings ? <div className="mesh-join-result" role="status">
        <strong>{issue ? 'This Mac’s Mesh settings couldn’t be read' : 'Reading this Mac’s Mesh settings…'}</strong>
        {issue ? <><Button type="button" onClick={onCheck} disabled={checking}>Read settings again</Button><details><summary>Technical details</summary>{issue}</details></> : null}
      </div> : null}
      {!identityIssue && settings && (draftIssue || !configured && (staticGateway || needsNetworkCheck || reviewIssue)) ? <div className="mesh-join-result" role="status">
        {draftIssue ? <p>{draftIssue}</p> : staticGateway ? <p>This Mac is providing a startup gateway. Its operator can review the active setup and approved devices.</p> : needsNetworkCheck ? <p>{networkIssue ? 'Check this Mac’s network settings before connecting.' : 'Checking this Mac’s network settings…'}</p> : null}
        <div className="mesh-recovery-actions">
          {onManage && (draftIssue || staticGateway || reviewIssue) ? <Button type="button" onClick={onManage}>Review gateway settings</Button> : null}
          {needsNetworkCheck || draftIssue || staticGateway ? <Button type="button" onClick={onCheck} disabled={checking}>Check settings again</Button> : null}
        </div>
      </div> : null}
      {!identityIssue && settings && issue ? <details open={!pending}><summary>{pending ? 'Technical details' : 'The connection couldn’t be saved'}</summary><p role="alert">{issue}</p></details> : null}
      {!identityIssue && notice && !configured ? <p role="status">{notice}</p> : null}
      {copyFeedback ? <p role="status" className="mesh-copy-feedback">{copyFeedback}</p> : null}
    </form>
    {separate && !identityIssue || !connected && onAccess ? <footer className="mesh-recovery-actions mesh-join-footer">
      {!connected && onAccess ? <Button type="button" onClick={onAccess}>Open a device with an access link</Button> : null}
      {separate && !identityIssue ? <Button type="button" onClick={onOriginalIdentity}>Use original identity</Button> : null}
    </footer> : null}
    <ConfirmationDialog open={active && identityIssue && !!confirmIdentity} intent="neutral"
      title={confirmIdentity === 'import' ? 'Import this Mac’s original identity?' : 'Create a separate identity?'}
      description={confirmIdentity === 'import'
        ? 'Choose this Mac’s backup in the file picker. AgentMux verifies it before reconnecting to your original work.'
        : 'AgentMux will verify a separate background identity and continue here. Your original work stays with its current identity.'}
      confirmLabel={confirmIdentity === 'import' ? 'Choose backup…' : 'Create identity'}
      onCancel={() => setConfirmIdentity(undefined)}
      onConfirm={() => {
        const action = confirmIdentity
        setConfirmIdentity(undefined)
        if (action === 'import') recovery?.action?.run()
        if (action === 'new') onPrepareIdentity()
      }} />
  </div>
}
