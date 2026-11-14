import { useEffect, useMemo, useRef, useState } from 'react'
import type { MeshNetworkInspection, MeshNetworkSettings } from '@agentmux/core/mesh-network'
import { Button } from '@agentmux/client-ui/components/Button'
import type { HostConfig } from '../../../../shared/contracts'
import type { MeshMapLocations } from '../../../../shared/mesh-map-locations'
import { api } from '../../lib/api'
import { MeshNetworkMap } from './MeshNetworkMap'
import { MeshLocationsPanel } from './MeshLocationsPanel'
import './mesh-paths.css'

/** The mesh-paths discovery address opens the continuous Mesh overview, never a second network owner. */
export function MeshPathsPane({ active, hosts, locations, onGateway, onDevice }: {
  active: boolean
  hosts: readonly HostConfig[]
  locations?: MeshMapLocations | undefined
  onGateway: () => void
  onDevice: (hostId: string) => void
}) {
  const [editingLocation, editLocation] = useState<string>()
  const locationEditor = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (active && editingLocation !== undefined) locationEditor.current?.scrollIntoView({ block: 'nearest' })
  }, [active, editingLocation])
  const [snapshot, setSnapshot] = useState<MeshNetworkInspection>(), source = useRef<MeshNetworkInspection | undefined>(undefined)
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
  const savedHosts = useMemo(() => hosts.filter(host => host.kind === 'ssh'), [hosts])
  const actions = <><Button type="button" aria-expanded={editingLocation !== undefined} onClick={() => editLocation('local')}>Device locations</Button>
    <Button type="button" disabled={busy} onClick={() => setRevision(value => value + 1)}>{busy ? 'Reading…' : 'Refresh network'}</Button></>
  return <section className="mesh-paths-pane" aria-label="Mesh network overview" data-settings-field="mesh-paths">
    {issue ? <div className="mesh-paths-issue" role="status"><strong>Network observation unavailable.</strong><p>{snapshot ? 'Showing the last confirmed network.' : 'Current network state is unknown.'}</p><details><summary>Read details</summary><p>{issue}</p></details></div> : null}
    <div ref={locationEditor} hidden={editingLocation === undefined}>
      <MeshLocationsPanel hosts={hosts} locations={locations} editing={editingLocation} onEdit={editLocation} />
    </div>
    <MeshNetworkMap snapshot={snapshot} active={active && visible} actions={actions} localClient
      hosts={savedHosts} locations={locations} onLocation={editLocation} onDevice={onDevice} onGateway={onGateway} savedTargets={savedTargets} savedIssue={savedIssue} reading={busy && !snapshot} stale={Boolean(issue && snapshot)} />
  </section>
}
