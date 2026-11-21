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
  openSeparate: ((code?: string) => void) | undefined
  openingSeparate: boolean
  separateIssue: string
  separateRequested: boolean
}

export function MeshGatewayJoin({ active, settings, snapshot, networkIssue, peerCode, issue, draftIssue, notice, reading, saving, pending,
  onConnect, onCheck, onCheckSave, onCopy, copyFeedback, onAccess, onManage, onDone, identityRecovery, openSeparate, openingSeparate, separateIssue, separateRequested }: Props) {
  const authored = useAppStore(state => state.meshGatewayCode)
  const handoff = useAppStore(state => state.meshGatewayHandoff)
  const incoming = api.ui.isNewIdentityWindow ? handoff : undefined
  const [reviewed, setReviewed] = useState<string>()
  const [confirmIdentity, setConfirmIdentity] = useState<{ kind: 'import' } | { kind: 'new'; gatewayCode?: string }>()
  const [clipboardIssue, setClipboardIssue] = useState('')
  const [pasting, setPasting] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const reviewedIncoming = reviewed === incoming
  const code = pending?.gatewayCode ?? (authored || (!reviewedIncoming ? incoming : undefined) || '')
  const trimmed = code.trim()
  function change(value: string) {
    setReviewed(incoming)
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
  const identityIssue = Boolean(recovery || unverifiedMesh)
  const staticGateway = snapshot?.source === 'static'
  const needsNetworkCheck = Boolean(settings && !snapshot && !configured)
  const checking = reading || identityRecovery.restoring
  const submit = !configured && !saving && !pending && !reading && !draftIssue && !staticGateway && !needsNetworkCheck && !identityIssue && connectForm
  const canEnterCode = !identityIssue && !pending && !saving
  const canPaste = canEnterCode && !pasting
  const applyIssue = snapshot?.apply.issue?.message
  const applying = !networkIssue && !applyIssue && (snapshot?.apply.state === 'starting' || snapshot?.activeRevision !== settings?.revision)
  const stage = identityIssue ? 'Device identity' : configured || saving || pending ? 'Connection' : gateway ? 'Review' : 'Gateway code'
  const codeField = <label className="mesh-form-field mesh-join-code" data-settings-field="mesh-join"><span>Gateway connection code</span>
    <TextInput ref={field} aria-label="Gateway connection code" placeholder="amux-mesh:…" spellCheck={false}
      value={code} onChange={event => change(event.target.value)} disabled={!canEnterCode} aria-invalid={Boolean(codeIssue || reviewIssue)} /></label>

  return <div className="mesh-network-settings mesh-gateway-join" data-mesh-settings>
    <header className="mesh-join-landing">
      <div className="mesh-join-lead">
        <h3>Bring this Mac into your network.</h3>
        <p>{api.ui.isNewIdentityWindow
          ? incoming ? 'This is your new identity. Review the gateway brought from the original window.' : 'This is your new identity. Paste the gateway code to connect.'
          : 'Connect through a Relay Gateway to reach approved devices and their work.'}</p>
        {identityIssue ? <span className="mesh-join-identity-flag"><i aria-hidden="true" />Device identity needs attention</span> : null}
      </div>
      <div className="mesh-join-art" aria-hidden="true"><img src={meshArt} alt="" width="1100" height="619" draggable={false} /></div>
    </header>
    {identityIssue ? <section className="mesh-identity-recovery mesh-join-resolution" aria-label="Device identity">
      <div className="mesh-join-result" role="status">
        <strong>{recovery ? 'Confirm this Mac’s identity to continue' : 'This Mac’s Mesh identity couldn’t be verified'}</strong>
        <p>{recovery?.notice.notice.restore ?? 'Check the original Mesh identity again, or start a separate setup with a new identity.'}</p>
        <div className="mesh-recovery-actions">
          {identityRecovery.canImport && recovery ? <Button type="button" variant="primary" disabled={identityRecovery.restoring || openingSeparate}
            onClick={() => setConfirmIdentity({ kind: 'import' })}>Import original backup…</Button> : null}
          {openSeparate ? <Button type="button" variant={identityRecovery.canImport && recovery ? 'secondary' : 'primary'}
            disabled={openingSeparate || identityRecovery.restoring} onClick={() => setConfirmIdentity(gateway ? { kind: 'new', gatewayCode: trimmed } : { kind: 'new' })}>{separateRequested ? 'Reopen new identity setup…' : 'Create a new identity…'}</Button> : null}
          <Button type="button" onClick={onCheck} disabled={identityRecovery.restoring || openingSeparate}>Check this Mac again</Button>
        </div>
        {separateRequested ? <p>New setup was launched. Continue in its window when it opens.</p> : null}
        {separateIssue ? <p role="alert" className="settings-inline-error">{separateIssue}</p> : null}
        <details className="mesh-advanced"><summary>Technical details</summary><p>{recovery?.detail ?? applyIssue}</p></details>
      </div>
    </section> : null}
    <ol className="mesh-join-steps" aria-label="Connection steps">
      {['Device identity', 'Gateway code', 'Review', 'Connection'].map(step => <li key={step}
        data-waiting={identityIssue && step !== stage ? '' : undefined} aria-current={step === stage ? 'step' : undefined}>{step}</li>)}
    </ol>
    <form className="mesh-network-section mesh-join-form" aria-busy={saving || reading} onSubmit={event => {
      event.preventDefault()
      if (submit) { change(code); onConnect(submit, trimmed) }
      else if (!gateway && canPaste) void paste()
    }}>
      {!configured ? codeField : null}
      {incoming && authored && authored !== incoming && !reviewedIncoming && canEnterCode ? <Button type="button" onClick={() => change(incoming)}>Use the gateway from the original window</Button> : null}
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
        <details><summary>Where do I get a code?</summary><p>Ask the operator to copy the saved gateway connection code from Mesh → Manage gateways.</p>
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
    {!connected && onAccess ? <footer className="mesh-recovery-actions mesh-join-footer"><Button type="button" onClick={onAccess}>Open a device with an access link</Button></footer> : null}
    <ConfirmationDialog open={active && identityIssue && !!confirmIdentity} intent="neutral"
      title={confirmIdentity?.kind === 'import' ? 'Import this Mac’s original identity?' : 'Create a separate identity?'}
      description={confirmIdentity?.kind === 'import'
        ? 'Choose this Mac’s backup in the file picker. AgentMux verifies it before reconnecting to your original work.'
        : `AgentMux opens a new window with its own identity. Your current window and saved work stay available. ${confirmIdentity?.kind === 'new' && confirmIdentity.gatewayCode ? 'The selected gateway comes with you for review.' : 'Enter the gateway code in the new window.'}`}
      confirmLabel={confirmIdentity?.kind === 'import' ? 'Choose backup…' : 'Create and open setup'}
      onCancel={() => setConfirmIdentity(undefined)}
      onConfirm={() => {
        const action = confirmIdentity
        setConfirmIdentity(undefined)
        if (action?.kind === 'import') recovery?.action?.run()
        if (action?.kind === 'new') openSeparate?.(action.gatewayCode)
      }} />
  </div>
}
