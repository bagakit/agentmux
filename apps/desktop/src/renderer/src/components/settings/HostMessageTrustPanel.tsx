import { useEffect, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { Button } from '@agentmux/client-ui/components/Button'
import type { HostMessageTrustDirection, HostMessageTrustSnapshot, SshHostConfig } from '../../../../shared/contracts'
import { configValuesEqual } from '../../../../shared/config-edit'
import { api } from '../../lib/api'

const MessageIcon = semanticIconComponent('object.agent-messaging')
const CompletedIcon = semanticIconComponent('status.completed')
const LoadingIcon = semanticIconComponent('status.loading')
function route({ label: _label, ...host }: SshHostConfig): Omit<SshHostConfig, 'label'> { return host }
const same = (a: SshHostConfig | undefined, b: SshHostConfig | undefined) =>
  a !== undefined && b !== undefined && configValuesEqual(route(a), route(b))
type State = { input?: SshHostConfig; snapshot?: HostMessageTrustSnapshot; busy?: boolean; error?: string; unconfirmed?: string }

export function HostMessageTrustPanel({ host, committed, active }: {
  host: SshHostConfig; committed: SshHostConfig | undefined; active: boolean
}) {
  const [state, setState] = useState<State>({})
  const [verified, setVerified] = useState<Partial<Record<HostMessageTrustDirection, boolean>>>({})
  const epoch = useRef(0), current = useRef({ host, committed })
  current.current = { host, committed }
  const saved = same(host, committed), applicable = same(state.input, host) && saved
  const snapshot = applicable ? state.snapshot : undefined
  const busy = state.busy === true
  const key = JSON.stringify(route(host)), committedKey = committed && JSON.stringify(route(committed))

  async function refresh(direction?: HostMessageTrustDirection, entering = false): Promise<void> {
    if (!active || !saved || !entering && busy || direction && (!verified[direction] || !snapshot || state.unconfirmed)) return
    const input = structuredClone(host), expected = snapshot, request = ++epoch.current
    setState(previous => ({ ...previous, input, busy: true }))
    try {
      const next = direction ? await api.hosts.trustMessageSource(input, expected!, direction) : await api.hosts.messageTrust(input)
      if (request !== epoch.current || !same(input, current.current.host) || !same(input, current.current.committed)) return
      setState({ input, snapshot: next }); setVerified({})
    } catch (failure) {
      if (request !== epoch.current || !same(input, current.current.host) || !same(input, current.current.committed)) return
      const message = failure instanceof Error ? failure.message : String(failure)
      // A failed approval response may have committed. Only a read reconciles it; never repeat it automatically.
      setState(previous => ({ ...previous, input, busy: false, ...(direction ? { unconfirmed: message } : { error: message }) }))
      setVerified({})
    }
  }
  useEffect(() => { ++epoch.current; setState({}); setVerified({}); return () => { ++epoch.current } }, [key, committedKey])
  useEffect(() => {
    if (!active) setVerified({})
    if (active && saved && !same(state.input, host)) void refresh(undefined, true)
  }, [active, key, committedKey])

  return <section className="host-creation-trust host-message-trust" aria-label="Agent message trust">
    <header><MessageIcon size={16} /><div><strong>Agent messages</strong><p>Approve each direction to exchange tasks and replies with {host.label}.</p></div></header>
    {!saved ? <p className="field-hint">Save this connection before reviewing message trust.</p> : null}
    {snapshot ? <>
      <details className="host-message-trust__identities"><summary>Runtime identities and fingerprints</summary>
        <div className="host-creation-trust__identities">{([['This computer', snapshot.local.authority], [host.label, snapshot.remote.authority]] as const).map(([label, identity], index) =>
          <div key={index}><strong>{label}</strong><span>Runtime</span><code>{identity.runtimeId}</code><span>Key fingerprint</span><code>{identity.fingerprint}</code></div>)}</div>
      </details>
      {(['outbound', 'inbound'] as const).map(direction => {
        const from = direction === 'outbound' ? 'This computer' : host.label
        const to = direction === 'outbound' ? host.label : 'This computer'
        const source = direction === 'outbound' ? snapshot.local.authority : snapshot.remote.authority
        const target = direction === 'outbound' ? snapshot.remote : snapshot.local
        const pin = target.sources.find(item => item.sourceRuntimeId === source.runtimeId)
        const conflict = pin !== undefined && pin.publicKey !== source.publicKey
        return <div className="host-message-trust__direction" key={direction}>
          <strong>{from} → {to}</strong>
          <p role="status" className={conflict ? 'host-creation-trust__conflict' : 'field-hint'}>{conflict ? 'A different source key is saved. The original trust is retained.' : pin ? <><CompletedIcon size={13} /> Messages from this source are trusted.</> : 'Message source approval required.'}</p>
          {!pin && !state.unconfirmed ? <>
            <label className="host-creation-trust__verify"><input type="checkbox" checked={verified[direction] === true} disabled={busy} onChange={event => setVerified(previous => ({ ...previous, [direction]: event.target.checked }))} />I verified both fingerprints for this direction.</label>
            <div className="host-creation-trust__actions"><Button type="button" disabled={!verified[direction] || busy || Boolean(state.error)} onClick={() => void refresh(direction)}>Allow messages to {to}</Button></div>
          </> : null}
        </div>
      })}
    </> : null}
    {applicable && state.unconfirmed ? <p className="field-error" role="alert">Approval result unconfirmed. Read saved trust before trying again. {state.unconfirmed}</p> : null}
    {applicable && state.error ? <p className="field-error" role="alert">{state.error}</p> : null}
    <div className="host-creation-trust__actions"><Button type="button" disabled={!saved || busy} onClick={() => void refresh()}>{busy ? <LoadingIcon animation="spin" size={13} /> : null} Review message trust</Button></div>
  </section>
}
