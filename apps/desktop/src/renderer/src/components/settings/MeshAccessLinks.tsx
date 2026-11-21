import { useEffect, useRef, useState } from 'react'
import { InputGroup, NativeSelect, Textarea, TextInput } from '@agentmux/client-ui/input'
import type { MeshNetworkInspection, MeshNetworkLink, MeshOwnerTarget } from '@agentmux/core/mesh-network'
import { MeshOperatorTarget } from './MeshOperatorTarget'
import { api } from '../../lib/api'

const issueText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

export function MeshAccessLinks({ active, target, separateRuntimeId, deviceLabel, snapshot, offerText, onInput, copy }: {
  active: boolean; target: MeshOwnerTarget | undefined; deviceLabel: string; snapshot: MeshNetworkInspection | undefined; offerText: string
  separateRuntimeId?: string | undefined
  onInput(text: string): void; copy(text: string): void
}) {
  const [expanded, setExpanded] = useState(false)
  const endpoint = snapshot?.endpoint.state === 'available' ? snapshot.endpoint.offer : undefined
  return <details className="mesh-advanced mesh-access-links" onToggle={e => setExpanded(e.currentTarget.open)}>
    <summary>Share a device access link</summary>
    <p>Use a gateway that can reach the original endpoint. The device receiving the link still needs approval on the target.</p>
    {endpoint ? <div className="mesh-endpoint-source"><strong>{deviceLabel} · {endpoint.serverId}</strong>
      <button type="button" className="small-button" onClick={() => copy(JSON.stringify(endpoint))}>Copy endpoint offer</button></div>
      : snapshot?.endpoint.state === 'not-provided' ? <p>This Core forwards traffic without a local endpoint.</p> : null}
    {endpoint && offerText ? <button className="small-button" type="button" onClick={() => onInput('')}>Use {target ? deviceLabel + '’s' : 'this device’s'} endpoint</button> : null}
    <MeshOperatorTarget label="Issuing gateway" active={active && expanded} initial={target}>{(issuer) =>
      <GatewayLink active={active} observe={expanded} target={issuer} separateRuntimeId={issuer ? undefined : separateRuntimeId}
        sameDevice={issuer?.hostId === target?.hostId && issuer?.expectedRuntimeId === target?.expectedRuntimeId}
        subject={snapshot} originalEndpoint={endpoint} offerText={offerText} onInput={onInput} copy={copy} />
    }</MeshOperatorTarget>
  </details>
}

function GatewayLink({ active, observe, target, separateRuntimeId, sameDevice, subject, originalEndpoint, offerText, onInput, copy }: {
  active: boolean; observe: boolean; target: MeshOwnerTarget | undefined; sameDevice: boolean; subject: MeshNetworkInspection | undefined
  separateRuntimeId?: string | undefined
  originalEndpoint?: MeshNetworkLink['offer'] | undefined; offerText: string; onInput(text: string): void; copy(text: string): void
}) {
  const [remote, setRemote] = useState<MeshNetworkInspection>(), [readIssue, setReadIssue] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [link, setLink] = useState<MeshNetworkLink>(), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [choice, setChoice] = useState('')
  const request = useRef<AbortController | undefined>(undefined)
  const originalOffer = offerText.trim() || (originalEndpoint ? JSON.stringify(originalEndpoint) : '')
  const observation = sameDevice ? subject : remote
  const entries = observation?.network?.records.find(record => record.originPeerId === observation.identity?.peerId)?.advertisedIngress ?? []
  const origin = (item: { endpoint: string; useTls: boolean }) => (item.useTls ? 'https://' : 'http://') + item.endpoint
  const selected = choice ? entries.find(item => origin(item) === choice) : entries[0]
  function reset() {
    request.current?.abort(); request.current = undefined
    setBusy(false); setLink(undefined); setError('')
  }
  useEffect(() => {
    if (!active || !observe || sameDevice) return
    const controller = new AbortController()
    void api.mesh.call('mesh.inspect', target ? { target } : {}, { signal: controller.signal, ...(separateRuntimeId ? { separateRuntimeId } : {}) }).then(value => {
      if (!controller.signal.aborted) { setRemote(value); setReadIssue('') }
    }).catch(cause => { if (!controller.signal.aborted) { setRemote(undefined); setReadIssue(issueText(cause)) } })
    return () => controller.abort()
  }, [active, observe, sameDevice, target?.hostId, target?.expectedRuntimeId, separateRuntimeId, refresh])
  useEffect(() => { reset(); return () => { request.current?.abort(); request.current = undefined } }, [active, originalOffer])
  async function createLink() {
    reset()
    const controller = new AbortController()
    request.current = controller; setBusy(true)
    try {
      const input = JSON.parse(originalOffer)
      const value = await api.mesh.call('mesh.link', { offer: input.offer ?? input, ...(target ? { target } : {}), ...(selected ? { ingress: selected } : {}) },
        { ...(observation ? { expectedOwner: observation.owner } : {}), ...(separateRuntimeId ? { separateRuntimeId } : {}), signal: controller.signal })
      if (request.current === controller) setLink(value)
    } catch (cause) { if (!controller.signal.aborted) setError(issueText(cause)) }
    finally { if (request.current === controller) { request.current = undefined; setBusy(false) } }
  }
  const offerField = <label className="mesh-form-field"><span>Original endpoint offer</span><Textarea aria-label="Original Mesh endpoint offer" value={offerText}
    onChange={e => { reset(); onInput(e.target.value) }} rows={3} placeholder="Paste an endpoint offer" /></label>
  return <section className="mesh-network-section" data-settings-field="mesh-link">
    {entries.length > 0 || choice ? <label className="mesh-form-field"><span>Published gateway address</span>
      <NativeSelect aria-label="Published gateway address" value={choice || (selected ? origin(selected) : '')} onChange={e => { reset(); setChoice(e.target.value) }}>
        {choice && !selected ? <option value={choice}>{choice} · no longer advertised</option> : null}
        {entries.map(item => <option key={origin(item)} value={origin(item)}>{origin(item)}</option>)}
      </NativeSelect></label> : null}
    {!sameDevice && !remote ? <div role="status">{readIssue || 'Reading the selected gateway…'}{readIssue ? <button type="button" onClick={() => setRefresh(n => n + 1)}>Read gateway again</button> : null}</div> : null}
    {originalEndpoint ? <details className="mesh-advanced"><summary>Use a different endpoint offer{offerText ? ' · selected' : ''}</summary>{offerField}</details> : offerField}
    <button className="small-button" type="button" disabled={busy || !originalOffer || Boolean(choice && !selected)} onClick={() => void createLink()}>{busy ? 'Reading route…' : 'Create access link'}</button>
    {error ? <p role="alert" className="settings-inline-error">{error}</p> : null}
    {link ? <div className="mesh-link-result"><span>{link.observation.route.hops} network hop{link.observation.route.hops === 1 ? '' : 's'} · {origin(link.observation.ingress)} · endpoint {link.offer.serverId}</span>
      <InputGroup className="mesh-link-result__field">
        <TextInput aria-label="Mesh access link" value={link.url} readOnly />
        <button type="button" className="small-button" onClick={() => copy(link.url)}>Copy access link</button>
      </InputGroup>
      <details><summary>Original endpoint identity</summary><dl><dt>Server</dt><dd><code>{link.offer.serverId}</code></dd><dt>Encryption public key</dt><dd><code>{link.offer.daemonPublicKeyB64}</code></dd></dl></details>
      <small>On the accessing Mac, open Mesh → Use another device and paste this link.</small></div> : null}
  </section>
}
