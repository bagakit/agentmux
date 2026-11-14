import { useEffect, useRef, useState } from 'react'
import type { BrowserProxyProbe, BrowserProxyProbeHistory, BrowserProxyProbeReason } from '@agentmux/core/control'
import { Button } from '@agentmux/client-ui/components/Button'
import type { BrowserProfileSummary } from '../../../../shared/contracts'
import { api } from '../../lib/api'
import './profile-network-diagnostics.css'

type Ports = Pick<typeof api.browser, 'probeProfileNetwork' | 'profileNetworkHistory'>
const reasons: Record<BrowserProxyProbeReason, string> = {
  'not-started': 'Not observed', 'no-proxy': 'No proxy configured', 'not-socks5': 'SOCKS5 only',
  'connection-unavailable': 'No connection confirmed', 'protocol-unavailable': 'No protocol reply confirmed',
  'credentials-unavailable': 'Sign-in unavailable for this route', 'credential-size': 'Sign-in exceeds this protocol’s field size',
  'authentication-rejected': 'Proxy rejected sign-in', 'unsupported-authentication': 'Proxy did not accept the offered sign-in methods',
  'route-changed': 'Route changed during this check', 'exit-unavailable': 'No exit response confirmed', 'check-address-missing': 'Set an exit address to include this check'
}
function resultText(row: BrowserProxyProbe, phase: 'tcp' | 'authentication' | 'exit'): string {
  const value = row[phase]
  if (value.status === 'reachable') return `${value.ip ?? 'Response received'} · HTTP ${value.httpStatus}`
  if (value.status === 'connected') return 'Connected'
  if (value.status === 'authenticated') return 'Accepted by SOCKS5 proxy'
  if (value.status === 'not-required') return 'Proxy did not require sign-in'
  if (value.reason && value.reason in reasons) return reasons[value.reason as BrowserProxyProbeReason]
  return 'Unknown'
}
function Observation({ diagnostic }: { diagnostic: BrowserProxyProbe }) {
  return <>
    <dl className="profile-network-diagnostics__facts">
      {(['tcp', 'authentication', 'exit'] as const).map((phase, index) => <div key={phase} data-observation={diagnostic[phase].status}>
        <dt>{['TCP connection', 'SOCKS5 sign-in', 'Profile exit'][index]}</dt><dd>{resultText(diagnostic, phase)}</dd>
      </div>)}
    </dl>
    <p className="browser-profile-editor__quiet">TCP and sign-in describe this proxy probe. Only the exit request uses this Profile’s Browser session.</p>
  </>
}

/** The current result and history are projections of the original Main Profile owner. */
export function ProfileNetworkDiagnostics({ profile, ports = api.browser }: { profile: BrowserProfileSummary; ports?: Ports }) {
  const [history, setHistory] = useState<BrowserProxyProbeHistory | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [result, setResult] = useState<BrowserProxyProbe | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const generation = useRef(0)
  const load = async (before?: string) => {
    const current = generation.current
    try {
      const next = await ports.profileNetworkHistory(profile.id, undefined, before)
      if (current === generation.current) { setHistory(next); setHistoryError(null) }
    } catch { if (current === generation.current) setHistoryError('History could not be read. Your Profile and Browser remain available.') }
  }
  useEffect(() => {
    generation.current++; setResult(null); setPendingId(null); setChecking(false); setNotice(null); setHistory(null)
    void load()
    return () => { generation.current++ }
  }, [profile.id, ports])
  const check = async () => {
    const current = generation.current, operationId = crypto.randomUUID()
    setChecking(true); setPendingId(operationId); setNotice(null)
    try {
      const observed = await ports.probeProfileNetwork(profile.id, operationId)
      if (current !== generation.current) return
      setResult(observed.diagnostic)
      setNotice(observed.historySaved ? null : 'The result was observed; its history save is unconfirmed. Inspect this check before starting another.')
      await load()
    } catch {
      if (current === generation.current) setNotice('This check’s result is unconfirmed. Inspect its original record; your Profile and Browser remain available.')
    } finally { if (current === generation.current) setChecking(false) }
  }
  const inspect = async () => {
    if (!pendingId) return
    const current = generation.current
    try {
      const original = await ports.profileNetworkHistory(profile.id, pendingId)
      if (current !== generation.current) return
      const row = original.diagnostics[0]
      if (row) {
        setResult(current => current?.id === row.id && current.phase === 'observed' && row.phase === 'pending' ? current : row)
        setNotice(row.phase === 'pending' ? 'This check’s history is unfinished. The latest observed result remains here; no new protocol request was sent.' : null)
      }
      else setNotice('No original record could be confirmed. This does not prove that the request never ran; it was not replayed.')
    } catch { if (current === generation.current) setNotice('The original check could not be read. Keep its identity and inspect again when history is available.') }
  }
  return <section className="browser-profile-editor__section profile-network-diagnostics" aria-label="Proxy diagnostics">
    <div className="profile-network-diagnostics__heading"><h4>Proxy diagnostics</h4>
      <Button type="button" disabled={checking} onClick={() => void check()}>{checking ? 'Checking…' : result ? 'New check' : 'Check route'}</Button>
    </div>
    {result ? <Observation diagnostic={result} /> : <p className="browser-profile-editor__quiet">Check the connection, SOCKS5 sign-in and Profile exit separately.</p>}
    {notice ? <p role="status" className="profile-network-diagnostics__notice">{notice} {pendingId ? <button type="button" className="browser-profile-editor__link" onClick={() => void inspect()}>Inspect check</button> : null}</p> : null}
    {result && result.configurationRevision !== profile.revision ? <p className="browser-profile-editor__quiet">This observation belongs to an earlier Profile configuration.</p> : null}
    <details className="profile-network-diagnostics__history"><summary>Recent checks{history?.diagnostics.length ? ` · ${history.diagnostics.length}` : ''}</summary>
      {historyError ? <p role="status">{historyError} <button type="button" className="browser-profile-editor__link" onClick={() => void load()}>Read again</button></p>
        : history === null ? <p>Reading history…</p> : history.diagnostics.length === 0 ? <p>No recorded checks.</p>
        : <ol>{history.diagnostics.map(row => <li key={row.id}>
          <button type="button" onClick={() => { setResult(row); setPendingId(row.id); setNotice(row.phase === 'pending' ? 'This original check has not produced a complete recorded result. Inspect it without replaying.' : null) }}>
            <time dateTime={new Date(row.startedAt).toISOString()}>{new Date(row.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
            <span>{row.route.mode === 'proxy' ? `${row.route.scheme}://${row.route.host}:${row.route.port}` : row.route.mode}</span>
            <span>{row.phase === 'pending' ? 'Unfinished' : row.authentication.status === 'authenticated' ? 'SOCKS5 accepted' : row.authentication.status === 'rejected' ? 'Sign-in rejected' : row.exit.status === 'reachable' ? `HTTP ${row.exit.httpStatus}` : 'Unknown'}</span>
          </button>
        </li>)}</ol>}
      {history?.nextCursor ? <button type="button" className="browser-profile-editor__link" onClick={() => void load(history.nextCursor!)}>Earlier checks</button> : null}
      {history && history.diagnostics.length ? <button type="button" className="browser-profile-editor__link" onClick={() => void load()}>Latest checks</button> : null}
    </details>
  </section>
}
