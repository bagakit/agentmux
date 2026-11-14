import { useEffect, useRef, useState } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import type { MeshNetworkInspection, MeshNetworkLink, MeshOwner, MeshOwnerTarget } from '@agentmux/core/mesh-network'
import { useAppStore } from '../../store'
import { api } from '../../lib/api'

const issueText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

export function MeshAccessLinks({ active, owner, snapshot, offerText, onInput, copy }: {
  active: boolean; owner: MeshOwner; snapshot: MeshNetworkInspection | undefined; offerText: string
  onInput(text: string): void; copy(text: string): void
}) {
  const hosts = useAppStore(state => state.config?.hosts)
  const candidates = (hosts ?? []).flatMap(host => host.kind === 'ssh' && host.runtimeId
    ? [{ id: host.id, runtime: host.runtimeId, label: host.label }] : [])
  const [gateway, setGateway] = useState<MeshOwnerTarget>()
  const [expanded, setExpanded] = useState(false)
  const endpoint = snapshot?.endpoint.state === 'available' ? snapshot.endpoint.offer : undefined
  const key = gateway ? JSON.stringify([gateway.hostId, gateway.expectedRuntimeId]) : 'local'
  return <details className="mesh-advanced mesh-access-links" onToggle={e => setExpanded(e.currentTarget.open)}>
    <summary>Share access to this device</summary>
    <p>Use a gateway that can reach the original endpoint. The device receiving the link still needs approval on the target.</p>
    {endpoint ? <div className="mesh-network-section"><button type="button" className="small-button" onClick={() => copy(JSON.stringify(endpoint))}>Copy endpoint offer</button></div>
      : snapshot?.endpoint.state === 'not-provided' ? <p>This Core forwards traffic without a local endpoint.</p> : null}
    <label className="mesh-form-field"><span>Issue link on</span><select aria-label="Issuing gateway" value={key} onChange={e => {
      const found = candidates.find(item => JSON.stringify([item.id, item.runtime]) === e.target.value)
      setGateway(found ? { hostId: found.id, expectedRuntimeId: found.runtime } : undefined)
    }}><option value="local">This device</option>{gateway && !candidates.some(item => gateway.hostId === item.id && gateway.expectedRuntimeId === item.runtime) ? <option value={key}>Previously selected gateway</option> : null}
      {candidates.map(item => <option value={JSON.stringify([item.id, item.runtime])} key={item.id}>{item.label}</option>)}</select></label>
    {endpoint ? <button className="small-button" type="button" onClick={() => onInput(JSON.stringify(endpoint))}>Use this device’s endpoint</button> : null}
    <GatewayLink key={JSON.stringify([key, owner.runtimeId, owner.ownerInstanceId])} active={active} observe={expanded} target={gateway} owner={owner} local={snapshot}
      offerText={offerText} onInput={onInput} copy={copy} />
  </details>
}

function GatewayLink({ active, observe, target, owner, local, offerText, onInput, copy }: {
  active: boolean; observe: boolean; target: MeshOwnerTarget | undefined; owner: MeshOwner; local: MeshNetworkInspection | undefined
  offerText: string; onInput(text: string): void; copy(text: string): void
}) {
  const [remote, setRemote] = useState<MeshNetworkInspection>(), [readIssue, setReadIssue] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [link, setLink] = useState<MeshNetworkLink>(), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [choice, setChoice] = useState('')
  const request = useRef<AbortController | undefined>(undefined)
  const observation = target ? remote : local
  const entries = observation?.network?.records.find(record => record.originPeerId === observation.identity?.peerId)?.advertisedIngress ?? []
  const origin = (item: { endpoint: string; useTls: boolean }) => (item.useTls ? 'https://' : 'http://') + item.endpoint
  const selected = choice ? entries.find(item => origin(item) === choice) : entries[0]
  function reset() {
    request.current?.abort(); request.current = undefined
    setBusy(false); setLink(undefined); setError('')
  }
  useEffect(() => {
    if (!active || !observe || !target) return
    const controller = new AbortController()
    void api.mesh.call('mesh.inspect', { target }, { expectedOwner: owner, signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) { setRemote(value); setReadIssue('') }
    }).catch(cause => { if (!controller.signal.aborted) { setRemote(undefined); setReadIssue(issueText(cause)) } })
    return () => controller.abort()
  }, [active, observe, target, owner.runtimeId, owner.ownerInstanceId, refresh])
  useEffect(() => { reset(); return () => { request.current?.abort(); request.current = undefined } }, [active, offerText])
  async function createLink() {
    reset()
    const controller = new AbortController()
    request.current = controller; setBusy(true)
    try {
      const input = JSON.parse(offerText)
      const value = await api.mesh.call('mesh.link', { offer: input.offer ?? input, ...(target ? { target } : {}), ...(selected ? { ingress: selected } : {}) },
        { expectedOwner: owner, signal: controller.signal })
      if (request.current === controller) setLink(value)
    } catch (cause) { if (!controller.signal.aborted) setError(issueText(cause)) }
    finally { if (request.current === controller) { request.current = undefined; setBusy(false) } }
  }
  return <section className="mesh-network-section" data-settings-field="mesh-link">
    {entries.length > 0 || choice ? <label className="mesh-form-field"><span>Published gateway address</span>
      <select aria-label="Published gateway address" value={choice || (selected ? origin(selected) : '')} onChange={e => { reset(); setChoice(e.target.value) }}>
        {choice && !selected ? <option value={choice}>{choice} · no longer advertised</option> : null}
        {entries.map(item => <option key={origin(item)} value={origin(item)}>{origin(item)}</option>)}
      </select></label> : null}
    {target && !remote ? <div role="status">{readIssue || 'Reading the selected gateway…'}{readIssue ? <button type="button" onClick={() => setRefresh(n => n + 1)}>Read gateway again</button> : null}</div> : null}
    <label className="mesh-form-field"><span>Original endpoint offer</span><textarea aria-label="Original Mesh endpoint offer" value={offerText}
      onChange={e => { reset(); onInput(e.target.value) }} rows={3} placeholder="Paste an endpoint offer" /></label>
    <button className="small-button" type="button" disabled={busy || !offerText || Boolean(choice && !selected)} onClick={() => void createLink()}>{busy ? 'Reading route…' : 'Create access link'}</button>
    {error ? <p role="alert" className="settings-inline-error">{error}</p> : null}
    {link ? <div className="mesh-link-result"><span>{link.observation.route.hops} network hop{link.observation.route.hops === 1 ? '' : 's'} · {origin(link.observation.ingress)} · endpoint {link.offer.serverId}</span>
      <TextInput aria-label="Mesh access link" value={link.url} readOnly /><button className="small-button" onClick={() => copy(link.url)}>Copy access link</button>
      <details><summary>Original endpoint identity</summary><dl><dt>Server</dt><dd><code>{link.offer.serverId}</code></dd><dt>Encryption public key</dt><dd><code>{link.offer.daemonPublicKeyB64}</code></dd></dl></details>
      <small>On the accessing Mac, open Mesh → Use another device and paste this link.</small></div> : null}
  </section>
}
