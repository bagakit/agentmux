import { decodeMeshPeerCode, type MeshPeerCode } from '@agentmux/core/mesh-peer-code'
import { TextInput } from '@agentmux/client-ui/input'
import { useId, useState } from 'react'
import type { MeshForm } from '../../lib/mesh-settings-draft'

export function MeshPeerPairing({ input, form, ownPeerId, allowNewNetwork, inputRef, onInput, onAdd }: {
  input: string; form: MeshForm; ownPeerId?: string | undefined; allowNewNetwork: boolean; inputRef: React.RefObject<HTMLInputElement | null>
  onInput(value: string): void
  onAdd(patch: Partial<MeshForm>): void
}) {
  const [error, setError] = useState('')
  const errorId = useId()
  const code = input.trim()
  let candidate: MeshPeerCode | undefined
  try { if (code) candidate = decodeMeshPeerCode(code) } catch { /* Incomplete pasted or typed text stays editable. */ }
  function add() {
    try {
      const next = decodeMeshPeerCode(code)
      if (next.peerId === ownPeerId) throw Error('This code belongs to this device. Paste the other device’s code.')
      if (!allowNewNetwork && next.networkId !== form.networkId) {
        throw Error('This code belongs to another network. Check the network name before adding the peer.')
      }
      const codes = form.peers.split(/\s+/u).filter(Boolean)
      const trusted = codes.map(decodeMeshPeerCode)
      if (trusted.some(peer => peer.networkId !== next.networkId || peer.peerId === next.peerId && peer.publicKey !== next.publicKey)) {
        throw Error('This code conflicts with the network or an existing peer. Review the saved peers before adding it.')
      }
      const index = trusted.findIndex(peer => peer.peerId === next.peerId)
      if (index === -1) codes.push(code)
      else codes[index] = code
      onAdd({ networkId: next.networkId, role: form.role === 'disabled' ? 'participant' : form.role, peers: codes.join('\n') })
      setError('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  return <div className="mesh-peer-pairing">
    <label className="mesh-form-field"><span>Pair with a device</span><TextInput ref={inputRef} aria-label="Paste a connection code" value={input}
      aria-invalid={Boolean(error && !candidate) || undefined} aria-describedby={error ? errorId : undefined} spellCheck={false}
      placeholder="Paste its Mesh connection code" onChange={e => { setError(''); onInput(e.target.value) }} /></label>
    {candidate ? <dl className="mesh-peer-preview"><dt>Network</dt><dd>{candidate.networkId}</dd><dt>Peer</dt><dd><details><summary><code>{candidate.peerId.length > 22 ? `${candidate.peerId.slice(0, 9)}…${candidate.peerId.slice(-7)}` : candidate.peerId}</code></summary>
        <code>{candidate.peerId}</code></details></dd>
      <dt>Address</dt><dd>{candidate.endpoints.map(item => (item.useTls ? 'https://' : 'http://') + item.endpoint).join(' · ') || 'This device connects out'}</dd></dl> : null}
    {code ? <button type="button" className="small-button" onClick={add}>Add to network settings</button> : null}
    {error ? <p id={errorId} className="settings-inline-error" role="alert">{error}</p> : null}
  </div>
}
