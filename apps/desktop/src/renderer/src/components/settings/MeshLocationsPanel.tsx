import { useMemo, useRef, type MouseEvent } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import { Button } from '@agentmux/client-ui/components/Button'
import { SelectionField } from '../SelectionField'
import type { HostConfig } from '../../../../shared/contracts'
import { meshLocationValue, readMeshLocation, type MeshMapLocations } from '../../../../shared/mesh-map-locations'
import { saveConfigSlice } from './save-config-slice'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraftRecord } from './use-setting-draft'
import { MeshAtlas, projectMeshLocation, unprojectMeshLocation, WORLD_WIDTH, WORLD_HEIGHT } from './MeshGeography'

export function MeshLocationsPanel({ hosts, locations, editing, onEdit }: {
  hosts: readonly HostConfig[]
  locations: MeshMapLocations | undefined
  editing: string | undefined
  onEdit: (id: string | undefined) => void
}) {
  const saved = useMemo(() => Object.fromEntries(hosts.map(host => [host.id, meshLocationValue(locations, host.id)])), [hosts, locations])
  const draft = useSettingDraftRecord(saved)
  const save = useSettingsSave()
  const current = hosts.find(host => host.id === editing)
  const value = current ? draft.value[current.id] ?? '' : ''
  const coordinates = useRef<HTMLInputElement>(null)
  const point = readMeshLocation(value)
  const marker = point && projectMeshLocation(point)
  const invalid = hosts.find(host => {
    const point = draft.value[host.id]?.trim()
    return point && !readMeshLocation(point)
  })

  function selectPosition(event: MouseEvent<HTMLButtonElement>, hostId: string) {
    if (event.detail === 0) { coordinates.current?.focus(); return }
    const bounds = event.currentTarget.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return
    const x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * WORLD_WIDTH
    const y = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) * WORLD_HEIGHT
    const { latitude, longitude } = unprojectMeshLocation({ x, y })
    draft.setField(hostId, `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`)
  }

  async function submit() {
    const submitted = draft.beginSave()
    submitted.finish(await save.run(async () => {
      await saveConfigSlice((config, values) => {
        const next = { ...config.meshMapLocations }
        for (const [id, coords] of Object.entries(values)) {
          if (submitted.value[id] === submitted.expected[id]) continue
          if (coords.trim()) Object.defineProperty(next, id, { value: coords.trim(), configurable: true, enumerable: true, writable: true })
          else delete next[id]
        }
        return { ...config, meshMapLocations: next }
      }, submitted.value, submitted.expected)
    }))
  }

  return <section hidden={editing === undefined} className="mesh-locations-panel" aria-label="Device map locations" data-settings-field="mesh-locations">
    <header><h3>Device locations</h3><Button type="button" onClick={() => onEdit(undefined)}>Close</Button></header>
    <div className="mesh-locations-panel__fields">
      <label><span>Device</span><SelectionField label="Map device" value={current?.id ?? ''} options={hosts.map(host => ({ value: host.id, label: host.label }))}
        onValueChange={onEdit} /></label>
      {current ? <label><span>Latitude, longitude</span><TextInput ref={coordinates} aria-label="Latitude, longitude" value={value}
        placeholder="Not set"
        onChange={event => draft.setField(current.id, event.target.value)} /></label> : null}
    </div>
    {current ? <button className="mesh-location-picker" type="button" aria-label="Pick device location on the map" onClick={event => selectPosition(event, current.id)}>
      <MeshAtlas>{marker ? <circle className="mesh-geography__pin" cx={marker.x} cy={marker.y} r="7" /> : null}</MeshAtlas>
    </button> : null}
    <p>Pick a location on the map or enter latitude and longitude in decimal degrees. Clear the field to remove the pin.</p>
    <SettingsSaveBar save={save} dirty={draft.dirty} resolution={draft}
      blocked={invalid ? `Enter valid coordinates for ${invalid.label}.` : undefined}
      label="Save locations" onSave={() => void submit()} />
  </section>
}
