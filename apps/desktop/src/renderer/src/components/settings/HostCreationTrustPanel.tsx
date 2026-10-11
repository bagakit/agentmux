import { useEffect, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { HostCreationTrustSnapshot, SshHostConfig } from '../../../../shared/contracts'
import { configValuesEqual } from '../../../../shared/config-edit'
import { api } from '../../lib/api'

const ThemeStatusAuthorizedIcon = semanticIconComponent('status.authorized')
const ThemeStatusCompletedIcon = semanticIconComponent('status.completed')
const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')


function route({ label: _label, ...host }: SshHostConfig): Omit<SshHostConfig, 'label'> { return host }
const same = (a: SshHostConfig | undefined, b: SshHostConfig | undefined) =>
  a !== undefined && b !== undefined && configValuesEqual(route(a), route(b))
type TrustState = {
  input?: SshHostConfig
  snapshot?: HostCreationTrustSnapshot | undefined
  busy?: boolean
  error?: { message: string } | undefined
  unconfirmedApproval?: { message: string } | undefined
}

export function HostCreationTrustPanel({ host, committed, active }: {
  host: SshHostConfig; committed: SshHostConfig | undefined; active: boolean
}) {
  const [state, setState] = useState<TrustState>({})
  const [verified, setVerified] = useState(false)
  const epoch = useRef(0)
  const current = useRef({ host, committed })
  current.current = { host, committed }
  const saved = same(host, committed)
  const snapshot = same(state.input, host) && saved ? state.snapshot : undefined
  const pin = snapshot?.target.sources.find(item => item.sourceRuntimeId === snapshot.source.runtimeId)
  const conflict = pin !== undefined && pin.publicKey !== snapshot?.source.publicKey
  const busy = state.busy === true
  const error = same(state.input, host) && saved ? state.error : undefined
  const unconfirmedApproval = same(state.input, host) && saved ? state.unconfirmedApproval : undefined

  async function refresh(approve = false, entering = false): Promise<void> {
    if (!active || !saved || !entering && busy || approve && (!verified || !snapshot || pin)) return
    const input = structuredClone(host), request = ++epoch.current
    const expected = snapshot
    setState(previous => ({ ...previous, input, busy: true }))
    try {
      const next = approve
        ? await api.hosts.trustCreationSource(input, expected!)
        : await api.hosts.creationTrust(input)
      if (request !== epoch.current || !same(input, current.current.host) || !same(input, current.current.committed)) return
      setState({ input, snapshot: next })
      setVerified(false)
    } catch (failure) {
      if (request !== epoch.current || !same(input, current.current.host) || !same(input, current.current.committed)) return
      // A lost approval response is unknown. Reading pins is safe; approval is never replayed automatically.
      const message = failure instanceof Error ? failure.message : String(failure)
      setState(previous => ({ ...previous, input, busy: false,
        ...(approve ? { unconfirmedApproval: { message } } : { error: { message } }) }))
      setVerified(false)
    }
  }

  const key = JSON.stringify(route(host)), committedKey = committed && JSON.stringify(route(committed))
  useEffect(() => {
    ++epoch.current; setVerified(false); setState({})
    return () => { ++epoch.current }
  }, [key, committedKey])
  useEffect(() => {
    if (!active) setVerified(false)
    if (active && saved && !same(state.input, host)) void refresh(false, true)
  }, [active, key, committedKey])

  return <section className="host-creation-trust" aria-label="Agent source trust">
    <header><ThemeStatusAuthorizedIcon size={16} /><div><strong>Agents from this computer</strong><p>Allow authenticated Agents here to start new Agents on {host.label}.</p></div></header>
    {!saved ? <p className="field-hint">Save this connection before reviewing source trust.</p> : null}
    {snapshot ? <>
      <div className="host-creation-trust__identities">
        {([['Source · This computer', snapshot.source], [`Target · ${host.label}`, snapshot.target.authority]] as const).map(([label, identity]) =>
          <div key={label}><strong>{label}</strong><span>Runtime</span><code>{identity.runtimeId}</code><span>Key fingerprint</span><code>{identity.fingerprint}</code></div>)}
      </div>
      <p role="status" className={conflict ? 'host-creation-trust__conflict' : 'field-hint'}>{conflict ? 'A different source key is already trusted. The original key will be retained.' : pin ? <><ThemeStatusCompletedIcon size={13} /> This source is trusted on {host.label}.</> : 'This source is not yet trusted on this target.'}</p>
      {!pin ? <label className="host-creation-trust__verify"><input type="checkbox" checked={verified} disabled={busy} onChange={event => setVerified(event.target.checked)} />I have verified the source and target fingerprints.</label> : null}
    </> : null}
    {unconfirmedApproval ? <p className="field-error" role="alert">Approval result unconfirmed. Review the saved trust before trying again. {unconfirmedApproval.message}</p> : null}
    {error ? <p className="field-error" role="alert">{error.message}</p> : null}
    <div className="host-creation-trust__actions">
      <button type="button" className="small-button" disabled={!saved || busy} onClick={() => void refresh()}>{busy ? <ThemeStatusLoadingIcon animation="spin" size={13} /> : null} Review source trust</button>
      {snapshot && !pin && !error && !unconfirmedApproval ? <button type="button" className="primary-button" disabled={!verified || busy} onClick={() => void refresh(true)}>Trust this computer</button> : null}
    </div>
  </section>
}
