import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, LoaderCircle, ShieldCheck } from 'lucide-react'
import type { HostCreationTrustSnapshot, SshHostConfig } from '../../../../shared/contracts'
import { configValuesEqual } from '../../../../shared/config-edit'
import { api } from '../../lib/api'

function route({ label: _label, ...host }: SshHostConfig): Omit<SshHostConfig, 'label'> { return host }
const same = (a: SshHostConfig | undefined, b: SshHostConfig | undefined) =>
  a !== undefined && b !== undefined && configValuesEqual(route(a), route(b))

export function HostCreationTrustPanel({ host, committed, active }: {
  host: SshHostConfig; committed: SshHostConfig | undefined; active: boolean
}) {
  const [state, setState] = useState<{ input?: SshHostConfig; snapshot?: HostCreationTrustSnapshot | undefined; busy?: boolean; error?: string | undefined }>({})
  const [verified, setVerified] = useState(false)
  const epoch = useRef(0)
  const current = useRef({ host, committed, active })
  current.current = { host, committed, active }
  const saved = same(host, committed)
  const snapshot = same(state.input, host) && saved ? state.snapshot : undefined
  const pin = snapshot?.target.sources.find(item => item.sourceRuntimeId === snapshot.source.runtimeId)
  const conflict = pin !== undefined && pin.publicKey !== snapshot?.source.publicKey
  const busy = state.busy === true
  const error = same(state.input, host) && saved ? state.error : undefined

  async function refresh(approve = false, entering = false): Promise<void> {
    if (!active || !saved || !entering && busy || approve && (!verified || !snapshot || pin)) return
    const input = structuredClone(host), request = ++epoch.current
    const expected = snapshot
    setState(previous => ({ ...previous, input, busy: true, error: undefined }))
    try {
      const next = approve
        ? await api.hosts.trustCreationSource(input, expected!)
        : await api.hosts.creationTrust(input)
      if (request !== epoch.current || !current.current.active || !same(input, current.current.host) || !same(input, current.current.committed)) return
      setState({ input, snapshot: next })
      setVerified(false)
    } catch (failure) {
      if (request !== epoch.current || !current.current.active || !same(input, current.current.host) || !same(input, current.current.committed)) return
      // A lost approval response is unknown. Reading pins is safe; approval is never replayed automatically.
      setState(previous => ({ input, snapshot: previous.snapshot, error: `${approve ? 'Approval result unconfirmed. Review the saved trust before trying again. ' : ''}${failure instanceof Error ? failure.message : String(failure)}` }))
      setVerified(false)
    }
  }

  const key = JSON.stringify(route(host)), committedKey = committed && JSON.stringify(route(committed))
  useEffect(() => {
    ++epoch.current; setVerified(false); setState({})
    if (active && saved) void refresh(false, true)
    return () => { ++epoch.current }
  }, [active, key, committedKey])

  return <section className="host-creation-trust" aria-label="Agent source trust">
    <header><ShieldCheck size={16} /><div><strong>Agents from this computer</strong><p>Allow authenticated Agents here to start new Agents on {host.label}.</p></div></header>
    {!saved ? <p className="field-hint">Save this connection before reviewing source trust.</p> : null}
    {snapshot ? <>
      <div className="host-creation-trust__identities">
        {([['Source · This computer', snapshot.source], [`Target · ${host.label}`, snapshot.target.authority]] as const).map(([label, identity]) =>
          <div key={label}><strong>{label}</strong><span>Runtime</span><code>{identity.runtimeId}</code><span>Key fingerprint</span><code>{identity.fingerprint}</code></div>)}
      </div>
      <p role="status" className={conflict ? 'host-creation-trust__conflict' : 'field-hint'}>{conflict ? 'A different source key is already trusted. The original key will be retained.' : pin ? <><CheckCircle2 size={13} /> This source is trusted on {host.label}.</> : 'This source is not yet trusted on this target.'}</p>
      {!pin ? <label className="host-creation-trust__verify"><input type="checkbox" checked={verified} disabled={busy} onChange={event => setVerified(event.target.checked)} />I have verified the source and target fingerprints.</label> : null}
    </> : null}
    {error ? <p className="field-error" role="alert">{error}</p> : null}
    <div className="host-creation-trust__actions">
      <button type="button" className="small-button" disabled={!saved || busy} onClick={() => void refresh()}>{busy ? <LoaderCircle className="spin" size={13} /> : null} Review source trust</button>
      {snapshot && !pin && !error ? <button type="button" className="primary-button" disabled={!verified || busy} onClick={() => void refresh(true)}>Trust this computer</button> : null}
    </div>
  </section>
}
