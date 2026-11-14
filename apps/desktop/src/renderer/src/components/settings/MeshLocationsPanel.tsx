import { useMemo } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import { Button } from '@agentmux/client-ui/components/Button'
import { SelectionField } from '../SelectionField'
import type { HostConfig } from '../../../../shared/contracts'
import { meshLocationValue, readMeshLocation, type MeshMapLocations } from '../../../../shared/mesh-map-locations'
import { saveConfigSlice } from './save-config-slice'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraftRecord } from './use-setting-draft'

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
  const invalid = hosts.find(host => {
    const point = draft.value[host.id]?.trim()
    return point && !readMeshLocation(point)
  })

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
      {current ? <label><span>Latitude, longitude</span><TextInput aria-label="Latitude, longitude" value={value}
        placeholder="Not set"
        onChange={event => draft.setField(current.id, event.target.value)} /></label> : null}
    </div>
    <p>Use decimal degrees, for example 45.0, -90.0. Clear the field to remove the pin.</p>
    <SettingsSaveBar save={save} dirty={draft.dirty} resolution={draft}
      blocked={invalid ? `Enter valid coordinates for ${invalid.label}.` : undefined}
      label="Save locations" onSave={() => void submit()} />
  </section>
}
