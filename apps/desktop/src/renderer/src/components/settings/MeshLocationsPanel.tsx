import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import { Button } from '@agentmux/client-ui/components/Button'
import { SelectionField } from '../SelectionField'
import { meshLocationValue, readMeshLocation, type MacMapLocationResult, type MeshMapLocations } from '../../../../shared/mesh-map-locations'
import { api } from '../../lib/api'
import { saveConfigSlice } from './save-config-slice'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraftRecord } from './use-setting-draft'
import { MeshAtlas, projectMeshLocation, unprojectMeshLocation, WORLD_WIDTH, WORLD_HEIGHT } from './MeshGeography'

export type MapAnnotationTarget = { field: 'meshMapLocations' | 'meshNetworkMapLocations'; key: string; label: string; local?: boolean }
export const annotationId = ({field, key}: MapAnnotationTarget) => JSON.stringify([field, key])

const locationFeedback: Record<MacMapLocationResult['state'], string> = {
  located: 'Location ready to save on this map.',
  denied: 'Check Location Services and allow AgentMux in macOS System Settings.',
  restricted: 'macOS restricts location access on this Mac.',
  unavailable: 'A location could not be read from this Mac.',
  timeout: 'This Mac did not provide a location in time.',
  busy: 'A location request is already in progress. Try again when it finishes.',
  'not-focused': 'Bring this AgentMux window to the front and try again.'
}

export function MeshLocationsPanel({ targets, locations, peerLocations, active, editing, onEdit }: {
  targets: readonly MapAnnotationTarget[]
  locations: MeshMapLocations | undefined
  peerLocations: MeshMapLocations | undefined
  active: boolean
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
  const request = useRef<symbol | undefined>(undefined)
  const latestValue = useRef(value)
  const saveTarget = useRef<string | undefined>(undefined)
  const [locationState, setLocationState] = useState<MacMapLocationResult['state'] | 'reading'>()
  useLayoutEffect(() => { latestValue.current = value }, [value])
  useLayoutEffect(() => {
    setLocationState(undefined)
    return () => { request.current = undefined }
  }, [active, current])
  const readLocation = active && editing?.local ? api.ui.requestMacMapLocation : undefined
  const feedback = locationState === 'reading' ? 'Finding this Mac’s location…'
    : locationState === 'located' && current && value === draft.expected[current] ? ''
      : locationState ? locationFeedback[locationState] : ''
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
    setCoordinates(hostId, `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`)
  }

  function setCoordinates(id: string, next: string) {
    request.current = undefined
    setLocationState(undefined)
    draft.setField(id, next)
  }

  async function useMacLocation() {
    if (!current || !readLocation || request.current) return
    const original = Symbol()
    request.current = original
    setLocationState('reading')
    const result = await readLocation().catch((): MacMapLocationResult => ({ state: 'unavailable' }))
    if (request.current !== original) return
    request.current = undefined
    if (value !== latestValue.current) {
      setLocationState(undefined)
      return
    }
    if (result.state === 'located') {
      draft.setField(current, `${result.latitude.toFixed(4)}, ${result.longitude.toFixed(4)}`)
    }
    setLocationState(result.state)
  }

  async function submit() {
    saveTarget.current = current
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
      {current ? <div className="mesh-locations-panel__coordinates">
        <label><span>Latitude, longitude</span><TextInput ref={coordinates} aria-label="Latitude, longitude" value={value}
          placeholder="Not set" onChange={event => setCoordinates(current, event.target.value)} /></label>
        {readLocation ? <div className="mesh-locations-panel__position">
          <Button type="button" disabled={locationState === 'reading'} onClick={() => void useMacLocation()}>Use this Mac’s location</Button>
          <span role="status">{feedback}</span>
        </div> : null}
      </div> : null}
    </div>
    {current ? <button className="mesh-location-picker" type="button" aria-label="Pick device location on the map" onClick={event => selectPosition(event, current)}>
      <MeshAtlas>{marker ? <circle className="mesh-geography__pin" cx={marker.x} cy={marker.y} r="7" /> : null}</MeshAtlas>
    </button> : null}
    <p>Pick a location on the map or enter latitude and longitude in decimal degrees. Clear the field to remove the pin.</p>
    <SettingsSaveBar save={save.state === 'saved' && saveTarget.current !== current ? { ...save, state: 'idle' } : save} dirty={draft.dirty} resolution={draft}
      blocked={invalid ? `Enter valid coordinates for ${invalid.label}.` : undefined}
      label="Save locations" onSave={() => void submit()} />
  </section>
}
