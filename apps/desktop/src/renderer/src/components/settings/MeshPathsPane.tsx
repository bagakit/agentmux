import { useEffect, useMemo, useRef, useState } from 'react'
import type { MeshNetworkInspection, MeshNetworkSettings } from '@agentmux/core/mesh-network'
import type { HostConfig } from '../../../../shared/contracts'
import { api } from '../../lib/api'
import { MeshNetworkMap } from './MeshNetworkMap'
import { MeshSavedConnections } from './MeshSavedConnections'
import './mesh-paths.css'

/** The mesh-paths discovery address opens the continuous Mesh overview, never a second network owner. */
export function MeshPathsPane({ active, hosts, onGateway, onDevice }: {
  active: boolean
  hosts: readonly HostConfig[]
  onGateway: () => void
  onDevice: (hostId: string) => void
}) {
  const [snapshot, setSnapshot] = useState<MeshNetworkInspection>(), source = useRef<MeshNetworkInspection | undefined>(undefined)
  const [selectedSource, selectSource] = useState<'mesh' | 'saved'>()
  const [settings, setSettings] = useState<MeshNetworkSettings>()
  const [settingsIssue, setSettingsIssue] = useState('')
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
    void api.mesh.call('settings.mesh.inspect', {}, { signal: controller.signal }).then(next => {
      if (!controller.signal.aborted) { setSettings(next); setSettingsIssue('') }
    }).catch(cause => { if (!controller.signal.aborted) setSettingsIssue(cause instanceof Error ? cause.message : String(cause)) })
    return () => { controller.abort(); setBusy(false) }
  }, [active, visible, revision])
  const sameOwner = !snapshot || snapshot.owner.runtimeId === settings?.owner.runtimeId
    && snapshot.owner.ownerInstanceId === settings.owner.ownerInstanceId
  const savedTargets = sameOwner ? settings?.configuration.peers : undefined
  const savedIssue = settingsIssue || (settings && !sameOwner ? 'The saved settings belong to another Core instance.' : '')
  const network = snapshot?.network
  const hasMeshPeer = network?.state === 'active' && (
    network.peers.length > 0 || network.records.some(record => record.originPeerId !== network.identity?.peerId || record.neighbors.length > 0)
    || network.routes.some(route => route.hops > 0) || network.circuits.some(circuit => circuit.path.length > 1)
  )
  const savedHosts = useMemo(() => hosts.filter(host => host.kind === 'ssh'), [hosts])
  const hasSavedConnections = savedHosts.length > 0
  const showingSaved = hasSavedConnections && (selectedSource ?? (hasMeshPeer ? 'mesh' : 'saved')) === 'saved'
  const sourceControl = hasSavedConnections ? <div className="mesh-explorer__segments" role="group" aria-label="Map source">
    <button type="button" aria-pressed={showingSaved} onClick={() => selectSource('saved')}>Saved connections</button>
    <button type="button" aria-pressed={!showingSaved} onClick={() => selectSource('mesh')}>Mesh paths</button>
  </div> : null
  // Keep a visited chart's selection and viewport when switching observation sources.
  const [visitedSaved, setVisitedSaved] = useState(showingSaved)
  useEffect(() => { if (showingSaved) setVisitedSaved(true) }, [showingSaved])
  const savedMap = hasSavedConnections && (showingSaved || visitedSaved) ? <MeshSavedConnections
    hosts={savedHosts} active={active && visible && showingSaved} onDevice={onDevice} /> : null
  const actions = <button type="button" className="small-button" disabled={busy} onClick={() => setRevision(value => value + 1)}>{busy ? 'Reading…' : 'Refresh network'}</button>
  return <section className="mesh-paths-pane" aria-label="Mesh network overview" data-settings-field="mesh-paths">
    {issue ? <div className="mesh-paths-issue" role="status"><strong>Network observation unavailable.</strong><p>{snapshot ? 'Showing the last confirmed network.' : 'Current network state is unknown.'}</p><details><summary>Read details</summary><p>{issue}</p></details></div> : null}
    <MeshNetworkMap snapshot={snapshot} active={active && visible && !showingSaved} actions={actions}
      sourceControl={sourceControl} savedMap={savedMap} savedRouteCount={showingSaved ? savedHosts.length : undefined} onGateway={onGateway} savedTargets={savedTargets} savedIssue={savedIssue} reading={busy && !snapshot} stale={Boolean(issue && snapshot)} />
  </section>
}
