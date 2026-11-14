import { useEffect, useRef, useState } from 'react'
import type { MeshNetworkInspection } from '@agentmux/core/mesh-network'
import { api } from '../../lib/api'
import { MeshNetworkMap } from './MeshNetworkMap'
import './mesh-paths.css'

/** Network observation is usable independently of editable Gateway settings. */
export function MeshPathsPane({ active, onGateway }: { active: boolean; onGateway: () => void }) {
  const [snapshot, setSnapshot] = useState<MeshNetworkInspection>(), source = useRef<MeshNetworkInspection | undefined>(undefined)
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => { const changed = () => setVisible(document.visibilityState !== 'hidden'); document.addEventListener('visibilitychange', changed); return () => document.removeEventListener('visibilitychange', changed) }, [])
  const [issue, setIssue] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!active || !visible) return
    const controller = new AbortController()
    setBusy(true)
    void api.mesh.call('mesh.inspect', {}, { signal: controller.signal }).then(next => {
      if (controller.signal.aborted) return
      if (source.current && source.current.owner.runtimeId !== next.owner.runtimeId) throw Error('Another Core answered this network read. The original network view is retained.')
      source.current = next; setSnapshot(next); setIssue('')
    }).catch(cause => { if (!controller.signal.aborted) setIssue(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => { controller.abort(); setBusy(false) }
  }, [active, visible, revision])
  return <section className="mesh-paths-pane" aria-label="Mesh network paths" data-settings-field="mesh-paths">
    <header className="mesh-paths-heading"><div><span>Mesh network</span><h3>Follow the path between devices.</h3><p>Explore authenticated peers, reachable endpoints and the circuits in use.</p></div><div><button className="small-button" onClick={onGateway}>Gateway settings</button><button className="small-button" disabled={busy} onClick={() => setRevision(value => value + 1)}>{busy ? 'Reading…' : 'Refresh network'}</button></div></header>
    {issue ? <div className="mesh-paths-issue" role="status"><strong>Network observation unavailable.</strong><p>{snapshot ? 'The last confirmed network is retained below.' : 'No current network has been confirmed.'}</p><details><summary>Read details</summary><p>{issue}</p></details></div> : null}
    {!snapshot && !issue ? <p role="status">Reading this Core’s network…</p> : null}
    {snapshot ? <><p className="mesh-paths-source">{issue ? 'Last confirmed · ' : ''}{snapshot.network?.networkId ?? 'No active network'} · {snapshot.apply.state === 'disabled' ? 'Participation disabled' : snapshot.apply.state === 'active' ? 'Configuration active' : snapshot.apply.state === 'starting' ? 'Configuration applying' : 'Configuration unavailable'} · Observed {new Date(snapshot.observedAt).toLocaleTimeString()}</p><MeshNetworkMap snapshot={snapshot} active={active && visible} />{!snapshot.network ? <div className="mesh-paths-start"><h4>Connect a device to start exploring.</h4><p>Set this Core’s participation and exchange public connection codes in Gateway settings. Saved Host connections keep their own connection and permission settings.</p><button className="primary-button" onClick={onGateway}>Set up a gateway connection</button></div> : null}</> : null}
  </section>
}
