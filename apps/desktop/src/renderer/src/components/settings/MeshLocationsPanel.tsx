import { useMemo, useRef, type MouseEvent } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import { Button } from '@agentmux/client-ui/components/Button'
import { SelectionField } from '../SelectionField'
import { meshLocationValue, readMeshLocation, type MeshMapLocations } from '../../../../shared/mesh-map-locations'
import { saveConfigSlice } from './save-config-slice'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraftRecord } from './use-setting-draft'
import { MeshAtlas, projectMeshLocation, unprojectMeshLocation, WORLD_WIDTH, WORLD_HEIGHT } from './MeshGeography'

export type MapAnnotationTarget = { field: 'meshMapLocations' | 'meshNetworkMapLocations'; key: string; label: string }
export const annotationId = ({field, key}: MapAnnotationTarget) => JSON.stringify([field, key])

export function MeshLocationsPanel({ targets, locations, peerLocations, editing, onEdit }: {
  targets: readonly MapAnnotationTarget[]
  locations: MeshMapLocations | undefined
  peerLocations: MeshMapLocations | undefined
  editing: MapAnnotationTarget | undefined
  onEdit: (target: MapAnnotationTarget | undefined) => void
}) {
  // Keep an open annotation editable if a transient network observation loses this peer.
  const choices = useMemo(() => editing && !targets.some(item => annotationId(item) === annotationId(editing))
    ? [...targets, editing] : targets, [targets, editing])
  const saved = useMemo(() => Object.fromEntries(choices.map(target => [annotationId(target),
    meshLocationValue(target.field === 'meshMapLocations' ? locations : peerLocations, target.key)])),
    [choices, locations, peerLocations])
  const draft = useSettingDraftRecord(saved)
  const save = useSettingsSave()
  const current = editing && annotationId(editing)
  const value = current ? draft.value[current] ?? '' : ''
  const coordinates = useRef<HTMLInputElement>(null)
  const point = readMeshLocation(value)
  const marker = point && projectMeshLocation(point)
  const invalid = choices.find(target => {
    const point = draft.value[annotationId(target)]?.trim()
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
        const next = { ...config }
        for (const target of choices) {
          const id = annotationId(target)
          if (submitted.value[id] === submitted.expected[id]) continue
          const points = { ...next[target.field] }
          const coords = values[id]?.trim()
          if (coords) Object.defineProperty(points, target.key, { value: coords, enumerable: true, configurable: true, writable: true })
          else delete points[target.key]
          next[target.field] = points
        }
        return next
      }, submitted.value, submitted.expected)
    }))
  }

  return <section hidden={editing === undefined} className="mesh-locations-panel" aria-label="Device map locations" data-settings-field="mesh-locations">
    <header><h3>Device locations</h3><Button type="button" onClick={() => onEdit(undefined)}>Close</Button></header>
    <div className="mesh-locations-panel__fields">
      <label><span>Device</span><SelectionField label="Map device" value={current ?? ''} options={choices.map(target => ({ value: annotationId(target), label: target.label }))}
        onValueChange={id => onEdit(choices.find(target => annotationId(target) === id))} /></label>
      {current ? <label><span>Latitude, longitude</span><TextInput ref={coordinates} aria-label="Latitude, longitude" value={value}
        placeholder="Not set"
        onChange={event => draft.setField(current, event.target.value)} /></label> : null}
    </div>
    {current ? <button className="mesh-location-picker" type="button" aria-label="Pick device location on the map" onClick={event => selectPosition(event, current)}>
      <MeshAtlas>{marker ? <circle className="mesh-geography__pin" cx={marker.x} cy={marker.y} r="7" /> : null}</MeshAtlas>
    </button> : null}
    <p>Pick a location on the map or enter latitude and longitude in decimal degrees. Clear the field to remove the pin.</p>
    <SettingsSaveBar save={save} dirty={draft.dirty} resolution={draft}
      blocked={invalid ? `Enter valid coordinates for ${invalid.label}.` : undefined}
      label="Save locations" onSave={() => void submit()} />
  </section>
}
