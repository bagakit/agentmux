import { decodeMeshPeerCode, type MeshPeerCode } from '@agentmux/core/mesh-peer-code'
import { TextInput } from '@agentmux/client-ui/input'
import { useId, useState } from 'react'
import { meshPeerFormPatch, type MeshForm } from '../../lib/mesh-settings-draft'

export function MeshPeerPairing({ input, form, ownPeerId, allowNewNetwork, inputRef, onInput, onAdd, onApprove, busy }: {
  input: string; form: MeshForm; ownPeerId?: string | undefined; allowNewNetwork: boolean; inputRef: React.RefObject<HTMLInputElement | null>
  onInput(value: string): void
  onAdd(patch: Partial<MeshForm>): void
  onApprove?: ((code: string, peer: MeshPeerCode) => void) | undefined
  busy?: boolean
}) {
  const [error, setError] = useState('')
  const errorId = useId()
  const code = input.trim()
  let candidate: MeshPeerCode | undefined
  try { if (code) candidate = decodeMeshPeerCode(code) } catch { /* Incomplete pasted or typed text stays editable. */ }
  function add() {
    try {
      const next = decodeMeshPeerCode(code)
      if (onApprove) onApprove(code, next)
      else onAdd(meshPeerFormPatch(form, code, next, ownPeerId, allowNewNetwork))
      setError('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  return <div className="mesh-peer-pairing">
    <label className="mesh-form-field"><span>Pair with a device</span><TextInput ref={inputRef} aria-label="Paste a connection code" value={input}
      aria-invalid={Boolean(error && !candidate) || undefined} aria-describedby={error ? errorId : undefined} spellCheck={false}
      placeholder="Paste its Mesh connection code" onChange={e => { setError(''); onInput(e.target.value) }} /></label>
    {candidate ? <MeshPeerPreview peer={candidate} /> : null}
    {code ? <button type="button" className={onApprove ? 'primary-button' : 'small-button'} disabled={Boolean(onApprove && busy)} onClick={add}>{onApprove ? 'Approve device' : 'Add to network settings'}</button> : null}
    {error ? <p id={errorId} className="settings-inline-error" role="alert">{error}</p> : null}
  </div>
}

export function MeshPeerPreview({ peer }: { peer: MeshPeerCode }) {
  return <dl className="mesh-peer-preview"><dt>Network</dt><dd>{peer.networkId}</dd>
    <dt>Address</dt><dd>{peer.endpoints.map(item => (item.useTls ? 'https://' : 'http://') + item.endpoint).join(' · ') || 'This device connects out'}</dd>
    <dt>Peer</dt><dd><details><summary><code>{peer.peerId.length > 22 ? `${peer.peerId.slice(0, 9)}…${peer.peerId.slice(-7)}` : peer.peerId}</code></summary>
      <code>{peer.peerId}</code></details></dd></dl>
}
